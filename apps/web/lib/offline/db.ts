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

// Each company and person signed in on this phone gets a database of their own, so one
// sign-in never shows, sends or deletes another's route, inspections or photos.
export interface Tenant {
  organizationId: string;
  userId: string;
}

/** What this phone remembers about a sign-in whose data it holds, outside any one database. */
export interface KnownTenant extends Tenant {
  /** Saved before tenants had their own databases: that one keeps its old name. */
  dbName: string;
  organizationName: string;
  userName: string;
}

const LEGACY_DB_NAME = "aerowise-tech";
const DB_VERSION = 1;
const REGISTRY_KEY = "aerowise-tech:tenants";
const ACTIVE_KEY = "aerowise-tech:active";
const LEGACY_CHECKED_KEY = "aerowise-tech:legacy-checked";
type StoreName = "kv" | "inspections" | "photos" | "outbox";

export const sameTenant = (a: Tenant | null | undefined, b: Tenant | null | undefined) =>
  !!a && !!b && a.organizationId === b.organizationId && a.userId === b.userId;

const scopedName = (t: Tenant) => `aerowise-tech:${t.organizationId}:${t.userId}`;

function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full disk: the data itself is still in IndexedDB.
  }
}

export const knownTenants = (): KnownTenant[] => readJson<KnownTenant[]>(REGISTRY_KEY) ?? [];
const known = (t: Tenant) => knownTenants().find((k) => sameTenant(k, t));

/** Remembers a sign-in (and the names shown when its data is waiting on the phone). */
export function rememberTenant(t: Tenant, names: { organizationName: string; userName: string }): KnownTenant {
  const list = knownTenants();
  const existing = list.find((k) => sameTenant(k, t));
  const entry: KnownTenant = { organizationId: t.organizationId, userId: t.userId, dbName: existing?.dbName ?? scopedName(t), ...names };
  writeJson(REGISTRY_KEY, [...list.filter((k) => !sameTenant(k, t)), entry]);
  return entry;
}

/** The sign-in this phone last worked as; what it shows with no signal. */
export const lastActiveTenant = (): KnownTenant | undefined => {
  const t = readJson<Tenant>(ACTIVE_KEY);
  return t ? known(t) : undefined;
};

let active: KnownTenant | null = null;
const connections = new Map<string, Promise<IDBDatabase>>();

/** Every unqualified read and write below goes to this sign-in's database. */
export function activateTenant(t: Tenant) {
  const entry = known(t);
  if (!entry) throw new Error("activateTenant: unknown tenant");
  active = entry;
  writeJson(ACTIVE_KEY, { organizationId: t.organizationId, userId: t.userId });
  return entry;
}

export const activeTenant = (): KnownTenant | null => active;

function openDb(name: string): Promise<IDBDatabase> {
  let opening = connections.get(name);
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("kv");
        db.createObjectStore("inspections", { keyPath: "jobId" });
        db.createObjectStore("photos", { keyPath: "clientId" });
        db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
      };
      req.onsuccess = () => {
        // Another tab deleting this database (an ended demo) must not wait on us.
        req.result.onversionchange = () => {
          req.result.close();
          connections.delete(name);
        };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
    connections.set(name, opening);
    opening.catch(() => connections.delete(name));
  }
  return opening;
}

/** Opens a database only if it already exists; never creates one. */
function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

/**
 * A phone that saved data before sign-ins had their own databases: that database belongs to
 * whoever its saved "me" names, and keeps its name. Nothing in it is moved or dropped.
 */
