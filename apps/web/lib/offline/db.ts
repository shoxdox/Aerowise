"use client";

import type { InspectionValues, Stop } from "@aerowise/domain";

// Everything the technician app needs without signal lives in IndexedDB on the phone:
// the day's route, the template, inspections in progress, photos, and an outbox of
// changes waiting to reach the server.

export interface Gps {
  lat: number;
  lng: number;
  accuracyM?: number;
}

export interface LocalPhoto {
  clientId: string;
  photoKey: string;
  capturedAt: string;
  lat: number | null;
  lng: number | null;
  uploaded: boolean;
}

export interface LocalIssue {
  clientId: string;
  type: string;
  severity: string;
  description: string;
}

export interface LocalInspection {
  clientId: string;
  jobId: string;
  templateId: string;
  /** "completed" here means the technician finished it on the phone. */
  status: "draft" | "completed";
  arrivedAt: string;
  completedAt: string | null;
  arrivalGps: Gps | null;
  completionGps: Gps | null;
  accessIssue: string | null;
  values: InspectionValues;
  issues: LocalIssue[];
  photos: LocalPhoto[];
  /** What the server last said about it. */
  server: { id: string; status: "draft" | "completed"; validationStatus: string; problems: { key: string; message: string }[] } | null;
}

export interface PhotoBlob {
  clientId: string;
  inspectionClientId: string;
  blob: Blob;
  contentType: string;
}

export type OutboxOp =
  | { seq?: number; kind: "sync"; inspectionClientId: string; failed?: string }
  | { seq?: number; kind: "photo"; inspectionClientId: string; photoClientId: string; failed?: string };

export interface CachedRoute {
  date: string;
  items: Stop[];
  fetchedAt: string;
}

const DB_NAME = "aerowise-tech";
const DB_VERSION = 1;
type StoreName = "kv" | "inspections" | "photos" | "outbox";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("kv");
      db.createObjectStore("inspections", { keyPath: "jobId" });
      db.createObjectStore("photos", { keyPath: "clientId" });
      db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Runs `fn` in one transaction and resolves once it commits. */
export async function tx<T>(stores: StoreName[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await open();
  const t = db.transaction(stores, mode);
  const committed = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
  });
  const result = await fn(t);
  await committed;
  return result;
}

export const kvGet = <T>(key: string) => tx(["kv"], "readonly", (t) => done(t.objectStore("kv").get(key)) as Promise<T | undefined>);
export const kvSet = (key: string, value: unknown) => tx(["kv"], "readwrite", (t) => done(t.objectStore("kv").put(value, key)).then(() => undefined));

export const getInspection = (jobId: string) =>
  tx(["inspections"], "readonly", (t) => done(t.objectStore("inspections").get(jobId)) as Promise<LocalInspection | undefined>);
export const allInspections = () => tx(["inspections"], "readonly", (t) => done(t.objectStore("inspections").getAll()) as Promise<LocalInspection[]>);

export const getPhotoBlob = (clientId: string) =>
  tx(["photos"], "readonly", (t) => done(t.objectStore("photos").get(clientId)) as Promise<PhotoBlob | undefined>);

export type QueuedOp = OutboxOp & { seq: number };
export const allOps = () => tx(["outbox"], "readonly", (t) => done(t.objectStore("outbox").getAll()) as Promise<QueuedOp[]>);

/**
 * Saves the inspection and queues a sync in the same transaction, so a change on the
 * phone is never saved without also being queued for the server.
 */
export async function saveInspection(insp: LocalInspection, photo?: PhotoBlob) {
  await tx(["inspections", "photos", "outbox"], "readwrite", async (t) => {
    t.objectStore("inspections").put(insp);
    const outbox = t.objectStore("outbox");
    const ops = (await done(outbox.getAll())) as QueuedOp[];
    const mine = ops.filter((o) => o.inspectionClientId === insp.clientId && !o.failed);
    if (photo) {
      t.objectStore("photos").put(photo);
      outbox.add({ kind: "photo", inspectionClientId: insp.clientId, photoClientId: photo.clientId } satisfies OutboxOp);
    }
    // A queued sync sends the newest saved state when it runs, so one is enough as long
    // as it comes after this inspection's queued photos.
    const last = mine[mine.length - 1];
    if (photo || !last || last.kind !== "sync") outbox.add({ kind: "sync", inspectionClientId: insp.clientId } satisfies OutboxOp);
  });
}

export async function removeOp(seq: number) {
  await tx(["outbox"], "readwrite", (t) => done(t.objectStore("outbox").delete(seq)).then(() => undefined));
}

export async function failOp(op: QueuedOp, reason: string) {
  await tx(["outbox"], "readwrite", (t) => done(t.objectStore("outbox").put({ ...op, failed: reason })).then(() => undefined));
}

export async function putInspection(insp: LocalInspection) {
  await tx(["inspections"], "readwrite", (t) => done(t.objectStore("inspections").put(insp)).then(() => undefined));
}

/** Marks a photo uploaded and drops its image from the phone. */
export async function photoUploaded(jobId: string, photoClientId: string) {
  await tx(["inspections", "photos"], "readwrite", async (t) => {
    const insp = (await done(t.objectStore("inspections").get(jobId))) as LocalInspection | undefined;
    if (insp) {
      insp.photos = insp.photos.map((p) => (p.clientId === photoClientId ? { ...p, uploaded: true } : p));
      t.objectStore("inspections").put(insp);
    }
    t.objectStore("photos").delete(photoClientId);
  });
}
