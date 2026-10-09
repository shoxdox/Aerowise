import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import { bannerHistory, holdOutbox, releaseOutbox, watchBanner, workOutboxCount } from "./sync-banner-steps.ts";

// The phone's banner never says "All changes sent" while something saved is still queued: not
// while another tab holds the outbox, not when a save lands during a pass that has already read
// the queues, and not with no signal. Every claim is checked against the phone's outbox and the
// server. Pixel 7 emulation.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const SENT = "All changes sent";
const CHECKING = "Checking for changes to send…";

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });

async function office(browser: Browser): Promise<APIRequestContext> {
  const request = (await browser.newContext()).request;
  expect((await request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return request;
}

async function tessId(api: APIRequestContext) {
  return ((await (await api.get("/api/technicians")).json()).items as { id: string; name: string }[]).find((t) => t.name === "Tess Tech")!.id;
}

/** A repair work order for Tess today; returns its id and its visit's job. */
async function repairForTess(api: APIRequestContext, title: string) {
  const types = (await (await api.get("/api/work-types")).json()).items as { id: string; key: string }[];
  const site = (await (await api.get("/api/sites?limit=1")).json()).items[0] as { id: string };
  const { today } = await (await api.get("/api/obligations/due?limit=1")).json();
  const wo = await (await api.post("/api/work-orders", { data: { siteId: site.id, workTypeId: types.find((t) => t.key === "repair")!.id, title } })).json();
  const scheduled = await api.post(`/api/work-orders/${wo.id}/schedule`, { data: { technicianId: await tessId(api), scheduledDate: today } });
  expect(scheduled.status()).toBe(201);
  return { id: wo.id as string, jobId: (await scheduled.json()).visits[0].jobId as string };
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("tech@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/tech");
  await expect(page.getByTestId("sync-status")).toHaveText(SENT);
}

/** How many changes wait in the inspection outbox on the phone. */
function inspectionOutboxCount(page: Page) {
  return page.evaluate(async () => {
    const name = (await indexedDB.databases()).map((d) => d.name ?? "").find((n) => n.startsWith("aerowise-tech:"));
    if (!name) return 0;
    const idb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const req = idb.transaction(["outbox"], "readonly").objectStore("outbox").count();
    const n = await new Promise<number>((r) => (req.onsuccess = () => r(req.result)));
    idb.close();
    return n;
  });
}

test("a work visit saved while another tab holds the outbox is not shown as sent until it is", async ({ page, browser }) => {
  const api = await office(browser);
  const title = `Banner held ${Date.now()}`;
  const wo = await repairForTess(api, title);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const records = async () => (await db.query("select count(*)::int as n from work_records where job_id = $1", [wo.jobId])).rows[0].n as number;
  try {
    await signIn(page);
    await watchBanner(page);
    await holdOutbox(page);
    await page.locator(".work-card", { hasText: title }).click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    // Saved and queued on the phone; the server has nothing; the banner does not say sent.
    await expect.poll(() => workOutboxCount(page)).toBe(1);
    expect(await records()).toBe(0);
    await expect(page.getByTestId("sync-status")).toHaveText(CHECKING);
    expect((await bannerHistory(page)).slice(1)).not.toContain(SENT);

    await releaseOutbox(page);
    await expect(page.getByTestId("sync-status")).toHaveText(SENT, { timeout: 30_000 });
    expect(await records()).toBe(1);
    expect(await workOutboxCount(page)).toBe(0);
  } finally {
    await api.post(`/api/work-orders/${wo.id}/cancel`, { data: { reason: "e2e cleanup" } });
    await db.query("update jobs set scheduled_date = scheduled_date - 1 where work_order_id = $1", [wo.id]);
    await db.end();
  }
});

test("an inspection change saved while a pass is reading the queues is not shown as sent from that pass's older counts", async ({ page, browser }) => {
  // The pass reads the inspection outbox first, then the work outbox. The change lands between the
  // two reads: the pass's counts are both empty, yet a change is queued and the server lacks it.
  const api = await office(browser);
  const due = (await (await api.get("/api/obligations/due?unscheduledOnly=true&limit=1")).json()).items[0] as { id: string; site: { addressLine1: string } };
  const { today } = await (await api.get("/api/obligations/due?limit=1")).json();
  const job = await api.post("/api/jobs", { data: { obligationId: due.id, technicianId: await tessId(api), scheduledDate: today } });
  expect(job.status(), await job.text()).toBe(201);
  const jobId = (await job.json()).jobId as string;
  // A work visit on the route too, so the phone keeps a work database for the pass to read.
  const wo = await repairForTess(api, `Banner inspection ${Date.now()}`);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const values = async () => (await db.query("select count(*)::int as n from inspection_values v join inspections i on i.id = v.inspection_id where i.job_id = $1", [jobId])).rows[0].n as number;
  try {
    await signIn(page);
    await page.locator(".stop-card", { hasText: due.site.addressLine1 }).first().click();
    await page.getByRole("button", { name: "Arrive and start inspection" }).click();
    await expect(page.getByRole("group", { name: "Aerator" })).toBeVisible();
    await page.getByRole("group", { name: "Chlorine device" }).getByRole("button", { name: "Working" }).click();
    await expect.poll(values, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId("sync-status")).toHaveText(SENT, { timeout: 30_000 });
    const before = await values();
    expect(await page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name?.startsWith("aerowise-tech-work:")))).toBe(true);
    await watchBanner(page);

    // Another tab holds the work outbox, so a pass that starts now stops at its second read.
    await page.evaluate(async () => {
      const name = (await indexedDB.databases()).map((d) => d.name ?? "").find((n) => n.startsWith("aerowise-tech-work:"))!;
      const idb = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const store = idb.transaction(["outbox"], "readwrite").objectStore("outbox");
      const w = window as unknown as { releaseWorkRead: () => void };
      let released = false;
      w.releaseWorkRead = () => (released = true);
      const spin = (): void => {
        store.count().onsuccess = () => (released ? idb.close() : spin());
      };
      spin();
    });
    // A pass starts (signal comes back) and reads the empty inspection outbox while it holds the lock.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.some((l) => l.name === "aerowise-outbox") ?? false)).toBe(true);
    await page.waitForTimeout(300);
    // The technician types a reading: saved and queued, and another pass is asked for.
    await page.getByLabel("Chlorine level").fill("1.5");
    await expect.poll(() => inspectionOutboxCount(page)).toBe(1);
    // Another tab then takes the outbox the moment this pass lets go, so the banner stays as this pass left it.
    await page.evaluate(() => {
      const w = window as unknown as { releaseOutbox?: () => void };
      void navigator.locks.request("aerowise-outbox", () => new Promise<void>((release) => (w.releaseOutbox = release)));
    });
    await page.evaluate(() => (window as unknown as { releaseWorkRead: () => void }).releaseWorkRead());
    await expect.poll(() => page.evaluate(() => !!(window as unknown as { releaseOutbox?: () => void }).releaseOutbox)).toBe(true);

    expect(await inspectionOutboxCount(page)).toBe(1);
    expect(await values()).toBe(before);
    await expect(page.getByTestId("sync-status")).not.toHaveText(SENT);
    expect((await bannerHistory(page)).slice(1)).not.toContain(SENT);

    await releaseOutbox(page);
    await expect(page.getByTestId("sync-status")).toHaveText(SENT, { timeout: 30_000 });
    expect(await inspectionOutboxCount(page)).toBe(0);
    expect(await values()).toBeGreaterThan(before);
  } finally {
    await api.post(`/api/jobs/${jobId}/cancel`, { data: { reason: "e2e cleanup" } });
    await api.post(`/api/work-orders/${wo.id}/cancel`, { data: { reason: "e2e cleanup" } });
    await db.query("update jobs set scheduled_date = scheduled_date - 1 where id = $1 or work_order_id = $2", [jobId, wo.id]);
    await db.end();
  }
});

