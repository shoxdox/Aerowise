import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// SW-2a, the phone compatibility release and the phone's rollback floor. The technician app must:
// open its database at whatever version it already has (a later release never locks it out), keep
// what an earlier or later version saved, leave changes it cannot send waiting instead of running,
// failing or deleting them, and know the separate work database a later release adds, counting it
// as unsent and removing it with an ended demo. Runs in Pixel 7 emulation; not a physical-phone check.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"], serviceWorkers: "allow" });

type Me = { user: { id: string; name: string }; organization: { id: string; name: string } };
type RouteStop = { jobId: string; status: string; customer: { displayName: string } };

async function adminRequest(browser: Browser): Promise<APIRequestContext> {
  const admin = (await browser.newContext()).request;
  expect((await admin.post("/api/admin/auth/login", { data: { email: "admin@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return admin;
}

async function makeProspectDemo(admin: APIRequestContext, prospect: string) {
  const res = await admin.post("/api/admin/prospect-demos", { data: { prospect, serviceCounties: ["Travis County"], days: 7 } });
  expect(res.status()).toBe(201);
  const { demo, link } = await res.json();
  return { id: demo.id as string, url: new URL(link.url as string) };
}

// Opening a demo link is limited to 10 a minute from one address, and this file opens six.
// Later files open more, so the last test here waits until this file's minute has passed.
let lastEntry = 0;
test.afterAll(async () => {
  const wait = lastEntry + 61_000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
});

async function enterAsTechnician(page: Page, url: URL): Promise<Me> {
  lastEntry = Date.now();
  await page.goto(url.pathname + url.hash);
  await page.waitForURL("**/inbox");
  expect((await page.request.post("/api/demo/switch", { data: { role: "technician" } })).ok()).toBe(true);
  await page.goto("/tech");
  await expect(page.locator(".stop-card").first()).toBeVisible();
  return (await (await page.request.get("/api/auth/me")).json()) as Me;
}

const scoped = (me: Me) => `aerowise-tech:${me.organization.id}:${me.user.id}`;
const workDb = (me: Me) => `aerowise-tech-work:${me.organization.id}:${me.user.id}`;
const databases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""));

type StoreSpec = { name: string; keyPath?: string; autoIncrement?: boolean; rows?: unknown[]; kv?: Record<string, unknown> };

/** Leaves the app (so it holds no database open) and empties the phone of any app data. */
async function wipePhone(page: Page) {
  await page.goto("/manifest.webmanifest");
  await page.evaluate(async () => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("aerowise-tech")) localStorage.removeItem(key);
    await Promise.all((await indexedDB.databases()).map((d) => new Promise((r) => (indexedDB.deleteDatabase(d.name!).onsuccess = r))));
  });
}

/** Writes a database exactly as some app version would have left it. */
async function makeDb(page: Page, name: string, version: number, stores: StoreSpec[]) {
  await page.evaluate(
    async ({ name, version, stores }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = () => {
          for (const s of stores) {
            if (req.result.objectStoreNames.contains(s.name)) continue;
            req.result.createObjectStore(s.name, s.keyPath || s.autoIncrement ? { keyPath: s.keyPath, autoIncrement: s.autoIncrement } : undefined);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const t = db.transaction(
        stores.map((s) => s.name),
        "readwrite",
      );
      for (const s of stores) {
        for (const row of s.rows ?? []) t.objectStore(s.name).add(row);
        for (const [key, value] of Object.entries(s.kv ?? {})) t.objectStore(s.name).put(value, key);
      }
      await new Promise((r) => (t.oncomplete = r));
      db.close();
    },
    { name, version, stores },
  );
}

/** What is in a database now, read at its current version; null if the phone has none by that name. */
function readDb(page: Page, name: string) {
  return page.evaluate(async (name) => {
    if (!(await indexedDB.databases()).some((d) => d.name === name)) return null;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const stores = [...db.objectStoreNames];
    const rows: Record<string, unknown[]> = {};
    for (const s of stores) {
      const req = db.transaction([s], "readonly").objectStore(s).getAll();
      rows[s] = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    }
    const version = db.version;
    db.close();
    return { version, stores, rows };
  }, name);
}

/** Opens a database the way every release up to 0906828 did: always at version 1. */
const openAsEarlierRelease = (page: Page, name: string) =>
  page.evaluate(
    (name) =>
      new Promise<string>((resolve) => {
        const req = indexedDB.open(name, 1);
        req.onsuccess = () => {
          req.result.close();
          resolve("opened");
        };
        req.onerror = () => resolve(req.error?.name ?? "error");
      }),
    name,
  );

const draft = (clientId: string, jobId: string, templateId: string) => ({
  clientId,
  jobId,
  templateId,
  status: "draft",
  arrivedAt: new Date().toISOString(),
  completedAt: null,
  arrivalGps: null,
  completionGps: null,
  accessIssue: null,
  values: {},
  issues: [],
  photos: [],
  server: null,
});

/** The inspection database as every release since per-sign-in storage creates it (version 1). */
const inspectionStores = (extra: { kv: Record<string, unknown>; inspections: unknown[]; outbox: unknown[] }): StoreSpec[] => [
  { name: "kv", kv: extra.kv },
  { name: "inspections", keyPath: "jobId", rows: extra.inspections },
  { name: "photos", keyPath: "clientId" },
  { name: "outbox", keyPath: "seq", autoIncrement: true, rows: extra.outbox },
];

async function withDb<T>(fn: (count: (organizationId: string) => Promise<number>) => Promise<T>) {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    return await fn(async (organizationId) => Number((await db.query("select count(*) as n from inspections where organization_id = $1", [organizationId])).rows[0].n));
  } finally {
    await db.end();
  }
}

/** A prospect demo of its own, entered as its technician, with the route and template the phone would have saved. */
async function techWithRoute(page: Page, browser: Browser, prospect: string) {
  const demo = await makeProspectDemo(await adminRequest(browser), prospect);
  const me = await enterAsTechnician(page, demo.url);
  const route = (await (await page.request.get("/api/route")).json()) as { date: string; items: RouteStop[] };
  const template = (await (await page.request.get("/api/inspection-template")).json()) as { id: string };
  const [first, second] = route.items.filter((s) => s.status !== "completed");
  if (!first || !second) throw new Error("the demo route needs two stops still to do");
  return { demo, me, route, template, open: [first, second] as const };
}

test("work the previous release left queued is sent once, its database stays at version 1, and a change it cannot send waits", async ({ page, browser }) => {
  await withDb(async (count) => {
    const { me, route, template, open } = await techWithRoute(page, browser, "Earlier Release Septic");
    const [a, b] = open;
    const before = await count(me.organization.id);
    const [aId, bId] = [crypto.randomUUID(), crypto.randomUUID()];

    // The phone as 0906828 left it, plus a change of a kind only a later release sends, queued
    // ahead of B's sync. A goes; B's sync must wait behind it so B never arrives out of order.
    await wipePhone(page);
    await makeDb(
      page,
      scoped(me),
      1,
      inspectionStores({
        kv: { me, route },
        inspections: [draft(aId, a.jobId, template.id), draft(bId, b.jobId, template.id)],
        outbox: [
          { kind: "sync", inspectionClientId: aId },
          { kind: "signature", inspectionClientId: bId, signatureClientId: crypto.randomUUID() },
          { kind: "sync", inspectionClientId: bId },
        ],
      }),
    );
    await page.goto("/tech");

    await expect.poll(() => count(me.organization.id), { timeout: 30_000 }).toBe(before + 1);
    await expect(page.getByTestId("update-waiting")).toHaveText("2 items will send after the app updates. They are saved on this phone.");
    await expect(page.getByTestId("sync-status")).toHaveCount(0);
    await expect(page.locator(".sync.error")).toHaveCount(0);
    for (const stop of [a, b]) await expect(page.locator(".stop-card", { hasText: stop.customer.displayName })).toContainText("In progress");

    // Nothing ran, failed or was dropped: the two waiting ops are exactly as queued.
    const after = await readDb(page, scoped(me));
    expect(after?.version).toBe(1);
    expect((after?.rows.outbox as { kind: string; inspectionClientId: string; failed?: string }[]).map((o) => [o.kind, o.inspectionClientId, o.failed ?? null])).toEqual([
      ["signature", bId, null],
      ["sync", bId, null],
    ]);
    expect((after?.rows.inspections as { clientId: string }[]).map((i) => i.clientId).sort()).toEqual([aId, bId].sort());

    // Still sent once after another reload and drain.
    await page.reload();
    await expect(page.getByTestId("update-waiting")).toBeVisible();
    expect(await count(me.organization.id)).toBe(before + 1);

    // Rolled back below this release, the earlier app still opens what this one leaves behind.
    expect(await openAsEarlierRelease(page, scoped(me))).toBe("opened");
  });
});

test("a database a later release moved on opens without VersionError, and its work database is counted but never touched", async ({ page, browser }) => {
  await withDb(async (count) => {
    const { me, route, template, open } = await techWithRoute(page, browser, "Later Release Septic");
    const before = await count(me.organization.id);
    const aId = crypto.randomUUID();

    await wipePhone(page);
    // A later release raised the inspection database to version 3 with a store of its own, and
    // keeps two unsent work changes in the separate work database.
    await makeDb(page, scoped(me), 3, [
      ...inspectionStores({ kv: { me, route }, inspections: [draft(aId, open[0].jobId, template.id)], outbox: [{ kind: "sync", inspectionClientId: aId }] }),
      { name: "later-release-store", keyPath: "id", rows: [{ id: "kept" }] },
    ]);
    await makeDb(page, workDb(me), 2, [
      { name: "outbox", keyPath: "seq", autoIncrement: true, rows: [{ kind: "work-sync", recordClientId: "w1" }, { kind: "work-photo", recordClientId: "w1" }] },
      { name: "records", keyPath: "clientId", rows: [{ clientId: "w1" }] },
    ]);
    // This is what an app that opens at a fixed version runs into.
    expect(await openAsEarlierRelease(page, scoped(me))).toBe("VersionError");

    await page.goto("/tech");
    await expect(page.locator(".stop-card").first()).toBeVisible();
    await expect.poll(() => count(me.organization.id), { timeout: 30_000 }).toBe(before + 1);
    await expect(page.getByTestId("update-waiting")).toHaveText("2 items will send after the app updates. They are saved on this phone.");

    const inspections = await readDb(page, scoped(me));
    expect(inspections?.version).toBe(3);
    expect(inspections?.rows["later-release-store"]).toEqual([{ id: "kept" }]);
    expect(inspections?.rows.outbox).toEqual([]);
    const work = await readDb(page, workDb(me));
    expect(work?.version).toBe(2);
    expect((work?.rows.outbox as { kind: string }[]).map((o) => o.kind)).toEqual(["work-sync", "work-photo"]);
    expect(work?.rows.records).toEqual([{ clientId: "w1" }]);

    // Signing out from the Map view warns about the work only the later release can send, and
    // cancelling keeps it and the view the technician was on.
    await page.getByRole("button", { name: "Map" }).click();
    await expect(page.getByRole("button", { name: "Map" })).toHaveAttribute("aria-pressed", "true");
    let warning = "";
    page.once("dialog", (d) => {
      warning = d.message();
      void d.dismiss();
    });
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => warning).toContain("2 of them will send only after the app updates");
    await expect(page).toHaveURL(/\/tech/);
    await expect(page.getByRole("button", { name: "Map" })).toHaveAttribute("aria-pressed", "true");
    expect((await readDb(page, workDb(me)))?.rows.outbox).toHaveLength(2);
  });
});

test("a store missing from the phone's database is added once, keeping what was saved", async ({ page, browser }) => {
  await withDb(async (count) => {
    const { me, route, template, open } = await techWithRoute(page, browser, "Missing Store Septic");
    const before = await count(me.organization.id);
    const aId = crypto.randomUUID();
    await wipePhone(page);
    await makeDb(
      page,
      scoped(me),
      1,
      inspectionStores({ kv: { me, route }, inspections: [draft(aId, open[0].jobId, template.id)], outbox: [{ kind: "sync", inspectionClientId: aId }] }).filter((s) => s.name !== "photos"),
    );

    await page.goto("/tech");
    await expect.poll(() => count(me.organization.id), { timeout: 30_000 }).toBe(before + 1);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    const after = await readDb(page, scoped(me));
    expect(after?.version).toBe(2);
    expect([...(after?.stores ?? [])].sort()).toEqual(["inspections", "kv", "outbox", "photos"]);
    expect((after?.rows.inspections as { clientId: string }[]).map((i) => i.clientId)).toEqual([aId]);
  });
});

test("an ended demo removes both of its databases, counting the work it could not send", async ({ page, browser }) => {
  const admin = await adminRequest(browser);
  const demo = await makeProspectDemo(admin, "Ended Work Septic");
  const me = await enterAsTechnician(page, demo.url);
  await makeDb(page, workDb(me), 2, [{ name: "outbox", keyPath: "seq", autoIncrement: true, rows: [{ kind: "work-sync" }, { kind: "signature" }] }]);
  expect(await databases(page)).toEqual(expect.arrayContaining([scoped(me), workDb(me)]));

  expect((await admin.post(`/api/admin/prospect-demos/${demo.id}/end`, { data: {} })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("access-ended")).toContainText("This demo has ended");
  await expect(page.getByTestId("access-ended")).toContainText("2 unsent changes from the demo could not be sent");
  const left = await databases(page);
  expect(left).not.toContain(scoped(me));
  expect(left).not.toContain(workDb(me));
});

test("another sign-in whose only unsent changes are in its work database stays on the phone until its demo ends", async ({ page, browser, context }) => {
  const admin = await adminRequest(browser);
  const firstDemo = await makeProspectDemo(admin, "Work Waiting Septic");
  const secondDemo = await makeProspectDemo(admin, "Next Sign-in Septic");
  const first = await enterAsTechnician(page, firstDemo.url);
  await makeDb(page, workDb(first), 2, [{ name: "outbox", keyPath: "seq", autoIncrement: true, rows: [{ kind: "work-sync" }] }]);

  // Someone else signs in on the same phone: the first sign-in's waiting work is kept and shown.
  await context.clearCookies();
  const second = await enterAsTechnician(page, secondDemo.url);
  await expect(page.getByTestId("other-sign-ins")).toContainText(`1 change made as ${first.user.name} at ${first.organization.name} is saved on this phone`);
  expect(await databases(page)).toEqual(expect.arrayContaining([scoped(first), workDb(first), scoped(second)]));

  // Once the first demo has ended, its data, including the work database, leaves the phone.
  expect((await admin.post(`/api/admin/prospect-demos/${firstDemo.id}/end`, { data: {} })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("other-sign-ins")).toContainText(`has ended, so its data was removed from this phone, including 1 unsent change`);
  const left = await databases(page);
  expect(left).not.toContain(scoped(first));
  expect(left).not.toContain(workDb(first));
  expect(left).toContain(scoped(second));
});
