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
  } finally {
    await db.end();
  }
});