test("with no signal and a change already waiting, another save says what waits and never that it was sent", async ({ page, context, browser }) => {
  const api = await office(browser);
  const stamp = Date.now();
  const a = await repairForTess(api, `Banner offline A ${stamp}`);
  const b = await repairForTess(api, `Banner offline B ${stamp}`);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const records = async () => (await db.query("select count(*)::int as n from work_records where job_id = any($1)", [[a.jobId, b.jobId]])).rows[0].n as number;
  try {
    await signIn(page);
    await context.setOffline(true);
    await page.locator(".work-card", { hasText: `Banner offline A ${stamp}` }).click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await expect(page.getByTestId("sync-status")).toHaveText(/^No signal\. 1 change saved on this phone/);
    await watchBanner(page);
    await page.getByRole("button", { name: "‹ Back" }).click();
    await page.locator(".work-card", { hasText: `Banner offline B ${stamp}` }).click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await expect(page.getByTestId("sync-status")).toHaveText(/^No signal\. 2 changes saved on this phone/);
    expect(await workOutboxCount(page)).toBe(2);
    expect(await records()).toBe(0);
    const seen = await bannerHistory(page);
    expect(seen).not.toContain(SENT);
    expect(seen).not.toContain(CHECKING);
    console.log("offline banner history:", JSON.stringify(seen));

    await context.setOffline(false);
    await expect(page.getByTestId("sync-status")).toHaveText(SENT, { timeout: 60_000 });
    expect(await records()).toBe(2);
  } finally {
    for (const wo of [a, b]) {
      await api.post(`/api/work-orders/${wo.id}/cancel`, { data: { reason: "e2e cleanup" } });
      await db.query("update jobs set scheduled_date = scheduled_date - 1 where work_order_id = $1", [wo.id]);
    }
    await db.end();
  }
});
