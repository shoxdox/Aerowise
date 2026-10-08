"use client";

import type { InspectionValues, SignatureCapture } from "@aerowise/domain";
import { done, openDb, openExisting, unfail, workDbName, WORK_OUTBOX_STORE, type Gps, type KnownTenant, type StoreSpecs } from "./db";

// Work visits on the phone (SW-2): the technician's work stops, the field record for each, its
// photos and the customer's signature, and an outbox of changes waiting for the server. All of it
// lives in its own database (workDbName), so the inspection database and its version never change
// for it, and the phone rollback floor (SW-2a) can still open, count and keep everything here.
//
// Each record is sent whole and idempotently (PUT /work/sync, keyed by the record's client id);
// photos and signatures follow it, each keyed by its own client id.

export interface WorkPhotoLocal {
  clientId: string;
  photoKey: string;
  capturedAt: string;
  lat: number | null;
  lng: number | null;
  uploaded: boolean;
}

export interface WorkSignatureLocal {
  clientId: string;
  requirementKey: string;
  signerName: string;
  capture: SignatureCapture;
  /** The sha256 of the summary the customer was shown (record.summary). */
  summarySha256: string;
  consentText: string;
  signedAt: string;
  uploaded: boolean;
}

export interface LocalWork {
  clientId: string;
  jobId: string;
  templateId: string;
  /** The visit as listed when the work started, shown after it leaves the technician's route. */
  label?: { title: string; customerName: string; address: string };
  /** "completed" here means the technician finished it on the phone. */
  status: "draft" | "completed";
  /** Incremented on each local edit, so an older sync cannot consume a newer edit. */
  revision: number;
  arrivedAt: string;
  completedAt: string | null;
  arrivalGps: Gps | null;
  completionGps: Gps | null;
  values: InspectionValues;
  /** False when another visit is needed. */
  finalVisit: boolean;
  /** What the customer was shown when signing; fixed once signed. */
  summary: Record<string, unknown> | null;
  photos: WorkPhotoLocal[];
  signatures: WorkSignatureLocal[];
  /** When the server first had this record; photos and signatures can only go after it. */
  draftAckedAt: string | null;
  /** What the server last said about the record. */
  server: { id: string; status: "draft" | "completed"; validationStatus: string; problems: { key: string; message: string }[] } | null;
  /** The visit changed while the phone was offline: the office decides what happens to it. */
  held: { conflictId: string; reason: "reassigned" | "cancelled" | "office_completed" } | null;
  /** What the office decided about a held record. */
  resolved: { conflictId: string; resolution: "attached" | "dismissed" } | null;
}

export interface WorkBlob {
  clientId: string;
  recordClientId: string;
  blob: Blob;
  contentType: string;
}

export type WorkOp =
  | { seq?: number; kind: "work-sync"; recordClientId: string; failed?: string }
  | { seq?: number; kind: "work-photo"; recordClientId: string; photoClientId: string; failed?: string }
  | { seq?: number; kind: "work-signature"; recordClientId: string; signatureClientId: string; failed?: string };
export type QueuedWorkOp = WorkOp & { seq: number };

/** Anything in the work outbox, including ops a later app version queued that this one cannot send. */
export type StoredWorkOp = { seq: number; kind: string; recordClientId?: string; failed?: string };
const KNOWN_KINDS: ReadonlySet<string> = new Set<WorkOp["kind"]>(["work-sync", "work-photo", "work-signature"]);
const isKnown = (op: StoredWorkOp): op is QueuedWorkOp =>
  KNOWN_KINDS.has(op.kind) &&
  typeof op.recordClientId === "string" &&
  (op.kind !== "work-photo" || typeof (op as { photoClientId?: unknown }).photoClientId === "string") &&
  (op.kind !== "work-signature" || typeof (op as { signatureClientId?: unknown }).signatureClientId === "string");

/**
 * Splits the work outbox, oldest first, into what this version sends now and what waits for a
 * later one. An op this version does not know holds back the later ops of the same record, so one
 * record's changes never reach the server out of order; it is never run, failed or deleted.
 */
