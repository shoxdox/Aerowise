import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// Review of October 16, top issues #5 and #11. Signing out of the technician app (or a session
// the server no longer has) leaves no route, customer phone number or gate code readable on the
// phone, even with no signal; work not yet sent stays, locked, for the same person. The phone's
// Back steps through the app's screens instead of leaving it, and an answer tapped or typed just
// before a reload is still there. Each test uses its own prospect demo company. Pixel 7 emulation.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"], serviceWorkers: "allow" });

async function adminRequest(browser: Browser): Promise<APIRequestContext> {
  const admin = (await browser.newContext()).request;
  expect((await admin.post("/api/admin/auth/login", { data: { email: "admin@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return admin;
}

async function makeProspectDemo(browser: Browser, prospect: string) {
  const res = await (await adminRequest(browser)).post("/api/admin/prospect-demos", { data: { prospect, serviceCounties: ["Travis County"], days: 7 } });
  expect(res.status()).toBe(201);
  const { link } = await res.json();
  return new URL(link.url as string);
}

/** Opens the demo from its link as its technician; returns who that is. */
async function enterAsTechnician(page: Page, url: URL) {
  await page.goto(url.pathname + url.hash);
  await page.waitForURL("**/inbox");
  expect((await page.request.post("/api/demo/switch", { data: { role: "technician" } })).ok()).toBe(true);
  await page.goto("/tech");
  await expect(page.locator(".stop-card").first()).toBeVisible();
  return (await (await page.request.get("/api/auth/me")).json()) as { user: { id: string; name: string }; organization: { id: string; name: string } };
}

async function waitForOfflineShell(page: Page) {
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(async () => (await (await caches.open("aerowise-shell-v1")).keys()).length > 5);
}

const scoped = (me: { organization: { id: string }; user: { id: string } }) => `aerowise-tech:${me.organization.id}:${me.user.id}`;
const databases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""));

/** Every row of one store of a database on the phone, read without changing it. */
function rows(page: Page, name: string, store: string) {
  return page.evaluate(
    async ({ name, store }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const req = db.transaction([store], "readonly").objectStore(store).getAll();
        return await new Promise<unknown[]>((resolve) => (req.onsuccess = () => resolve(req.result)));
      } finally {
        db.close();
      }
    },
    { name, store },
  ) as Promise<Record<string, unknown>[]>;
}

/** What the phone shows anyone who picks it up: no route, customer, phone number or gate code, nothing to start. */
async function showsNothingOf(page: Page, route: { customer: { displayName: string; phone: string | null }; site: { gateCode: string | null } }[]) {
  await expect(page.locator(".stop-card")).toHaveCount(0);
  await expect(page.locator(".tech-bar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Arrive and start|Continue inspection/ })).toHaveCount(0);
  const text = await page.locator("body").innerText();
  for (const s of route) {
    expect(text).not.toContain(s.customer.displayName);
    if (s.customer.phone) expect(text).not.toContain(s.customer.phone);
    if (s.site.gateCode) expect(text).not.toContain(s.site.gateCode);
  }
}

test("signing out with nothing waiting takes the route off the phone, and opened again with no signal it only asks for a sign-in", async ({ page, browser, context }) => {
  const me = await enterAsTechnician(page, await makeProspectDemo(browser, "Clean Sign-out Septic"));
  const route = (await (await page.request.get("/api/route")).json()).items;
  expect(route.some((s: { site: { gateCode: string | null } }) => s.site.gateCode)).toBe(true);
  await waitForOfflineShell(page);
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");

  // Nothing waits to send, so there is nothing to confirm.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login**");
  expect(await databases(page)).not.toContain(scoped(me));
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("aerowise-tech:tenants") ?? "[]"))).toEqual([]);

  await context.setOffline(true);
  try {
    await page.goto("/tech");
    await expect(page.getByTestId("signed-out")).toContainText("Sign in with signal to download your route to this phone.");
    await showsNothingOf(page, route);
  } finally {
    await context.setOffline(false);
  }
});

test("signing out with work not yet sent keeps only that work, locked with its count, until the same person signs in and it is sent", async ({ page, browser, context }) => {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const count = async (organizationId: string) => Number((await db.query("select count(*) as n from inspections where organization_id = $1", [organizationId])).rows[0].n);
  try {
    const demo = await makeProspectDemo(browser, "Locked Sign-out Septic");
    const me = await enterAsTechnician(page, demo);
    const route = (await (await page.request.get("/api/route")).json()).items;
    await waitForOfflineShell(page);
    const before = await count(me.organization.id);

    // Sends fail for now: starting a stop leaves one change waiting on the phone.
    await context.route("**/api/inspections/**", (r) => r.abort("internetdisconnected"));
    const card = page.locator(".stop-card", { hasText: "To do" }).first();
    const customer = await card.locator("strong").innerText();
    await card.click();
    await page.getByRole("button", { name: "Arrive and start inspection" }).click();
    await expect(page.getByRole("group", { name: "Aerator" })).toBeVisible();
    await page.getByRole("group", { name: "Aerator" }).getByRole("button", { name: "Pass", exact: true }).click();
    let warning = "";
    page.once("dialog", (d) => {
      warning = d.message();
      void d.accept();
    });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/login**");
    expect(warning).toContain("Some changes have not reached the office yet.");

    // Only what the waiting change needs is left: no saved sign-in, route or form, and the
    // inspection without the customer's phone number, gate code or notes.
    expect(await rows(page, scoped(me), "kv")).toEqual([]);
    const kept = await rows(page, scoped(me), "inspections");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ values: { aerator: "pass" }, stopSnapshot: { customer: { displayName: customer, phone: null }, site: { gateCode: null, accessNotes: null }, notes: null } });
    expect((await rows(page, scoped(me), "outbox")).length).toBeGreaterThan(0);

    // Opened again, with signal or without: locked, saying what waits, with nothing to start.
    await page.goto("/tech");
    const locked = page.getByTestId("signed-out");
    await expect(locked).toContainText(`1 change for ${me.user.name} is waiting on this phone. Sign in to send it.`);
    await showsNothingOf(page, route);
    await context.setOffline(true);
    await page.reload();
    await expect(locked).toContainText(`1 change for ${me.user.name} is waiting on this phone.`);
    await showsNothingOf(page, route);
    await context.setOffline(false);
    expect(await count(me.organization.id)).toBe(before);

    // The same technician signs in again: the change is sent, once, and the route is back.
    await context.unroute("**/api/inspections/**");
    await enterAsTechnician(page, demo);
    await expect.poll(() => count(me.organization.id), { timeout: 30_000 }).toBe(before + 1);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    await expect(page.locator(".stop-card", { hasText: customer })).toContainText("In progress");
  } finally {
    await db.end();
  }
});

