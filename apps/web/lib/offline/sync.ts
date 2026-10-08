"use client";

import { activeTenant, isKnownOp, sameTenant, storeFor, type LocalInspection, type QueuedOp, type StoredOp, type Tenant, type TenantStore } from "./db";
import { workStoreFor, type LocalWork, type QueuedWorkOp, type WorkStore } from "./work";

// Sends the outbox to the server, oldest first. Every request is idempotent on the
// server (keyed by ids the phone created), so sending something twice — after a timeout,
// a crash or a lost response — never records it twice.
//
// Every request names the sign-in whose outbox it comes from (TENANT_HEADER). The server
// refuses it if the phone's session now belongs to someone else, so one company's queued
// work is never sent under another's sign-in; it waits until that person signs in again.

export const TENANT_HEADER = "x-aerowise-tenant";
export const tenantHeader = (t: Tenant) => ({ [TENANT_HEADER]: `${t.organizationId}:${t.userId}` });

/**
 * `pending`: changes this version sends. `waiting`: changes a later app version saved that this
 * one cannot send; they stay on the phone, untouched, until the app updates.
 */
type Counts = { pending: number; failed: number; waiting?: number };

export type SyncState = Counts &
  (
    | { kind: "idle" }
    | { kind: "syncing" }
    | { kind: "offline" }
    | { kind: "signed_out" }
    /** The phone is now signed in as someone else: this sign-in's changes wait on the phone. */
    | { kind: "other_account" }
    /** The company's Aerowise plan has lapsed: changes wait on the phone until it is reactivated. */
    | { kind: "read_only" }
  );

/**
 * Splits the outbox, oldest first, into what this version can send now and what waits for a
 * later one. An op of a kind this version does not know holds back the later ops of the same
 * record, so one record's changes never reach the server out of order.
 */
export function runnableOps(ops: StoredOp[]): { runnable: QueuedOp[]; waiting: number; failed: number } {
  const held = new Set<string>();
  const runnable: QueuedOp[] = [];
  let waiting = 0;
  let failed = 0;
  for (const op of ops) {
    if (op.failed) failed++;
    else if (!isKnownOp(op)) {
      waiting++;
      if (op.inspectionClientId) held.add(op.inspectionClientId);
    } else if (held.has(op.inspectionClientId)) waiting++;
    else runnable.push(op);
  }
  return { runnable, waiting, failed };
}

type Listener = (s: SyncState) => void;
const listeners = new Set<Listener>();
let state: SyncState = { kind: "idle", pending: 0, failed: 0 };
let running: Promise<void> | null = null;
let again = false;

export function subscribe(fn: Listener) {
  listeners.add(fn);
  fn(state);
  return () => void listeners.delete(fn);
}

const emit = (s: SyncState) => {
  state = s;
  for (const fn of listeners) fn(s);
};

/** Thrown when the request never got a usable answer; the op stays queued. */
class RetryLater extends Error {
  constructor(readonly reason: "offline" | "signed_out" | "server" | "read_only" | "other_account") {
    super(reason);
  }
}

const errorCode = async (res: Response) => ((await res.clone().json().catch(() => ({}))) as { error?: string }).error;

async function send(store: { tenant: Tenant }, url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...init.headers, ...tenantHeader(store.tenant) }, credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new RetryLater("offline");
  }
  if (res.status === 401) throw new RetryLater("signed_out");
  if (res.status === 409 && (await errorCode(res)) === "tenant_mismatch") throw new RetryLater("other_account");
  if (res.status >= 500 || res.status === 429) throw new RetryLater("server");
  // Not the inspection's fault, so never marked failed: it sends once the account is reactivated.
  if (res.status === 403 && (await errorCode(res)) === "organization_read_only") {
    throw new RetryLater("read_only");
  }
  return res;
}

const message = async (res: Response) => ((await res.json().catch(() => ({}))) as { message?: string }).message ?? `Error ${res.status}`;

function payload(insp: LocalInspection, photosQueued: boolean) {
  return {
    clientId: insp.clientId,
    jobId: insp.jobId,
    templateId: insp.templateId,
    // Completing waits until this inspection's photos are up, so the server's
    // validation sees them.
    status: insp.status === "completed" && !photosQueued ? "completed" : "draft",
    arrivedAt: insp.arrivedAt,
    completedAt: insp.completedAt,
    arrivalGps: insp.arrivalGps,
    completionGps: insp.completionGps,
    accessIssue: insp.accessIssue,
    values: insp.values,
    issues: insp.issues,
  };
}

