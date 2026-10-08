"use client";

import { activeTenant, isKnownOp, sameTenant, storeFor, type LocalInspection, type QueuedOp, type StoredOp, type Tenant, type TenantStore } from "./db";

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

async function send(store: TenantStore, url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
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

async function drainOnce() {
  const tenant = activeTenant();
  if (!tenant) {
    emit({ kind: "idle", pending: 0, failed: 0 });
    return;
  }
  const store = storeFor(tenant);
  const work = await store.pendingWork();
  for (;;) {
    // Signed in as someone else since this pass began: the next pass sends theirs.
    if (!sameTenant(activeTenant(), tenant)) return;
    const { runnable: live, waiting, failed } = runnableOps(await store.allOps());
    const counts = { pending: live.length, failed, waiting: waiting + work };
    const next = live[0];
    if (!next) {
      emit({ kind: "idle", ...counts });
      return;
    }
    emit({ kind: "syncing", ...counts });
    const inspections = new Map((await store.allInspections()).map((i) => [i.clientId, i]));
    try {
      await runOp(store, next, live, inspections);
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
