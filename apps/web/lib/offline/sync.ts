"use client";

import { allInspections, allOps, failOp, getPhotoBlob, photoUploaded, putInspection, removeOp, type LocalInspection, type QueuedOp } from "./db";

// Sends the outbox to the server, oldest first. Every request is idempotent on the
// server (keyed by ids the phone created), so sending something twice — after a timeout,
// a crash or a lost response — never records it twice.

export type SyncState =
  | { kind: "idle"; pending: number; failed: number }
  | { kind: "syncing"; pending: number; failed: number }
  | { kind: "offline"; pending: number; failed: number }
  | { kind: "signed_out"; pending: number; failed: number };

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
  constructor(readonly reason: "offline" | "signed_out" | "server") {
    super(reason);
  }
}

async function send(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new RetryLater("offline");
  }
  if (res.status === 401) throw new RetryLater("signed_out");
  if (res.status >= 500 || res.status === 429) throw new RetryLater("server");
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

async function runOp(op: QueuedOp, ops: QueuedOp[], inspections: Map<string, LocalInspection>) {
  const insp = inspections.get(op.inspectionClientId);
  if (!insp) return removeOp(op.seq);

  if (op.kind === "photo") {
    const photo = insp.photos.find((p) => p.clientId === op.photoClientId);
    const blob = await getPhotoBlob(op.photoClientId);
    if (!photo || !blob) return removeOp(op.seq);
    const headers: Record<string, string> = { "content-type": blob.contentType, "x-photo-key": photo.photoKey, "x-captured-at": photo.capturedAt };
    if (photo.lat !== null && photo.lng !== null) Object.assign(headers, { "x-lat": String(photo.lat), "x-lng": String(photo.lng) });
    const res = await send(`/api/inspections/${insp.clientId}/photos/${photo.clientId}`, { method: "PUT", headers, body: blob.blob });
    if (res.ok) {
      await photoUploaded(insp.jobId, photo.clientId);
      return removeOp(op.seq);
    }
    return failOp(op, await message(res));
  }

  const photosQueued = ops.some((o) => o.kind === "photo" && o.inspectionClientId === insp.clientId && o.seq !== op.seq && !o.failed);
  const res = await send("/api/inspections/sync", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload(insp, photosQueued)),
  });
  if (!res.ok) return failOp(op, await message(res));
  const server = (await res.json()) as { id: string; status: "draft" | "completed"; validationStatus: string; validationProblems: { key: string; message: string }[] };
  const updated: LocalInspection = {
    ...insp,
    server: { id: server.id, status: server.status, validationStatus: server.validationStatus, problems: server.validationProblems },
  };
  // The server found problems the phone did not (say, a template changed): reopen it.
  if (server.validationStatus === "invalid" && insp.status === "completed") Object.assign(updated, { status: "draft", completedAt: null });
  await putInspection(updated);
  inspections.set(insp.clientId, updated);
  return removeOp(op.seq);
}

async function drainOnce() {
  for (;;) {
    const ops = await allOps();
    const live = ops.filter((o) => !o.failed);
    const failed = ops.length - live.length;
    const next = live[0];
    if (!next) {
      emit({ kind: "idle", pending: 0, failed });
      return;
    }
    emit({ kind: "syncing", pending: live.length, failed });
    const inspections = new Map((await allInspections()).map((i) => [i.clientId, i]));
    try {
      await runOp(next, live, inspections);
    } catch (err) {
      if (err instanceof RetryLater) {
        emit({ kind: err.reason === "signed_out" ? "signed_out" : err.reason === "offline" ? "offline" : "idle", pending: live.length, failed });
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
