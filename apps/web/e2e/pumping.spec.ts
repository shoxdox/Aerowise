import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// SW-6: a pumping visit recorded on the technician's phone with no signal, its pump-out sent once,
// then a disposal record with its manifest photo, and the office's disposal records and log. The
// e2e API runs with pumping switched on (playwright.config.ts). Pixel 7 emulation; not a
// physical-phone check.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"], serviceWorkers: "allow" });

async function office(browser: Browser): Promise<APIRequestContext> {
  const request = (await browser.newContext()).request;
  expect((await request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return request;
}

/** A truck and a facility named for this run, and a pumping work order for Tess Tech today. */
async function pumpingForTess(api: APIRequestContext, title: string) {
  const truck = await (await api.post("/api/vehicles", { data: { name: `Truck ${title}` } })).json();
  const facility = await (await api.post("/api/disposal-facilities", { data: { name: `Facility ${title}`, kind: "wastewater_treatment_plant" } })).json();
  const types = (await (await api.get("/api/work-types")).json()).items as { id: string; key: string }[];
  const site = (await (await api.get("/api/sites?limit=1")).json()).items[0] as { id: string };
  const techs = (await (await api.get("/api/technicians")).json()).items as { id: string; name: string }[];
  const { today } = await (await api.get("/api/obligations/due?limit=1")).json();
  const created = await api.post("/api/work-orders", { data: { siteId: site.id, workTypeId: types.find((t) => t.key === "pumping")!.id, title } });
  expect(created.status()).toBe(201);
  const wo = await created.json();
  const scheduled = await api.post(`/api/work-orders/${wo.id}/schedule`, { data: { technicianId: techs.find((t) => t.name === "Tess Tech")!.id, scheduledDate: today } });
  expect(scheduled.status()).toBe(201);
  return { id: wo.id as string, jobId: (await scheduled.json()).visits[0].jobId as string, truck: truck as { id: string; name: string }, facility: facility as { id: string; name: string } };
}

async function techPhone(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("tech@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/tech");
  await expect(page.getByTestId("work-stops")).toBeVisible();
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(async () => (await (await caches.open("aerowise-shell-v1")).keys()).length > 5);
}

/** The loads the phone keeps for the signed-in technician (kv "disposal-loads" in the work database). */
function phoneLoads(page: Page) {
  return page.evaluate(async () => {
    const name = (await indexedDB.databases()).map((d) => d.name ?? "").find((n) => n.startsWith("aerowise-tech-work:"));
    if (!name) return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const req = db.transaction(["kv"], "readonly").objectStore("kv").get("disposal-loads");
    const loads = await new Promise<unknown>((r) => (req.onsuccess = () => r(req.result)));
    db.close();
    return ((loads ?? []) as { clientId: string; groupId: string | null; photos: { uploaded: boolean }[] }[]).map((l) => ({ clientId: l.clientId, groupId: l.groupId, photosSent: l.photos.map((p) => p.uploaded) }));
  });
}

/** Tess records the pump-out for a pumping visit with signal; returns its group. */
async function pumpOutWithSignal(page: Page, db: pg.Client, wo: Awaited<ReturnType<typeof pumpingForTess>>, title: string) {
  const card = page.locator(".work-card", { hasText: title });
  await card.click();
  await page.getByRole("button", { name: "Arrive and start work" }).click();
  await page.getByLabel("Tanks pumped").fill("1");
  await page.getByRole("group", { name: "Lid condition" }).getByRole("button", { name: "Good" }).click();
  await page.getByLabel("Volume pumped").fill("500");
  await page.getByLabel("Truck").selectOption({ label: wo.truck.name });
  await page.getByRole("button", { name: "Review and sign" }).click();
  await page.getByRole("button", { name: "Finish without a signature" }).click();
  const query = () => db.query("select p.group_id from pumping_records p join work_records r on r.id = p.work_record_id where r.job_id = $1", [wo.jobId]);
  await expect.poll(async () => (await query()).rows.length, { timeout: 60_000 }).toBe(1);
  const rows = (await query()).rows;
  return rows[0].group_id as string;
}

test("a pump-out done with no signal reaches the office once, then its disposal record and manifest photo", async ({ page, context, browser }) => {
  const api = await office(browser);
  const wo = await pumpingForTess(api, "Pump-out (phone)");
  await techPhone(page);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await context.setOffline(true);
    await page.reload();
    const card = page.locator(".work-card", { hasText: "Pump-out (phone)" });
    await card.click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await page.getByLabel("Tanks pumped").fill("1");
    await page.getByRole("group", { name: "Lid condition" }).getByRole("button", { name: "Good" }).click();

    // A pumping visit finishes only with its pump-out.
    await page.getByRole("button", { name: "Review and sign" }).click();
    await expect(page.locator(".problems")).toContainText("Pump-out volume is required");
    await page.getByLabel("Volume pumped").fill("1000");
    await page.getByLabel("Truck").selectOption({ label: wo.truck.name });
    await page.getByRole("button", { name: "Review and sign" }).click();
    await expect(page.getByTestId("work-summary")).toContainText("1,000.0 gallons");
    await page.getByRole("button", { name: "Finish without a signature" }).click();
    await expect(card).toContainText("Done · not sent yet");
    expect((await db.query("select count(*)::int as n from pumping_records p join work_records r on r.id = p.work_record_id where r.job_id = $1", [wo.jobId])).rows[0].n).toBe(0);

    await context.setOffline(false);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
    const pumped = (await db.query("select p.group_id, p.volume_milligallons::int as mg from pumping_records p join work_records r on r.id = p.work_record_id where r.job_id = $1", [wo.jobId])).rows;
    expect(pumped).toEqual([{ group_id: expect.any(String), mg: 1_000_000 }]);

    // The disposal record, saved with no signal and sent once.
    await page.reload();
    await page.getByTestId("open-disposal").click();
    const screen = page.getByTestId("record-disposal");
    await context.setOffline(true);
    await screen.locator("label", { hasText: "1,000.0 gallons" }).getByRole("checkbox").check();
    await screen.getByLabel("Facility").selectOption({ label: wo.facility.name });
    await screen.getByLabel("Total delivered").fill("1000");
    await screen.getByLabel("Manifest/reference number").fill("E2E-M-1");
    await screen.getByLabel("Add manifest photo").setInputFiles({ name: "manifest.png", mimeType: "image/png", buffer: PNG });
    await expect(screen).toContainText("Manifest photo added");
    await screen.getByRole("button", { name: "Save disposal record" }).click();
    await expect(page.getByTestId("work-stops")).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
    const load = (
      await db.query(
        `select l.manifest_reference, (select count(*)::int from disposal_load_items i where i.load_group_id = l.group_id) as items,
           (select count(*)::int from work_attachments a where a.disposal_load_group_id = l.group_id) as photos
         from disposal_loads l join disposal_load_items i on i.load_group_id = l.group_id where l.is_current and i.pumping_group_id = $1`,
        [pumped[0].group_id],
      )
    ).rows;
    expect(load).toEqual([{ manifest_reference: "E2E-M-1", items: 1, photos: 1 }]);
    // The ordinary photo answer names no group: the phone keeps the one its load was given.
    const loadGroup = (await db.query("select load_group_id from disposal_load_items where pumping_group_id = $1", [pumped[0].group_id])).rows[0].load_group_id as string;
    expect(await phoneLoads(page)).toEqual([{ clientId: expect.any(String), groupId: loadGroup, photosSent: [true] }]);
    // The phone keeps the load's group once its photo is delivered, and says it is with the office.
    await page.reload();
    await page.getByTestId("open-disposal").click();
    await expect(page.getByTestId("record-disposal").locator(".card", { hasText: wo.facility.name })).toContainText("with the office");
    await page.getByRole("button", { name: /Back/ }).click();

    // The office sees it under Disposal, and the log downloads.
    const officePage = await (await browser.newContext()).newPage();
    await officePage.goto("/login");
    await officePage.getByLabel("Email").fill("owner@example.com");
    await officePage.getByLabel("Password").fill("aerowise-dev");
    await officePage.getByRole("button", { name: "Sign in" }).click();
    await officePage.waitForURL("**/inbox");
    await officePage.goto("/disposal");
    const row = officePage.getByTestId("disposal-loads").locator("tr", { hasText: "E2E-M-1" });
    await expect(row).toContainText(wo.facility.name);
    await row.getByRole("link").click();
    await expect(officePage.getByTestId("load-items")).toContainText("1,000.0 gallons");
    await expect(officePage.getByRole("img", { name: "Manifest photo" })).toHaveCount(1);
    await officePage.goto(`/work/${wo.id}`);
    await expect(officePage.getByTestId("pumping-history")).toContainText("Recorded");

    // The owner sets the company's disposal reminder; put back afterwards for the tests that follow.
    await officePage.goto("/settings/trucks");
    const grace = officePage.getByTestId("disposal-grace");
    await grace.getByLabel(/Days after a pump-out/).fill("5");
    await grace.getByRole("button", { name: "Save" }).click();
    await expect.poll(async () => (await (await api.get("/api/pumping/settings")).json()).disposalOverdueDays).toBe(5);
    expect((await api.patch("/api/pumping/settings", { data: { disposalOverdueDays: 2 } })).ok()).toBe(true);
  } finally {
    // Leaves no visit on Tess's route today, so the route and map tests that follow count only
    // their own stops (since SW-10 her work visits share the route with her inspections).
    await db.query("update jobs set scheduled_date = scheduled_date - 1 where id = $1", [wo.jobId]);
    await db.end();
  }
});

test("a manifest photo answered with only an acknowledgment (the office mixed the load) keeps the phone's load as sent", async ({ page, browser }) => {
  const api = await office(browser);
  const title = "Pump-out (acknowledged)";
  const wo = await pumpingForTess(api, title);
  await techPhone(page);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const pumpOut = await pumpOutWithSignal(page, db, wo, title);
    // Once another technician's pump-out is in the load, the server answers a replayed or late
    // photo with {outcome, groupId, clientId} only (covered against the API in pumping.test.ts);
    // here the real upload is made and its answer replaced by that acknowledgment.
    let acked = 0;
    await page.route("**/api/disposal/loads/*/photos/*", async (route) => {
      const res = await route.fetch();
      const loadClientId = new URL(route.request().url()).pathname.split("/")[4]!;
      const groupId = (await db.query("select group_id from disposal_loads where offline_client_id = $1", [loadClientId])).rows[0].group_id as string;
      acked++;
      await route.fulfill({ response: res, json: { outcome: "recorded", groupId, clientId: loadClientId } });
    });
    await page.reload();
    await page.getByTestId("open-disposal").click();
    const screen = page.getByTestId("record-disposal");
    await screen.locator("label", { hasText: "500.0 gallons" }).getByRole("checkbox").check();
    await screen.getByLabel("Facility").selectOption({ label: wo.facility.name });
    await screen.getByLabel("Total delivered").fill("500");
    await screen.getByLabel("Add manifest photo").setInputFiles({ name: "manifest.png", mimeType: "image/png", buffer: PNG });
    await screen.getByRole("button", { name: "Save disposal record" }).click();
    await expect.poll(() => acked, { timeout: 60_000 }).toBe(1);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
    const loadGroup = (await db.query("select load_group_id from disposal_load_items where pumping_group_id = $1", [pumpOut])).rows[0].load_group_id as string;
    const mine = (await phoneLoads(page)).find((l) => l.groupId === loadGroup);
    expect(mine).toEqual({ clientId: expect.any(String), groupId: loadGroup, photosSent: [true] });
    await page.reload();
    await page.getByTestId("open-disposal").click();
    await expect(page.getByTestId("record-disposal").locator(".card", { hasText: "500.0 gallons" })).toContainText("with the office");
  } finally {
    await db.query("update jobs set scheduled_date = scheduled_date - 1 where id = $1", [wo.jobId]);
    await db.end();
  }
});
