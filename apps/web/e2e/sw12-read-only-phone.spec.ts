import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// SW-12 plan §12 row 20: a company whose account went read-only (a lapsed subscription) while
// its technician had finished work on the phone. Every write is refused with organization_read_only;
// the phone keeps the work, says why, never marks it failed, and sends it exactly once after the
// account is reactivated. Pixel 7 emulation; not a physical-phone check (G-DEVICE).
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const TESS_ORG = "(select m.organization_id from memberships m join users u on u.id = m.user_id where u.email = 'tech@example.com' limit 1)";

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"], serviceWorkers: "allow" });

async function office(browser: Browser): Promise<APIRequestContext> {
  const request = (await browser.newContext()).request;
  expect((await request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return request;
}

async function repairForTess(api: APIRequestContext, title: string) {
  const types = (await (await api.get("/api/work-types")).json()).items as { id: string; key: string }[];
  const site = (await (await api.get("/api/sites?limit=1")).json()).items[0] as { id: string };
  const techs = (await (await api.get("/api/technicians")).json()).items as { id: string; name: string }[];
  const { today } = await (await api.get("/api/obligations/due?limit=1")).json();
  const created = await api.post("/api/work-orders", { data: { siteId: site.id, workTypeId: types.find((t) => t.key === "repair")!.id, title } });
  expect(created.status()).toBe(201);
  const wo = await created.json();
  const scheduled = await api.post(`/api/work-orders/${wo.id}/schedule`, { data: { technicianId: techs.find((t) => t.name === "Tess Tech")!.id, scheduledDate: today } });
  expect(scheduled.status()).toBe(201);
  return { id: wo.id as string, jobId: (await scheduled.json()).visits[0].jobId as string };
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

test("a company that went read-only while the phone was offline keeps the technician's work until it is reactivated, then gets it once", async ({ page, context, browser }) => {
  test.setTimeout(180_000);
  const api = await office(browser);
  const wo = await repairForTess(api, "Read-only company repair");
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const state = async () => (await db.query(`select subscription_state as s from organizations where id = ${TESS_ORG}`)).rows[0].s as string;
  const original = await state();
  const records = async () => Number((await db.query("select count(*) as n from work_records where job_id = $1", [wo.jobId])).rows[0].n);

  try {
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

    // No signal: the visit is done, with photos and the customer's signature.
    await context.setOffline(true);
    await page.reload();
    const card = page.locator(".work-card", { hasText: "Read-only company repair" });
    await card.click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await page.getByLabel("Problem found").fill("Alarm stays on");
    await page.getByLabel("Work performed").fill("Replaced the float switch");
    await page.getByRole("group", { name: "Follow-up visit needed" }).getByRole("button", { name: "No", exact: true }).click();
    await page.getByLabel("Add photo: Before the repair").setInputFiles({ name: "before.png", mimeType: "image/png", buffer: PNG });
    await page.getByLabel("Add photo: After the repair").setInputFiles({ name: "after.png", mimeType: "image/png", buffer: PNG });
    await expect(page.locator('[data-photo="after"]')).toContainText("1 taken");
    await page.getByRole("button", { name: "Review and sign" }).click();
    await page.getByLabel("Name of the person signing").fill("Pat Customer");
    await sign(page);
    await page.getByRole("button", { name: "Sign and finish visit" }).click();
    await expect(card).toContainText("Done · not sent yet");

    // Meanwhile the company's account lapses to read-only.
    await db.query(`update organizations set subscription_state = 'read_only' where id = ${TESS_ORG}`);

    // Back in signal: every send is refused, the phone says why and keeps everything.
    const refused: number[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/api/work/") && r.status() === 403) refused.push(r.status());
    });
    await context.setOffline(false);
    const status = page.getByTestId("sync-status");
    await expect(status).toContainText("Your company's account is read-only", { timeout: 60_000 });
    await expect(status).toContainText("will send once it is reactivated");
    expect(refused.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Try now" }).click();
    await expect(status).toContainText("Your company's account is read-only", { timeout: 30_000 });
    await expect(card).toContainText("not sent yet");
    await expect(page.getByText(/failed/i)).toHaveCount(0);
    expect(await records()).toBe(0);

    // Reopening the app keeps it too.
    await page.reload();
    await expect(card).toContainText("not sent yet");

    // Reactivated: it all arrives, once.
    await db.query(`update organizations set subscription_state = $1 where id = ${TESS_ORG}`, [original]);
    // The app retries on its own every 20 seconds; Try now only hurries it, and may already be gone.
    await page.getByRole("button", { name: "Try now" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(status).toHaveText("All changes sent", { timeout: 60_000 });
    const row = (
      await db.query(
        `select r.status, r.validation_status,
           (select count(*)::int from work_attachments a where a.record_client_id = r.offline_client_id) as photos,
           (select count(*)::int from signed_documents d where d.record_client_id = r.offline_client_id and d.kind = 'work_completion' and d.content_sha256 = r.summary_sha256) as signatures,
           (select count(*)::int from audit_events e where e.entity_id = r.id and e.action = 'work_record.completed') as completions
         from work_records r where r.job_id = $1`,
        [wo.jobId],
      )
    ).rows;
    expect(row).toEqual([{ status: "completed", validation_status: "valid", photos: 2, signatures: 1, completions: 1 }]);
  } finally {
    await db.query(`update organizations set subscription_state = $1 where id = ${TESS_ORG}`, [original]);
    // Later specs count today's work visits on the route and map: this one's moves to yesterday.
    await db.query("update jobs set scheduled_date = scheduled_date - 1 where id = $1", [wo.jobId]);
    await db.end();
  }
});