export async function adoptLegacyStore() {
  if (readJson<boolean>(LEGACY_CHECKED_KEY)) return;
  const db = await openExisting(LEGACY_DB_NAME);
  if (db) {
    const me = await new Promise<{ user?: { id?: string; name?: string }; organization?: { id?: string; name?: string } } | undefined>((resolve) => {
      try {
        const req = db.transaction(["kv"], "readonly").objectStore("kv").get("me");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
    db.close();
    if (me?.user?.id && me.organization?.id) {
      const t = { organizationId: me.organization.id, userId: me.user.id };
      if (!known(t)) {
        writeJson(REGISTRY_KEY, [
          ...knownTenants(),
          { ...t, dbName: LEGACY_DB_NAME, organizationName: me.organization.name ?? "", userName: me.user.name ?? "" } satisfies KnownTenant,
        ]);
      }
      if (!readJson<Tenant>(ACTIVE_KEY)) writeJson(ACTIVE_KEY, t);
    }
  }
  writeJson(LEGACY_CHECKED_KEY, true);
}

/**
 * Deletes one sign-in's database from this phone. Only for data that can never be sent or
 * shown again: a demo company that has ended, or a sign-in with nothing waiting to send.
 */
export async function forgetTenant(t: Tenant) {
  const entry = known(t);
  writeJson(
    REGISTRY_KEY,
    knownTenants().filter((k) => !sameTenant(k, t)),
  );
  if (sameTenant(readJson<Tenant>(ACTIVE_KEY), t)) writeJson(ACTIVE_KEY, undefined);
  if (sameTenant(active, t)) active = null;
  if (!entry) return;
  const conn = connections.get(entry.dbName);
  connections.delete(entry.dbName);
  if (conn) (await conn.catch(() => null))?.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(entry.dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    // Another tab still has it open: it closes on versionchange, and the delete finishes then.
    req.onblocked = () => resolve();
  });
}

function requireActive(): KnownTenant {
  if (!active) throw new Error("No sign-in is active on this phone");
  return active;
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Runs `fn` in one transaction on one sign-in's database and resolves once it commits. */
async function txOn<T>(t: KnownTenant, stores: StoreName[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await openDb(t.dbName);
  const trx = db.transaction(stores, mode);
  const committed = new Promise<void>((resolve, reject) => {
    trx.oncomplete = () => resolve();
    trx.onerror = () => reject(trx.error);
    trx.onabort = () => reject(trx.error ?? new Error("transaction aborted"));
  });
  const result = await fn(trx);
  await committed;
  return result;
}

export type QueuedOp = OutboxOp & { seq: number };

/**
 * One sign-in's offline data. The outbox binds itself to the store it read from, so a
 * request sent for one sign-in never updates another's database, even if the phone
 * switches sign-ins while it is in flight.
 */
export function storeFor(t: KnownTenant) {
  const run = <T>(stores: StoreName[], mode: IDBTransactionMode, fn: (trx: IDBTransaction) => Promise<T> | T) => txOn(t, stores, mode, fn);
  return {
    tenant: t,
    kvGet: <T>(key: string) => run(["kv"], "readonly", (trx) => done(trx.objectStore("kv").get(key)) as Promise<T | undefined>),
    kvSet: (key: string, value: unknown) => run(["kv"], "readwrite", (trx) => done(trx.objectStore("kv").put(value, key)).then(() => undefined)),
    getInspection: (jobId: string) => run(["inspections"], "readonly", (trx) => done(trx.objectStore("inspections").get(jobId)) as Promise<LocalInspection | undefined>),
    allInspections: () => run(["inspections"], "readonly", (trx) => done(trx.objectStore("inspections").getAll()) as Promise<LocalInspection[]>),
    getPhotoBlob: (clientId: string) => run(["photos"], "readonly", (trx) => done(trx.objectStore("photos").get(clientId)) as Promise<PhotoBlob | undefined>),
    allOps: () => run(["outbox"], "readonly", (trx) => done(trx.objectStore("outbox").getAll()) as Promise<QueuedOp[]>),

    /**
     * Saves the inspection and queues a sync in the same transaction, so a change on the
     * phone is never saved without also being queued for the server.
     */
    saveInspection: (insp: LocalInspection, photo?: PhotoBlob) =>
      run(["inspections", "photos", "outbox"], "readwrite", async (trx) => {
        trx.objectStore("inspections").put(insp);
        const outbox = trx.objectStore("outbox");
        const ops = (await done(outbox.getAll())) as QueuedOp[];
        const mine = ops.filter((o) => o.inspectionClientId === insp.clientId && !o.failed);
        if (photo) {
          trx.objectStore("photos").put(photo);
          outbox.add({ kind: "photo", inspectionClientId: insp.clientId, photoClientId: photo.clientId } satisfies OutboxOp);
        }
        // A queued sync sends the newest saved state when it runs, so one is enough as long
        // as it comes after this inspection's queued photos.
        const last = mine[mine.length - 1];
        if (photo || !last || last.kind !== "sync") outbox.add({ kind: "sync", inspectionClientId: insp.clientId } satisfies OutboxOp);
      }),

    removeOp: (seq: number) => run(["outbox"], "readwrite", (trx) => done(trx.objectStore("outbox").delete(seq)).then(() => undefined)),
    failOp: (op: QueuedOp, reason: string) => run(["outbox"], "readwrite", (trx) => done(trx.objectStore("outbox").put({ ...op, failed: reason })).then(() => undefined)),
    putInspection: (insp: LocalInspection) => run(["inspections"], "readwrite", (trx) => done(trx.objectStore("inspections").put(insp)).then(() => undefined)),

    /** Marks a photo uploaded and drops its image from the phone. */
    photoUploaded: (jobId: string, photoClientId: string) =>
      run(["inspections", "photos"], "readwrite", async (trx) => {
        const insp = (await done(trx.objectStore("inspections").get(jobId))) as LocalInspection | undefined;
        if (insp) {
          insp.photos = insp.photos.map((p) => (p.clientId === photoClientId ? { ...p, uploaded: true } : p));
          trx.objectStore("inspections").put(insp);
        }
        trx.objectStore("photos").delete(photoClientId);
      }),
  };
}

export type TenantStore = ReturnType<typeof storeFor>;

/** The active sign-in's store. */
export const activeStore = () => storeFor(requireActive());

/** Another sign-in's queued changes, read without making it active; empty if it has no database. */
export async function pendingFor(t: KnownTenant): Promise<number> {
  const db = await openExisting(t.dbName);
  if (!db) return 0;
  try {
    if (!db.objectStoreNames.contains("outbox")) return 0;
    return await done(db.transaction(["outbox"], "readonly").objectStore("outbox").count());
  } finally {
    db.close();
  }
}

export const kvGet = <T>(key: string) => activeStore().kvGet<T>(key);
export const kvSet = (key: string, value: unknown) => activeStore().kvSet(key, value);
export const allInspections = () => activeStore().allInspections();
export const allOps = () => activeStore().allOps();
export const saveInspection = (insp: LocalInspection, photo?: PhotoBlob) => activeStore().saveInspection(insp, photo);