async function runOp(store: TenantStore, op: QueuedOp, ops: QueuedOp[], inspections: Map<string, LocalInspection>) {
  const { removeOp, failOp, getPhotoBlob, photoUploaded, acknowledgeSync } = store;
  const insp = inspections.get(op.inspectionClientId);
  if (!insp) return removeOp(op.seq);

  if (op.kind === "photo") {
    const photo = insp.photos.find((p) => p.clientId === op.photoClientId);
    const blob = await getPhotoBlob(op.photoClientId);
    if (!photo || !blob) return removeOp(op.seq);
    const headers: Record<string, string> = { "content-type": blob.contentType, "x-photo-key": photo.photoKey, "x-captured-at": photo.capturedAt };
    if (photo.lat !== null && photo.lng !== null) Object.assign(headers, { "x-lat": String(photo.lat), "x-lng": String(photo.lng) });
    const res = await send(store, `/api/inspections/${insp.clientId}/photos/${photo.clientId}`, { method: "PUT", headers, body: blob.blob });
    if (res.ok) {
      await photoUploaded(insp.jobId, photo.clientId);
      return removeOp(op.seq);
    }
    return failOp(op, await message(res));
  }

  const photosQueued = ops.some((o) => o.kind === "photo" && o.inspectionClientId === insp.clientId && o.seq !== op.seq && !o.failed);
  const res = await send(store, "/api/inspections/sync", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload(insp, photosQueued)),
  });
  if (!res.ok) return failOp(op, await message(res));
  const server = (await res.json()) as { id: string; status: "draft" | "completed"; validationStatus: string; validationProblems: { key: string; message: string }[] };
  await acknowledgeSync(op, insp, { id: server.id, status: server.status, validationStatus: server.validationStatus, problems: server.validationProblems }, insp.status === "completed" && !photosQueued);
}

// ---- Work visits (SW-2), from the separate work database ----

function workPayload(rec: LocalWork, othersQueued: boolean) {
  return {
    clientId: rec.clientId,
    jobId: rec.jobId,
    templateId: rec.templateId,
    revision: rec.revision,
    // Completing waits until the record's photos and signatures are up, so the server's checks see them.
    status: rec.status === "completed" && !othersQueued ? "completed" : "draft",
    arrivedAt: rec.arrivedAt,
    completedAt: rec.completedAt,
    arrivalGps: rec.arrivalGps,
    completionGps: rec.completionGps,
    values: rec.values,
    summary: rec.summary,
    finalVisit: rec.finalVisit,
    // SW-6: only when recorded, so a record from before pumping sends exactly what it did.
    ...(rec.pumpOut && rec.pumpOut.volume > 0 ? { pumpOut: rec.pumpOut } : {}),
  };
}

type Resolved = { outcome: "resolved"; conflictId: string; resolution: "attached" | "dismissed" };
type Held = { outcome: "held_for_review"; conflictId: string; reason: "reassigned" | "cancelled" | "office_completed" };

/** As send; field work switched off on the server for now is not the record's fault, so it waits on the phone. */
async function sendWork(store: WorkStore, url: string, init: RequestInit & { headers?: Record<string, string> }) {
  const res = await send(store, url, init);
  if (res.status === 409 && (await errorCode(res)) === "feature_off") throw new RetryLater("server");
  return res;
}

/**
 * SW-6: a load, then each of its manifest photos. Every answer the server gives a delivered load
 * carries its group id: the load as it stands, or, once the office has put another technician's
 * pump-out in it, only an acknowledgment. Either way the phone's copy is done.
 */
