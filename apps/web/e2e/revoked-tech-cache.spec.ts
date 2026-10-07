import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// STG-03: the technician app keeps each sign-in's route, inspections and photos apart, clears a
// demo company's copy once the server says that demo has ended, and keeps everything when it
// only lost signal or its sign-in expired. Runs in Pixel 7 emulation; not a physical-phone check.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"], serviceWorkers: "allow" });

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

/** Opens the demo from its link and looks around as its technician; returns who that is. */
async function enterAsTechnician(page: Page, url: URL) {
  await page.goto(url.pathname + url.hash);
  await page.waitForURL("**/inbox");
  expect((await page.request.post("/api/demo/switch", { data: { role: "technician" } })).ok()).toBe(true);
  await page.goto("/tech");
  await expect(page.locator(".stop-card").first()).toBeVisible();
  return (await (await page.request.get("/api/auth/me")).json()) as { user: { id: string; name: string }; organization: { id: string; name: string } };
}

/** Starts the first stop still to do, which queues one change on the phone. Returns its customer. */
async function startFirstStop(page: Page) {
  const card = page.locator(".stop-card", { hasText: "To do" }).first();
  const customer = await card.locator("strong").innerText();
  await card.click();
  await page.getByRole("button", { name: "Arrive and start inspection" }).click();
  await expect(page.getByRole("group", { name: "Aerator" })).toBeVisible();
  await page.getByRole("button", { name: "‹ Back" }).click();
  await page.getByRole("button", { name: "‹ Back" }).click();
  await expect(page.locator(".stop-card", { hasText: customer })).toContainText("In progress");
  return customer;
}

const databases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""));
const scoped = (orgId: string, userId: string) => `aerowise-tech:${orgId}:${userId}`;

async function waitForOfflineShell(page: Page) {
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(async () => (await (await caches.open("aerowise-shell-v1")).keys()).length > 5);
}

