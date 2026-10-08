import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// SW-2: work visits recorded on the technician's phone with no signal, sent once when it is back,
// and records the office took the visit away from held for the office to decide. The e2e API runs
// with AEROWISE_FEATURES=work_orders,field_work (playwright.config.ts). Pixel 7 emulation; not a
// physical-phone check.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"], serviceWorkers: "allow" });

async function office(browser: Browser): Promise<APIRequestContext> {
  const request = (await browser.newContext()).request;
  expect((await request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return request;
}

/** A repair work order for Tess Tech today; returns its id and its one visit's job id. */
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

/** Tess signs in on the phone and the app is saved for use with no signal. */
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

async function fillRepair(page: Page) {
  await page.getByLabel("Problem found").fill("Alarm stays on after the pump runs");
  await page.getByLabel("Work performed").fill("Replaced the float switch and tested the alarm");
  await page.getByRole("group", { name: "Follow-up visit needed" }).getByRole("button", { name: "No", exact: true }).click();
  await page.getByLabel("Add photo: Before the repair").setInputFiles({ name: "before.png", mimeType: "image/png", buffer: PNG });
  await page.getByLabel("Add photo: After the repair").setInputFiles({ name: "after.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator('[data-photo="after"]')).toContainText("1 taken");
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

test("a repair done and signed with no signal reaches the office exactly once, with its photos and signature", async ({ page, context, browser }) => {
  const api = await office(browser);
  const wo = await repairForTess(api, "Float switch (phone, offline)");
  await techPhone(page);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    // At the site, no signal.
    await context.setOffline(true);
    await page.reload();
    const card = page.locator(".work-card", { hasText: "Float switch (phone, offline)" });
    await expect(card).toContainText("To do");
    await card.click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();

    // Finishing with nothing filled in is refused on the phone, with the reasons.
    await page.getByRole("button", { name: "Review and sign" }).click();
    await expect(page.locator(".problems")).toContainText("Problem found");
    await fillRepair(page);

    // The customer reads the summary and signs it.
    await page.getByRole("button", { name: "Review and sign" }).click();
    await expect(page.getByTestId("work-summary")).toContainText("Replaced the float switch and tested the alarm");
    await page.getByLabel("Name of the person signing").fill("Pat Customer");
    await sign(page);
    await page.getByRole("button", { name: "Sign and finish visit" }).click();
    await expect(card).toContainText("Done · not sent yet");
    await expect(page.getByTestId("sync-status")).toContainText("No signal");

    // Closing and reopening the app with no signal loses nothing, and nothing reached the server.
    await page.reload();
    await expect(card).toContainText("Done · not sent yet");
    expect((await db.query("select count(*)::int as n from work_records where job_id = $1", [wo.jobId])).rows[0].n).toBe(0);

    // Back in signal, the completing request's answer is lost on the way back: the server
    // records it, the phone never hears, and sends it again.
    let dropped = 0;
    await context.route("**/api/work/sync", async (route) => {
      if (dropped === 0 && route.request().postDataJSON().status === "completed") {
        dropped++;
        await route.fetch();
        await route.abort("connectionreset");
        return;
      }
      await route.continue();
    });
    await context.setOffline(false);
    await expect.poll(() => dropped, { timeout: 30_000 }).toBe(1);
      await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
    await expect(card).toContainText("Done");
    await expect(card).not.toContainText("not sent");

    // Exactly once on the server: one valid completed record, two photos, one signature, one completion.
    const row = (
      await db.query(
        `select r.status, r.validation_status, r.final_visit,
           (select count(*)::int from work_attachments a where a.record_client_id = r.offline_client_id) as photos,
           (select count(*)::int from signed_documents d where d.record_client_id = r.offline_client_id and d.kind = 'work_completion' and d.content_sha256 = r.summary_sha256) as signatures,
           (select count(*)::int from audit_events e where e.entity_id = r.id and e.action = 'work_record.completed') as completions
         from work_records r where r.job_id = $1`,
        [wo.jobId],
      )
    ).rows;
    expect(row).toEqual([{ status: "completed", validation_status: "valid", final_visit: true, photos: 2, signatures: 1, completions: 1 }]);
    expect((await (await api.get(`/api/work-orders/${wo.id}`)).json()).status).toBe("completed");

    // The office sees the record under the visit.
    const officePage = await (await browser.newContext()).newPage();
    await officePage.goto("/login");
    await officePage.getByLabel("Email").fill("owner@example.com");
    await officePage.getByLabel("Password").fill("aerowise-dev");
    await officePage.getByRole("button", { name: "Sign in" }).click();
    await officePage.waitForURL("**/inbox");
    await officePage.goto(`/work/${wo.id}`);
    const record = officePage.getByTestId("field-record");
    await expect(record).toContainText("Replaced the float switch and tested the alarm");
    await expect(record).toContainText("Signed by Pat Customer");
    await expect(record.getByRole("link", { name: /Photo/ })).toHaveCount(2);
  } finally {
    await db.end();
  }
});

test("a visit the office completed while the phone was offline is held for the office, which accepts it", async ({ page, context, browser }) => {
  const api = await office(browser);
  const wo = await repairForTess(api, "Float switch (held)");
  await techPhone(page);

  // Started with signal, so the office already has the draft.
  const card = page.locator(".work-card", { hasText: "Float switch (held)" });
  await card.click();
  await page.getByRole("button", { name: "Arrive and start work" }).click();
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 30_000 });

  // No signal; the technician finishes without a signature (the repair form makes it optional)...
  await context.setOffline(true);
  await fillRepair(page);
  await page.getByRole("button", { name: "Review and sign" }).click();
  await page.getByRole("button", { name: "Finish without a signature" }).click();
  await expect(card).toContainText("Done · not sent yet");

  // ...while the office closes the work order on a paper ticket.
  expect((await api.post(`/api/work-orders/${wo.id}/complete`, { data: { reason: "Recorded on the paper ticket" } })).ok()).toBe(true);

  // Back in signal, the record reaches the office and is held there, which the phone shows.
  await context.setOffline(false);
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
  await expect(card).toContainText("Held for the office");
  await card.click();
  await expect(page.getByTestId("work-held")).toContainText("The office completed the work order without a field record while this phone was offline");

  // The office accepts it from the work order.
  const officePage = await (await browser.newContext()).newPage();
  await officePage.goto("/login");
  await officePage.getByLabel("Email").fill("owner@example.com");
  await officePage.getByLabel("Password").fill("aerowise-dev");
  await officePage.getByRole("button", { name: "Sign in" }).click();
  await officePage.waitForURL("**/inbox");
  await officePage.goto(`/work/${wo.id}`);
  const held = officePage.getByTestId("held-records");
  await expect(held).toContainText("Tess Tech");
  await expect(held).toContainText("finished on the phone · 2 photos · 0 signatures");
  await held.getByRole("button", { name: "Accept this record" }).click();
  await expect(held).toContainText("accepted");
  await expect(officePage.getByTestId("field-record").first()).toContainText("accepted by the office from a held record");
  await expect(officePage.getByTestId("work-timeline")).toContainText("Held field record accepted by the office");
});

test("a record for a visit the office cancelled stays visible on the phone as held, after the visit leaves the route", async ({ page, context, browser }) => {
  const api = await office(browser);
  const wo = await repairForTess(api, "Float switch (cancelled)");
  await techPhone(page);

  const card = page.locator(".work-card", { hasText: "Float switch (cancelled)" });
  await card.click();
  await page.getByRole("button", { name: "Arrive and start work" }).click();
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 30_000 });
  await context.setOffline(true);
  await fillRepair(page);
  await page.getByRole("button", { name: "Review and sign" }).click();
  await page.getByRole("button", { name: "Finish without a signature" }).click();
  expect((await api.post(`/api/work-orders/${wo.id}/cancel`, { data: { reason: "Customer fixed it themselves" } })).ok()).toBe(true);

  await context.setOffline(false);
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(card).toHaveCount(0);
  const kept = page.getByTestId("off-route-work").locator("li", { hasText: "Float switch (cancelled)" });
  await expect(kept).toContainText("Held for the office");
  await expect(kept).toContainText("The visit or work order was cancelled while this phone was offline");
});