export function runnableWorkOps(ops: StoredWorkOp[]): { runnable: QueuedWorkOp[]; waiting: number; failed: number } {
  const held = new Set<string>();
  const runnable: QueuedWorkOp[] = [];
  let waiting = 0;
  let failed = 0;
  for (const op of ops) {
    if (op.failed) failed++;
    else if (!isKnown(op)) {
      waiting++;
      if (op.recordClientId) held.add(op.recordClientId);
    } else if (held.has(op.recordClientId)) waiting++;
    else runnable.push(op);
  }
  return { runnable, waiting, failed };
}

/**
 * The form's copy of a record with what sending has since recorded on the phone's copy: the
 * photos and signatures that reached the server, the server's answer, and the office's hold or
 * decision. The form only edits the record, so its older copy of these must never undo them.
 */
export function withSentState(form: LocalWork, stored: LocalWork | undefined): LocalWork {
  if (!stored) return form;
  const photos = new Set(stored.photos.filter((p) => p.uploaded).map((p) => p.clientId));
  const signatures = new Set(stored.signatures.filter((s) => s.uploaded).map((s) => s.clientId));
  return {
    ...form,
    server: stored.server,
    draftAckedAt: stored.draftAckedAt,
    held: stored.held,
    resolved: stored.resolved,
    photos: form.photos.map((p) => (photos.has(p.clientId) && !p.uploaded ? { ...p, uploaded: true } : p)),
    signatures: form.signatures.map((s) => (signatures.has(s.clientId) && !s.uploaded ? { ...s, uploaded: true } : s)),
  };
}

/**
 * Photos and signatures of a record the server has as completed that the phone still lists as
 * not sent, with nothing queued for them. The phone completes a record only once its uploads
 * have gone, so the server's completion is their delivery receipt; an upload still queued, or
 * turned down, keeps its own op and stays not sent.
 */
function deliveredUnmarked(rec: LocalWork, ops: StoredWorkOp[]): { photos: Set<string>; signatures: Set<string> } {
  const photos = new Set<string>();
  const signatures = new Set<string>();
  if (rec.server?.status !== "completed") return { photos, signatures };
  const queued = new Set(
    ops.flatMap((o) => {
      const op = o as { photoClientId?: unknown; signatureClientId?: unknown };
      return [op.photoClientId, op.signatureClientId].filter((x): x is string => typeof x === "string");
    }),
  );
  for (const p of rec.photos) if (!p.uploaded && !queued.has(p.clientId)) photos.add(p.clientId);
  for (const s of rec.signatures) if (!s.uploaded && !queued.has(s.clientId)) signatures.add(s.clientId);
  return { photos, signatures };
}

const STORES: StoreSpecs = {
  kv: undefined,
  records: { keyPath: "clientId" },
  blobs: { keyPath: "clientId" },
  [WORK_OUTBOX_STORE]: { keyPath: "seq", autoIncrement: true },
};
type StoreName = "kv" | "records" | "blobs" | "outbox";

/** The ops waiting in a sign-in's work outbox; reading never creates or upgrades the database. */
async function readOps(t: KnownTenant): Promise<StoredWorkOp[]> {
  const db = await openExisting(workDbName(t));
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains(WORK_OUTBOX_STORE)) return [];
    return (await done(db.transaction([WORK_OUTBOX_STORE], "readonly").objectStore(WORK_OUTBOX_STORE).getAll())) as StoredWorkOp[];
  } finally {
    db.close();
  }
}

/** Reads one store without creating the database; empty when the phone has none. */
async function readAll<T>(t: KnownTenant, store: StoreName): Promise<T[]> {
  const db = await openExisting(workDbName(t));
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains(store)) return [];
    return (await done(db.transaction([store], "readonly").objectStore(store).getAll())) as T[];
  } finally {
    db.close();
  }
}

