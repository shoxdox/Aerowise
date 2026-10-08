import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// SW-7: a two-visit installation on the technician's phone. The first visit needs another one,
// so the phone does not ask for the completion sign-off; the second finishes the work and the
// customer signs once. The office and the homeowner's portal then have the completion summary.
// Pixel 7 emulation; not a physical-phone check.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"], serviceWorkers: "allow" });

async function office(browser: Browser): Promise<APIRequestContext> {
  const request = (await browser.newContext()).request;
  expect((await request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return request;
}

async function techPhone(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("tech@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/tech");
  await expect(page.getByTestId("work-stops")).toBeVisible();
}

async function sign(page: Page) {
  const pad = page.getByLabel("Signature pad");
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 15, { steps: 5 });
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 15, { steps: 5 });
  await page.mouse.up();
}

async function fillVisit(page: Page, work: string) {
  await page.getByRole("group", { name: "Existing or new system" }).getByRole("button", { name: "New system" }).click();
  await page.getByLabel("Work done on this visit").fill(work);
  await page.getByLabel("Add photo: Install location").setInputFiles({ name: "site.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator('[data-photo="install_location"]')).toContainText("1 taken");
}

test("a two-visit installation is signed off once, on the final visit, and its completion summary reaches the office and the portal", async ({ page, browser }) => {
  const api = await office(browser);
  const title = "Drip field (two visits)";
  const types = (await (await api.get("/api/work-types")).json()).items as { id: string; key: string }[];
  const site = (await (await api.get("/api/sites?limit=1")).json()).items[0] as { id: string; customerId: string };
  const techs = (await (await api.get("/api/technicians")).json()).items as { id: string; name: string }[];
  const tess = techs.find((t) => t.name === "Tess Tech")!.id;
  const { today } = await (await api.get("/api/obligations/due?limit=1")).json();
  const wo = await (await api.post("/api/work-orders", { data: { siteId: site.id, workTypeId: types.find((t) => t.key === "installation")!.id, title } })).json();
  const schedule = async () => {
    const res = await api.post(`/api/work-orders/${wo.id}/schedule`, { data: { technicianId: tess, scheduledDate: today } });
    expect(res.status()).toBe(201);
    return ((await res.json()).visits as { jobId: string }[]).at(-1)!.jobId;
  };
  const jobs = [await schedule()];
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const signatures = async () =>
    (
      await db.query(
        `select count(*)::int as n from signed_documents d join work_records r on r.offline_client_id = d.record_client_id
         where r.work_order_id = $1 and d.kind = 'work_completion'`,
        [wo.id],
      )
    ).rows[0].n as number;
  try {
    await techPhone(page);

    // Visit 1: another visit is needed, so no completion sign-off is asked for.
    await page.locator(".work-card", { hasText: "visit 1" }).filter({ hasText: title }).click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await fillVisit(page, "Set and leveled the pump tank");
    await page.getByLabel("Another visit is needed to finish this work").check();
    await expect(page.getByRole("button", { name: "Finish visit" })).toBeVisible();
    await page.getByRole("button", { name: "Finish visit" }).click();
    await expect
      .poll(async () => (await db.query("select status, final_visit from work_records where job_id = $1", [jobs[0]])).rows, { timeout: 60_000 })
      .toEqual([{ status: "completed", final_visit: false }]);
    expect(await signatures()).toBe(0);
    await expect.poll(async () => (await (await api.get(`/api/work-orders/${wo.id}`)).json()).status).toBe("open");

    // Visit 2 finishes the work: the customer reads the summary and signs it.
    jobs.push(await schedule());
    await page.reload();
    await page.locator(".work-card", { hasText: "visit 2" }).filter({ hasText: title }).click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await fillVisit(page, "Laid and tested the drip lines");
    await page.getByRole("button", { name: "Review and sign" }).click();
    await expect(page.getByTestId("work-signoff")).toContainText("Customer completion sign-off");
    // The final visit's sign-off is required: there is no way to finish without it.
    await expect(page.getByRole("button", { name: "Finish without a signature" })).toHaveCount(0);
    await page.getByLabel("Name of the person signing").fill("Pat Customer");
    await sign(page);
    await page.getByRole("button", { name: "Sign and finish visit" }).click();
    await expect.poll(async () => (await (await api.get(`/api/work-orders/${wo.id}`)).json()).status, { timeout: 60_000 }).toBe("completed");
    await expect.poll(signatures, { timeout: 30_000 }).toBe(1);

    // The office opens the completion summary from the work order.
    const officePage = await (await browser.newContext()).newPage();
    await officePage.goto("/login");
    await officePage.getByLabel("Email").fill("owner@example.com");
    await officePage.getByLabel("Password").fill("aerowise-dev");
    await officePage.getByRole("button", { name: "Sign in" }).click();
    await officePage.waitForURL((u) => !u.pathname.startsWith("/login"));
    await officePage.goto(`/work/${wo.id}`);
    const link = officePage.getByTestId("completion-summary");
    await expect(link).toBeVisible();
    const pdf = await officePage.request.get((await link.getAttribute("href"))!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");

    // The homeowner finds it in their portal.
    const portal = await (await api.post(`/api/customers/${site.customerId}/portal-link`, { data: { send: false } })).json();
    const home = await (await browser.newContext()).newPage();
    await home.goto(new URL(portal.url).pathname);
    const listed = home.getByTestId("completed-work").getByRole("link", { name: new RegExp(title.replace(/[()]/g, "\\$&")) });
    await expect(listed).toBeVisible();
    const fromPortal = await home.request.get((await listed.getAttribute("href"))!);
    expect(fromPortal.status()).toBe(200);
    expect((await fromPortal.body()).subarray(0, 5).toString()).toBe("%PDF-");
  } finally {
    // Leaves no visit on Tess's route today, so the route and map tests count only their own stops.
    await db.query("update jobs set scheduled_date = scheduled_date - 1 where id = any($1)", [jobs]);
    await db.end();
  }
});