test("a session the server ended (expired, or the person deactivated) clears the phone the same way", async ({ page, browser, context }) => {
  const me = await enterAsTechnician(page, await makeProspectDemo(browser, "Ended Session Septic"));
  const route = (await (await page.request.get("/api/route")).json()).items;
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");

  // The session ends while the phone is away; nothing waits to send.
  await context.clearCookies();
  await page.reload();
  await page.waitForURL("**/login**");
  expect(await databases(page)).not.toContain(scoped(me));
  await page.goto("/tech");
  await page.waitForURL("**/login**");
  await showsNothingOf(page, route);
});

test("the phone's Back steps from the inspection to its stop to the list, each opening at its top and the list where it was left", async ({ page, browser }) => {
  await enterAsTechnician(page, await makeProspectDemo(browser, "Back Gesture Septic"));
  await page.setViewportSize({ width: 412, height: 520 });
  const last = page.locator(".stop-card", { hasText: "To do" }).last();
  const customer = await last.locator("strong").innerText();
  await last.scrollIntoViewIfNeeded();
  const listY = await page.evaluate(() => window.scrollY);
  expect(listY).toBeGreaterThan(0);

  await last.click();
  await expect(page.getByRole("heading", { level: 1, name: customer })).toBeVisible();
  await expect(page).toHaveURL(/\/tech\?jobId=/);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const stopUrl = page.url();
  await page.getByRole("button", { name: "Arrive and start inspection" }).click();
  await expect(page.getByRole("group", { name: "Aerator" })).toBeVisible();
  await expect(page).toHaveURL(/mode=inspect/);

  await page.goBack();
  await expect(page.getByRole("button", { name: "Continue inspection" })).toBeVisible();
  await page.goBack();
  await expect(page.locator(".stop-card", { hasText: customer })).toBeVisible();
  await expect(page).toHaveURL(/\/tech$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(listY);
  await page.goForward();
  await expect(page.getByRole("heading", { level: 1, name: customer })).toBeVisible();

  // ‹ Back does the same, one screen per tap.
  await page.getByRole("button", { name: "Continue inspection" }).click();
  await expect(page.getByRole("group", { name: "Aerator" })).toBeVisible();
  await page.getByRole("button", { name: "‹ Back" }).click();
  await page.getByRole("button", { name: "‹ Back" }).click();
  await expect(page.locator(".stop-card", { hasText: customer })).toBeVisible();

  // Opened straight at a stop (a link from the office, or the app reopened there): Back goes to the list, not out of the app.
  await page.goto(stopUrl);
  await expect(page.getByRole("heading", { level: 1, name: customer })).toBeVisible();
  await page.goBack();
  await expect(page.locator(".stop-card", { hasText: customer })).toBeVisible();
  await expect(page).toHaveURL(/\/tech$/);
});

test("an answer tapped or typed just before a reload is still there after it, and reaches the office", async ({ page, browser, context }) => {
  await enterAsTechnician(page, await makeProspectDemo(browser, "Quick Reload Septic"));
  await waitForOfflineShell(page);
  const card = page.locator(".stop-card", { hasText: "To do" }).first();
  await card.click();
  await page.getByRole("button", { name: "Arrive and start inspection" }).click();
  const jobId = new URL(page.url()).searchParams.get("jobId")!;
  const pass = page.getByRole("group", { name: "Aerator" }).getByRole("button", { name: "Pass", exact: true });

  // A tap is saved at once, and the reload reopens the inspection it was on.
  await pass.click();
  await page.reload();
  await expect(pass).toHaveAttribute("aria-pressed", "true");

  // Typing waits for a pause before it is saved. With the phone's database refusing writes, the
  // reload in that pause keeps the reading only through the copy written as the page went.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "inspections") throw new DOMException("Refused for this test", "UnknownError");
      return put.call(this, value, key);
    };
  });
  await page.getByLabel("Air pressure").fill("4.5");
  await page.reload();
  await expect(page.getByLabel("Air pressure")).toHaveValue("4.5");
  await expect(pass).toHaveAttribute("aria-pressed", "true");

  // With no signal too: the app reopens on the same inspection, as it was.
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByLabel("Air pressure")).toHaveValue("4.5");
    await expect(pass).toHaveAttribute("aria-pressed", "true");
  } finally {
    await context.setOffline(false);
  }

  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 30_000 });
  await expect.poll(async () => (await (await page.request.get(`/api/jobs/${jobId}/inspection`)).json()).values).toMatchObject({ aerator: "pass", air_pressure: 4.5 });
});
