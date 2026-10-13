import { afterEach, describe, expect, it, vi } from "vitest";
// Load the actual browser wrappers at runtime without adding DOM globals to the Node API compilation.
const inspectionModule = new URL("../../web/lib/offline/db.ts", import.meta.url).pathname;
const workModule = new URL("../../web/lib/offline/work.ts", import.meta.url).pathname;
const { storeFor, withSentState } = await import(inspectionModule);
const { workStoreFor } = await import(workModule);
type KnownTenant = { organizationId: string; userId: string; dbName: string; organizationName: string; userName: string };

const tenant = (): KnownTenant => ({ organizationId: crypto.randomUUID(), userId: crypto.randomUUID(), dbName: `test-${crypto.randomUUID()}`, organizationName: "Fictional lifecycle", userName: "Fictional technician" });
function registry(t?: KnownTenant) {
  const entries = new Map<string, string>(t ? [["aerowise-tech:tenants", JSON.stringify([t])]] : []);
  vi.stubGlobal("localStorage", { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) });
  return entries;
}
const inspection = () => ({ clientId: crypto.randomUUID(), jobId: crypto.randomUUID(), templateId: crypto.randomUUID(), status: "draft", arrivedAt: new Date().toISOString(), completedAt: null, arrivalGps: null, completionGps: null, values: { notes: "Fictional late callback" }, accessIssue: null, issues: [], photos: [], server: null });
const work = () => ({ clientId: crypto.randomUUID(), jobId: crypto.randomUUID(), templateId: crypto.randomUUID(), status: "draft", revision: 0, arrivedAt: new Date().toISOString(), completedAt: null, arrivalGps: null, completionGps: null, values: { problem: "Fictional late callback" }, photos: [], signatures: [], finalVisit: true, summary: null, server: null, held: null, resolved: null, draftAckedAt: null });
afterEach(() => vi.unstubAllGlobals());

describe("forgotten technician account lifecycle", () => {
  it("keeps a partial future work database read-only for cache writes and rejects new records without upgrading", async () => {
    const t = tenant(); registry(t);
    const futureOps = [{ seq: 1, kind: "estimate-sync", recordClientId: "future-record" }, { seq: 2, kind: "estimate-photo", recordClientId: "future-record" }];
    const requestFor = (result: unknown) => {
      const request = { result, onsuccess: null as (() => void) | null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    };
    const transaction = vi.fn((stores: string[], mode: string) => {
      expect(stores).toEqual(["outbox"]);
      expect(mode).toBe("readonly");
      return { objectStore: () => ({ getAll: () => requestFor(futureOps) }) };
    });
    const database = { version: 2, objectStoreNames: { contains: (name: string) => ["records", "outbox"].includes(name) }, transaction, close: vi.fn() };
    const open = vi.fn((_name: string, version?: number) => { expect(version).toBeUndefined(); return requestFor(database); });
    vi.stubGlobal("indexedDB", { open });
    const store = workStoreFor(t);
    await expect(store.kvSet("route", { date: "2026-10-13", items: [{ jobId: "new-visit" }] })).resolves.toBeUndefined();
    await expect(store.ensureWork(work())).rejects.toThrow("Update the app before saving new work");
    expect(open).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(database.close).toHaveBeenCalledTimes(2);
    expect(futureOps).toEqual([{ seq: 1, kind: "estimate-sync", recordClientId: "future-record" }, { seq: 2, kind: "estimate-photo", recordClientId: "future-record" }]);
  });

  it("merges refreshed photo links while preserving newer draft answers, thumbnails and removals", () => {
    const photoId = crypto.randomUUID();
    const local = { ...inspection(), values: { notes: "Latest unsent answer" }, photos: [{ clientId: photoId, photoKey: "overview", uploaded: false, preview: "data:image/png;base64,local" }] };
    const stored = { ...local, values: { notes: "Older server answer" }, photos: [{ clientId: photoId, photoKey: "overview", uploaded: true, url: "/files/refreshed?exp=123", urlVersion: 2 }, { clientId: crypto.randomUUID(), photoKey: "overview", uploaded: true, url: "/files/removed" }] };
    const merged = withSentState(local, stored);
    expect(merged.values).toEqual(local.values);
    expect(merged.status).toBe("draft");
    expect(merged.photos).toEqual([{ ...local.photos[0], uploaded: true, url: "/files/refreshed?exp=123", urlVersion: 2 }]);
  });

  it("rejects late inspection/work/GPS/photo writes before opening or recreating either database", async () => {
    const t = tenant(); registry();
    const open = vi.fn(() => { throw new Error("A forgotten database must not open"); });
    vi.stubGlobal("indexedDB", { open });
    const i = storeFor(t); const w = workStoreFor(t);
    for (const write of [() => i.ensureInspection(inspection()), () => i.saveInspection(inspection()), () => i.photoUploaded(crypto.randomUUID(), crypto.randomUUID()), () => i.refreshPhotoUrls(crypto.randomUUID(), crypto.randomUUID(), []), () => w.ensureWork(work()), () => w.saveWork(work()), () => w.uploaded(crypto.randomUUID(), { photoClientId: crypto.randomUUID() })]) {
      await expect(write()).rejects.toThrow("no longer kept on this phone");
    }
    expect(open).not.toHaveBeenCalled();
  });

  for (const kind of ["inspection", "work"] as const) {
    it(`rechecks registration after an in-flight ${kind} database open before creating a write transaction`, async () => {
      const t = tenant(); const entries = registry(t);
      const transaction = vi.fn(() => { throw new Error("Must not start a write after access ended"); });
      const result = { objectStoreNames: { contains: () => true }, transaction, close: vi.fn(), version: 1 };
      const request = { result, onsuccess: null as (() => void) | null, onerror: null, onupgradeneeded: null };
      vi.stubGlobal("indexedDB", { open: vi.fn(() => request) });
      const writing = kind === "inspection" ? storeFor(t).ensureInspection(inspection()) : workStoreFor(t).ensureWork(work());
      // A confirmed access-end removes the registration while IndexedDB opening is still pending.
      entries.delete("aerowise-tech:tenants");
      request.onsuccess!();
      await expect(writing).rejects.toThrow("no longer kept on this phone");
      expect(transaction).not.toHaveBeenCalled();
    });
  }
});