async function runLoadOp(store: WorkStore, op: QueuedWorkOp & { kind: "disposal-load" | "disposal-photo" }) {
  const load = (await store.allLoads()).find((l) => l.clientId === op.recordClientId);
  if (!load) return store.removeOp(op.seq);
  let res: Response;
  if (op.kind === "disposal-load") {
    const body = {
      clientId: load.clientId,
      vehicleId: load.vehicleId,
      facilityId: load.facilityId,
      deliveredOn: load.deliveredOn,
      manifestReference: load.manifestReference,
      total: load.total,
      unit: load.unit,
      notes: load.notes,
      pumpingGroupIds: load.pumpingGroupIds,
    };
    res = await sendWork(store, "/api/disposal/loads/sync", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } else {
    const photo = load.photos.find((p) => p.clientId === op.photoClientId);
    const blob = await store.getBlob(op.photoClientId);
    if (!photo || !blob) return store.removeOp(op.seq);
    res = await sendWork(store, `/api/disposal/loads/${load.clientId}/photos/${photo.clientId}`, {
      method: "PUT",
      headers: { "content-type": blob.contentType, "x-photo-key": "manifest", "x-captured-at": photo.capturedAt },
      body: blob.blob,
    });
  }
  if (!res.ok) return store.failOp(op, await message(res));
  // A load (or its acknowledgment) names its group; a delivered photo answers with the photo,
  // which does not, so the group the load already has is kept.
  const out = (await res.json()) as { groupId?: string };
  return store.loadDelivered(op, typeof out.groupId === "string" ? out.groupId : null);
}

async function runWorkOp(store: WorkStore, op: QueuedWorkOp, ops: QueuedWorkOp[], records: Map<string, LocalWork>) {
  if (op.kind === "disposal-load" || op.kind === "disposal-photo") return runLoadOp(store, op);
  const rec = records.get(op.recordClientId);
  if (!rec) return store.removeOp(op.seq);

  if (op.kind === "work-sync") {
    const othersQueued = ops.some((o) => o.recordClientId === rec.clientId && o.seq !== op.seq);
    const body = workPayload(rec, othersQueued);
    const res = await sendWork(store, "/api/work/sync", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return store.failOp(op, await message(res));
    const out = (await res.json()) as Held | Resolved | { id: string; status: "draft" | "completed"; validationStatus: string; validationProblems: { key: string; message: string }[] };
    if ("outcome" in out && out.outcome === "held_for_review") return store.acknowledgeSync(op, rec, { kind: "held", held: { conflictId: out.conflictId, reason: out.reason } });
    if ("outcome" in out) return store.acknowledgeSync(op, rec, { kind: "resolved", resolved: { conflictId: out.conflictId, resolution: out.resolution } });
    return store.acknowledgeSync(op, rec, {
      kind: "record",
      server: { id: out.id, status: out.status, validationStatus: out.validationStatus, problems: out.validationProblems },
      completedSent: body.status === "completed",
    });
  }

  let res: Response;
  if (op.kind === "work-photo") {
    const photo = rec.photos.find((p) => p.clientId === op.photoClientId);
    const blob = await store.getBlob(op.photoClientId);
    if (!photo || !blob) return store.removeOp(op.seq);
    const headers: Record<string, string> = { "content-type": blob.contentType, "x-photo-key": photo.photoKey, "x-captured-at": photo.capturedAt };
    if (photo.lat !== null && photo.lng !== null) Object.assign(headers, { "x-lat": String(photo.lat), "x-lng": String(photo.lng) });
    res = await sendWork(store, `/api/work/${rec.clientId}/photos/${photo.clientId}`, { method: "PUT", headers, body: blob.blob });
  } else {
    const sig = rec.signatures.find((s) => s.clientId === op.signatureClientId);
    if (!sig || !rec.summary) return store.removeOp(op.seq);
    res = await sendWork(store, `/api/work/${rec.clientId}/signatures/${sig.clientId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirementKey: sig.requirementKey,
        signerName: sig.signerName,
        capture: sig.capture,
        summary: rec.summary,
        summarySha256: sig.summarySha256,
        consentText: sig.consentText,
        signedAt: sig.signedAt,
      }),
    });
  }
  // 202 (held for the office) and an office decision both mean the server has it.
  if (!res.ok) return store.failOp(op, await message(res));
  const out = (await res.json()) as Partial<Resolved>;
  const resolved = out.outcome === "resolved" ? { conflictId: out.conflictId!, resolution: out.resolution! } : undefined;
  await store.uploaded(rec.clientId, op.kind === "work-photo" ? { photoClientId: op.photoClientId } : { signatureClientId: op.signatureClientId }, resolved);
  return store.removeOp(op.seq);
}

async function drainOnce() {
  const tenant = activeTenant();
  if (!tenant) {
    emit({ kind: "idle", pending: 0, failed: 0 });
    return;
  }
  const store = storeFor(tenant);
  const work = workStoreFor(tenant);
  for (;;) {
    // Signed in as someone else since this pass began: the next pass sends theirs.
    if (!sameTenant(activeTenant(), tenant)) return;
    const inspections = runnableOps(await store.allOps());
    const visits = await work.queue();
    const counts = {
      pending: inspections.runnable.length + visits.runnable.length,
      failed: inspections.failed + visits.failed,
      waiting: inspections.waiting + visits.waiting,
    };
    const next = inspections.runnable[0];
    const nextWork = visits.runnable[0];
    if (!next && !nextWork) {
      emit({ kind: "idle", ...counts });
      return;
    }
    emit({ kind: "syncing", ...counts });
    try {
      if (next) await runOp(store, next, inspections.runnable, new Map((await store.allInspections()).map((i) => [i.clientId, i])));
      else await runWorkOp(work, nextWork!, visits.runnable, new Map((await work.allRecords()).map((r) => [r.clientId, r])));
    } catch (err) {
      if (err instanceof RetryLater) {
        const kind = err.reason === "server" ? "idle" : err.reason;
        emit({ kind, ...counts });
        return;
      }
      throw err;
    }
  }
}

/** What is still to send for the active sign-in: `unsent` this version sends; `later` waits for an update. */
export async function unsentFor(t: Parameters<typeof storeFor>[0]) {
  const inspections = runnableOps(await storeFor(t).allOps());
  const visits = await workStoreFor(t).queue();
  return { unsent: inspections.runnable.length + visits.runnable.length, later: inspections.waiting + visits.waiting };
}

/** Starts sending queued changes; safe to call as often as you like. */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  const work = async () => {
    do {
      again = false;
      // One tab at a time sends the outbox.
      if (navigator.locks) await navigator.locks.request("aerowise-outbox", drainOnce);
      else await drainOnce();
    } while (again);
  };
  running = work().finally(() => {
    running = null;
  });
  return running;
}

let started = false;
/** Retries when the phone comes back online, and every 20 seconds while anything is queued. */
export function startBackgroundSync() {
  if (started) return;
  started = true;
  window.addEventListener("online", () => void syncNow());
  setInterval(() => {
    if (state.pending > 0) void syncNow();
  }, 20_000);
  void syncNow();
}