test("reloading an open technician app after the demo was ended shows nothing of it", async ({ page, browser }) => {
  const admin = await adminRequest(browser);
  const demo = await makeProspectDemo(admin, "Revoked Reload Septic");
  const tech = await enterAsTechnician(page, demo.url);
  expect(await databases(page)).toContain(scoped(demo.id, tech.user.id));

  expect((await admin.post(`/api/admin/prospect-demos/${demo.id}/end`, { data: {} })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("access-ended")).toContainText("This demo has ended");
  await expect(page.getByTestId("access-ended")).toContainText("removed from this phone");
  await expect(page.locator(".stop-card")).toHaveCount(0);
  await expect(page.getByText("Sign in again to send your changes")).toHaveCount(0);
  expect(await databases(page)).not.toContain(scoped(demo.id, tech.user.id));

  // Opening it once more finds nothing saved, and asks for a sign-in.
  await page.reload();
  await page.waitForURL("**/login**");
  await expect(page.locator(".stop-card")).toHaveCount(0);
});

test("a demo ended while the phone had no signal is kept until the phone can ask, then cleared", async ({ page, browser, context }) => {
  const admin = await adminRequest(browser);
  const demo = await makeProspectDemo(admin, "Revoked Offline Septic");
  const tech = await enterAsTechnician(page, demo.url);
  await waitForOfflineShell(page);

  await context.setOffline(true);
  await page.reload();
  await startFirstStop(page);
  await expect(page.getByTestId("sync-status")).toContainText("No signal. 1 change saved on this phone");

  expect((await admin.post(`/api/admin/prospect-demos/${demo.id}/end`, { data: {} })).ok()).toBe(true);
  // Still no signal: nothing can say the demo ended, so nothing is removed.
  await page.reload();
  await expect(page.locator(".stop-card", { hasText: "In progress" })).toHaveCount(1);
  expect(await databases(page)).toContain(scoped(demo.id, tech.user.id));

  // Back in signal, the refused send asks the server, learns the demo ended, and clears it.
  await context.setOffline(false);
  await expect(page.getByTestId("access-ended")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("access-ended")).toContainText("1 unsent change from the demo could not be sent");
  await expect(page.locator(".stop-card")).toHaveCount(0);
  expect(await databases(page)).not.toContain(scoped(demo.id, tech.user.id));
});

// Both below use their own prospect demo companies, so they share no route with other tests.
test("an expired sign-in keeps the route and unsent work until the same person signs in again", async ({ page, browser, context }) => {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const count = async (organizationId: string) => Number((await db.query("select count(*) as n from inspections where organization_id = $1", [organizationId])).rows[0].n);
  try {
    const demo = await makeProspectDemo(await adminRequest(browser), "Expired Session Septic");
    const me = await enterAsTechnician(page, demo.url);
    const before = await count(me.organization.id);

    // Requests time out: the change stays queued.
    await context.route("**/api/inspections/**", (route) => route.abort("timedout"));
    const customer = await startFirstStop(page);
    await expect(page.getByTestId("sync-status")).toContainText("1 change");

    // The sign-in expires (the session cookie is gone) and the app is reopened with signal.
    await context.clearCookies();
    await context.unroute("**/api/inspections/**");
    await page.reload();
    await expect(page.getByText("Sign in again to send your changes. They are saved on this phone.")).toBeVisible();
    await expect(page.locator(".stop-card", { hasText: customer })).toContainText("In progress");
    await expect(page.getByTestId("access-ended")).toHaveCount(0);
    expect(await databases(page)).toContain(scoped(me.organization.id, me.user.id));
    expect(await count(me.organization.id)).toBe(before);

    // The same technician signs in again: the change is sent, once.
    await enterAsTechnician(page, demo.url);
    await expect.poll(() => count(me.organization.id), { timeout: 30_000 }).toBe(before + 1);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    await expect(page.locator(".stop-card", { hasText: customer })).toContainText("In progress");
    await expect(page.locator(".sync.error")).toHaveCount(0);
  } finally {
    await db.end();
  }
});

test("another company's sign-in on the same phone sees none of the first one's data, and sends none of its work", async ({ page, browser, context }) => {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const count = async (organizationId: string) => Number((await db.query("select count(*) as n from inspections where organization_id = $1", [organizationId])).rows[0].n);
  try {
    const admin = await adminRequest(browser);
    const firstDemo = await makeProspectDemo(admin, "First Tenant Septic");
    const secondDemo = await makeProspectDemo(admin, "Second Tenant Septic");
    const first = await enterAsTechnician(page, firstDemo.url);
    const before = await count(first.organization.id);
    await context.route("**/api/inspections/**", (route) => route.abort("internetdisconnected"));
    await startFirstStop(page);
    await context.clearCookies();
    await context.unroute("**/api/inspections/**");

    // Another company's technician signs in on the same phone.
    const second = await enterAsTechnician(page, secondDemo.url);
    const theirsBefore = await count(second.organization.id);
    const theirs = (await (await page.request.get("/api/route")).json()).items.map((s: { customer: { displayName: string } }) => s.customer.displayName);
    await expect(page.locator(".stop-card strong")).toHaveText(theirs);
    await expect(page.locator(".stop-card", { hasText: "In progress" })).toHaveCount(0);
    await expect(page.getByTestId("other-sign-ins")).toContainText(`1 change made as ${first.user.name} at ${first.organization.name} is saved on this phone`);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    expect(await count(first.organization.id)).toBe(before);
    expect(await count(second.organization.id)).toBe(theirsBefore);
    expect(await databases(page)).toEqual(expect.arrayContaining([scoped(first.organization.id, first.user.id), scoped(second.organization.id, second.user.id)]));

    // The first technician signs in again: their change is sent, once, to their own company.
    await context.clearCookies();
    await enterAsTechnician(page, firstDemo.url);
    await expect.poll(() => count(first.organization.id), { timeout: 30_000 }).toBe(before + 1);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    await expect(page.locator(".sync.error")).toHaveCount(0);
    expect(await count(second.organization.id)).toBe(theirsBefore);
    // The second company's copy had nothing waiting, so it left the phone when the first came back.
    expect(await databases(page)).not.toContain(scoped(second.organization.id, second.user.id));
  } finally {
    await db.end();
  }
});

test("work saved by the earlier app version, before sign-ins had their own storage, is kept and sent", async ({ page, browser }) => {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const demo = await makeProspectDemo(await adminRequest(browser), "Upgraded Phone Septic");
    const me = await enterAsTechnician(page, demo.url);
    const route = await (await page.request.get("/api/route")).json();
    const template = await (await page.request.get("/api/inspection-template")).json();
    const stop = route.items.find((s: { status: string }) => s.status !== "completed");
    const before = Number((await db.query("select count(*) as n from inspections where organization_id = $1", [me.organization.id])).rows[0].n);

    // The phone as the previous version left it: one shared database holding a queued inspection.
    await page.evaluate(
      async ({ me, route, stop, templateId }) => {
        for (const key of Object.keys(localStorage)) if (key.startsWith("aerowise-tech")) localStorage.removeItem(key);
        await Promise.all((await indexedDB.databases()).map((d) => new Promise((r) => (indexedDB.deleteDatabase(d.name!).onsuccess = r))));
        const legacy = await new Promise<IDBDatabase>((resolve) => {
          const req = indexedDB.open("aerowise-tech", 1);
          req.onupgradeneeded = () => {
            req.result.createObjectStore("kv");
            req.result.createObjectStore("inspections", { keyPath: "jobId" });
            req.result.createObjectStore("photos", { keyPath: "clientId" });
            req.result.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
          };
          req.onsuccess = () => resolve(req.result);
        });
        const clientId = crypto.randomUUID();
        const t = legacy.transaction(["kv", "inspections", "outbox"], "readwrite");
        t.objectStore("kv").put(me, "me");
        t.objectStore("kv").put(route, "route");
        t.objectStore("inspections").put({
          clientId,
          jobId: stop.jobId,
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
        t.objectStore("outbox").add({ kind: "sync", inspectionClientId: clientId });
        await new Promise((r) => (t.oncomplete = r));
        legacy.close();
      },
      { me, route, stop, templateId: template.id },
    );

    await page.reload();
    await expect.poll(async () => Number((await db.query("select count(*) as n from inspections where organization_id = $1", [me.organization.id])).rows[0].n), { timeout: 30_000 }).toBe(before + 1);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    await expect(page.locator(".stop-card", { hasText: stop.customer.displayName })).toContainText("In progress");
    // It stays in the database it was saved in, now belonging to that sign-in only.
    expect(await databases(page)).toContain("aerowise-tech");
  } finally {
    await db.end();
  }
});