/** Runs `fn` in one transaction on the sign-in's work database (created if need be) and resolves once it commits. */
async function tx<T>(t: KnownTenant, stores: StoreName[], mode: IDBTransactionMode, fn: (trx: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await openDb(workDbName(t), STORES);
  const trx = db.transaction(stores, mode);
  const committed = new Promise<void>((resolve, reject) => {
    trx.oncomplete = () => resolve();
    // The failed request's error (a full phone's QuotaExceededError): the transaction's own is set only once it aborts.
    trx.onerror = (e) => reject((e.target as IDBRequest | null)?.error ?? trx.error);
    trx.onabort = () => reject(trx.error ?? new Error("transaction aborted"));
  });
  let result: T;
  try {
    result = await fn(trx);
  } catch (err) {
    // Nothing of a save that failed partway is kept: the whole transaction is undone.
    committed.catch(() => {});
    try {
      trx.abort();
    } catch {
      // Already finished or aborted.
    }
    throw err;
  }
  await committed;
  return result;
}

/** Queues a sync after the record's other queued ops, unless one is already last. */
async function queueSync(outbox: IDBObjectStore, recordClientId: string) {
  const ops = (await done(outbox.getAll())) as StoredWorkOp[];
  const last = ops.filter((o) => o.recordClientId === recordClientId && !o.failed).at(-1);
  if (!last || last.kind !== "work-sync") outbox.add({ kind: "work-sync", recordClientId } satisfies WorkOp);
}

export type SyncAnswer =
  | { kind: "record"; server: NonNullable<LocalWork["server"]>; completedSent: boolean }
  | { kind: "held"; held: NonNullable<LocalWork["held"]> }
  | { kind: "resolved"; resolved: NonNullable<LocalWork["resolved"]> };

/**
 * One sign-in's work on this phone. Bound to its tenant, so a request in flight for one sign-in
 * never updates another's database.
 */
export function workStoreFor(t: KnownTenant) {
  const run = <T>(stores: StoreName[], mode: IDBTransactionMode, fn: (trx: IDBTransaction) => Promise<T> | T) => tx(t, stores, mode, fn);
  return {
    tenant: t,
    /** Cached data (the work route, forms). Reading never creates the database. */
    kvGet: async <T>(key: string): Promise<T | undefined> => {
      const db = await openExisting(workDbName(t));
      if (!db) return undefined;
      try {
        if (!db.objectStoreNames.contains("kv")) return undefined;
        return (await done(db.transaction(["kv"], "readonly").objectStore("kv").get(key))) as T | undefined;
      } finally {
        db.close();
      }
    },
    kvSet: (key: string, value: unknown) => run(["kv"], "readwrite", (trx) => done(trx.objectStore("kv").put(value, key)).then(() => undefined)),
    allRecords: () => readAll<LocalWork>(t, "records"),
    getBlob: (clientId: string) => run(["blobs"], "readonly", (trx) => done(trx.objectStore("blobs").get(clientId)) as Promise<WorkBlob | undefined>),
    allOps: () => readOps(t),
    /** What is queued, split into what this version sends and what waits for a later one. */
    queue: async () => runnableWorkOps(await readOps(t)),

    /**
     * Saves the record and queues what has to reach the server, in one transaction, so a change
     * is never saved without being queued: a new photo, new signatures, then the record itself.
     */
    saveWork: (rec: LocalWork, extra: { photo?: WorkBlob; signatureClientIds?: string[] } = {}) =>
      run(["records", "blobs", "outbox"], "readwrite", async (trx) => {
        const records = trx.objectStore("records");
        const existing = (await done(records.get(rec.clientId))) as LocalWork | undefined;
        records.put({ ...withSentState(rec, existing), revision: (existing?.revision ?? 0) + 1 });
        const outbox = trx.objectStore("outbox");
        if (extra.photo) {
          trx.objectStore("blobs").put(extra.photo);
          outbox.add({ kind: "work-photo", recordClientId: rec.clientId, photoClientId: extra.photo.clientId } satisfies WorkOp);
        }
        for (const signatureClientId of extra.signatureClientIds ?? []) outbox.add({ kind: "work-signature", recordClientId: rec.clientId, signatureClientId } satisfies WorkOp);
        await queueSync(outbox, rec.clientId);
      }),

    /**
     * Marks as sent what the server's completion shows was delivered but the phone still lists as
     * not sent (an earlier version could save a form's older copy over the sent marks). Returns
     * how many it marked; changes nothing else, and never touches the outbox.
     */
    reconcileSent: async () => {
      const [records, ops] = await Promise.all([readAll<LocalWork>(t, "records"), readOps(t)]);
      const unmarked = (r: LocalWork, queued: StoredWorkOp[]) => {
        const d = deliveredUnmarked(r, queued);
        return d.photos.size + d.signatures.size;
      };
      if (!records.some((r) => unmarked(r, ops) > 0)) return 0;
      return run(["records", "outbox"], "readwrite", async (trx) => {
        const store = trx.objectStore("records");
        const queued = (await done(trx.objectStore("outbox").getAll())) as StoredWorkOp[];
        let marked = 0;
        for (const rec of (await done(store.getAll())) as LocalWork[]) {
          if (unmarked(rec, queued) === 0) continue;
          const d = deliveredUnmarked(rec, queued);
          marked += d.photos.size + d.signatures.size;
          store.put({
            ...rec,
            photos: rec.photos.map((p) => (d.photos.has(p.clientId) ? { ...p, uploaded: true } : p)),
            signatures: rec.signatures.map((s) => (d.signatures.has(s.clientId) ? { ...s, uploaded: true } : s)),
          });
        }
        return marked;
      });
    },

    removeOp: (seq: number) => run(["outbox"], "readwrite", (trx) => done(trx.objectStore("outbox").delete(seq)).then(() => undefined)),
    failOp: (op: QueuedWorkOp, reason: string) => run(["outbox"], "readwrite", (trx) => done(trx.objectStore("outbox").put({ ...op, failed: reason })).then(() => undefined)),
    /** Puts changes the server turned down back in line to send, in their places; nothing is deleted. */
    retryFailed: async () => ((await readOps(t)).some((o) => o.failed) ? run(["outbox"], "readwrite", (trx) => unfail(trx.objectStore("outbox"))) : 0),

    /** Records what the server answered to a sync, and queues another if the record changed meanwhile. */
    acknowledgeSync: (op: QueuedWorkOp, sent: LocalWork, answer: SyncAnswer) =>
      run(["records", "outbox"], "readwrite", async (trx) => {
        const records = trx.objectStore("records");
        const outbox = trx.objectStore("outbox");
        outbox.delete(op.seq);
        const latest = (await done(records.get(sent.clientId))) as LocalWork | undefined;
        if (!latest) return;
        const unchanged = latest.revision === sent.revision;
        const updated: LocalWork = { ...latest, draftAckedAt: latest.draftAckedAt ?? new Date().toISOString() };
        if (answer.kind === "record") {
          updated.server = answer.server;
          // The server found something missing at completion: back to a draft the technician can fix.
          if (unchanged && answer.completedSent && answer.server.validationStatus === "invalid") Object.assign(updated, { status: "draft", completedAt: null });
        } else if (answer.kind === "held") updated.held = answer.held;
        else updated.resolved = answer.resolved;
        records.put(updated);
        // Changed since it was sent: send the newest. Once the office decided, nothing more goes.
        if (!unchanged && answer.kind !== "resolved") await queueSync(outbox, sent.clientId);
      }),

    /** Marks an upload delivered and drops a photo's image from the phone. */
    uploaded: (recordClientId: string, upload: { photoClientId: string } | { signatureClientId: string }, resolved?: LocalWork["resolved"]) =>
      run(["records", "blobs"], "readwrite", async (trx) => {
        const records = trx.objectStore("records");
        const rec = (await done(records.get(recordClientId))) as LocalWork | undefined;
        if (rec) {
          if ("photoClientId" in upload) rec.photos = rec.photos.map((p) => (p.clientId === upload.photoClientId ? { ...p, uploaded: true } : p));
          else rec.signatures = rec.signatures.map((s) => (s.clientId === upload.signatureClientId ? { ...s, uploaded: true } : s));
          if (resolved) rec.resolved = resolved;
          records.put(rec);
        }
        if ("photoClientId" in upload) trx.objectStore("blobs").delete(upload.photoClientId);
      }),
  };
}

export type WorkStore = ReturnType<typeof workStoreFor>;
