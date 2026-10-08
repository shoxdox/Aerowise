import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// SW-12 plan §12 row 3: two work visits and one inspection done in one session with no signal,
// with photos and signatures, a reload while offline, then one reconnect. Every record, photo and
// signature reaches the server exactly once, and a newer edit made while an older sync of the same
// work record is still in flight is kept. Pixel 7 emulation; not a physical-phone check (G-DEVICE).
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

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

async function photos(page: Page) {
  await page.getByLabel("Add photo: Before the repair").setInputFiles({ name: "before.png", mimeType: "image/png", buffer: PNG });
  await page.getByLabel("Add photo: After the repair").setInputFiles({ name: "after.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator('[data-photo="after"]')).toContainText("1 taken");
}

async function signAndFinish(page: Page, signer: string) {
  await page.getByRole("button", { name: "Review and sign" }).click();
  await page.getByLabel("Name of the person signing").fill(signer);
  await sign(page);
  await page.getByRole("button", { name: "Sign and finish visit" }).click();
}

test("two work visits and an inspection done with no signal reach the office exactly once, keeping an edit made while a sync was in flight", async ({ page, context, browser }) => {
  test.setTimeout(240_000);
  const api = await office(browser);
  const a = await repairForTess(api, "Mixed offline A");
  const b = await repairForTess(api, "Mixed offline B");
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const count = async (q: string, params: unknown[] = []) => Number((await db.query(q, params)).rows[0].n);

  try {
    // Morning, with signal: the phone saves the app and the route.
    await page.goto("/login");
    await page.getByLabel("Email").fill("tech@example.com");
    await page.getByLabel("Password").fill("aerowise-dev");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/tech");
    await expect(page.getByTestId("work-stops")).toBeVisible();
    await expect(page.locator(".stop-card").first()).toBeVisible();
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.waitForFunction(async () => (await (await caches.open("aerowise-shell-v1")).keys()).length > 5);

    const before = {
      inspections: await count("select count(*) as n from inspections"),
      attachments: await count("select count(*) as n from attachments"),
      inspected: await count("select count(*) as n from audit_events where action = 'inspection.completed'"),
      filings: await count("select count(*) as n from filings"),
    };

    // No signal for the rest of the morning.
    await context.setOffline(true);
    await page.reload();

    // The inspection, with its photos.
    const stopCard = page.locator(".stop-card", { hasText: "To do" }).first();
    const customer = await stopCard.locator("strong").innerText();
    await stopCard.click();
    await page.getByRole("button", { name: "Arrive and start inspection" }).click();
    await expect(page.getByRole("group", { name: "Aerator" })).toBeVisible();
    for (const pass of await page.getByRole("button", { name: "Pass", exact: true }).all()) await pass.click();
    await page.getByRole("group", { name: "Chlorine device" }).getByRole("button", { name: "Working" }).click();
    await page.getByLabel("Chlorine level").fill("1.5");
    await page.getByLabel("Air pressure").fill("4");
    await page.getByRole("group", { name: "Odor" }).getByRole("button", { name: "None" }).click();
    await page.getByRole("group", { name: "Pumping needed" }).getByRole("button", { name: "No" }).click();
    await page.getByLabel("Add photo: Overview of the unit").setInputFiles({ name: "overview.png", mimeType: "image/png", buffer: PNG });
    await page.getByLabel("Add photo: Chlorinator").setInputFiles({ name: "chlorinator.png", mimeType: "image/png", buffer: PNG });
    await expect(page.locator('[data-photo="chlorinator"]')).toContainText("1 taken");
    await page.getByRole("button", { name: "Finish inspection" }).click();
    const inspection = page.locator(".stop-card", { hasText: customer });
    await expect(inspection).toContainText("Done · not sent yet");

    // Work visit A: done, with photos and the customer's signature.
    const cardA = page.locator(".work-card", { hasText: "Mixed offline A" });
    await cardA.click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await page.getByLabel("Problem found").fill("Alarm stays on (A)");
    await page.getByLabel("Work performed").fill("Replaced the float switch (A)");
    await page.getByRole("group", { name: "Follow-up visit needed" }).getByRole("button", { name: "No", exact: true }).click();
    await photos(page);
    await signAndFinish(page, "Pat Customer A");
    await expect(cardA).toContainText("Done · not sent yet");

    // Work visit B: started and part filled in; it is finished after the signal is back.
    const cardB = page.locator(".work-card", { hasText: "Mixed offline B" });
    await cardB.click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await page.getByLabel("Problem found").fill("Older answer (B)");
    await photos(page);
    await page.getByRole("button", { name: "‹ Back" }).click();
    await expect(cardB).toBeVisible();

    // Closing and reopening the app with no signal loses nothing; the server has none of it.
    await page.reload();
    await expect(inspection).toContainText("Done · not sent yet");
    await expect(cardA).toContainText("Done · not sent yet");
    expect(await count("select count(*) as n from work_records where job_id = any($1)", [[a.jobId, b.jobId]])).toBe(0);
    expect(await count("select count(*) as n from inspections")).toBe(before.inspections);

    // Back in signal. The answers to the inspection's and A's completing requests are lost on
    // the way back (recorded, never heard), and B's first draft sync is held in flight while the
    // technician finishes B with newer answers.
    let droppedInspection = 0;
    let droppedWork = 0;
    let releaseB: () => void = () => {};
    const heldB = new Promise<void>((r) => (releaseB = r));
    let heldBRevision = -1;
    await context.route("**/api/inspections/sync", async (route) => {
      if (droppedInspection === 0 && route.request().postDataJSON().status === "completed") {
        droppedInspection++;
        await route.fetch();
        await route.abort("connectionreset");
        return;
      }
      await route.continue();
    });
    await context.route("**/api/work/sync", async (route) => {
      const body = route.request().postDataJSON();
      if (body.jobId === a.jobId && body.status === "completed" && droppedWork === 0) {
        droppedWork++;
        await route.fetch();
        await route.abort("connectionreset");
        return;
      }
      if (body.jobId === b.jobId && body.status === "draft" && heldBRevision < 0) {
        heldBRevision = body.revision;
        await heldB;
      }
      await route.continue();
    });
    await context.setOffline(false);
    await expect.poll(() => heldBRevision, { timeout: 60_000 }).toBeGreaterThanOrEqual(0);

    // While B's older draft is still in flight, the technician finishes B.
    await cardB.click();
    await page.getByLabel("Problem found").fill("Newer answer (B)");
    await page.getByLabel("Work performed").fill("Cleaned the pump intake (B)");
    await page.getByRole("group", { name: "Follow-up visit needed" }).getByRole("button", { name: "No", exact: true }).click();
    await signAndFinish(page, "Pat Customer B");
    await expect(cardB).toContainText("Done");
    releaseB();

    await page.getByRole("button", { name: "Try now" }).click({ timeout: 30_000 }).catch(() => {});
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 90_000 });
    expect(droppedInspection).toBe(1);
    expect(droppedWork).toBe(1);
    for (const card of [inspection, cardA, cardB]) await expect(card).not.toContainText("not sent");

    // Exactly once: one inspection, its two photos, one completion and one filing.
    expect(await count("select count(*) as n from inspections")).toBe(before.inspections + 1);
    expect(await count("select count(*) as n from attachments")).toBe(before.attachments + 2);
    expect(await count("select count(*) as n from audit_events where action = 'inspection.completed'")).toBe(before.inspected + 1);
    expect(await count("select count(*) as n from audit_events where action = 'inspection.completion_rejected'")).toBe(0);
    expect(await count("select count(*) as n from filings")).toBe(before.filings + 1);

    // Exactly once for each work record: valid, completed, two photos, one matching signature, one completion.
    const rows = (
      await db.query(
        `select r.job_id, r.status, r.validation_status, r.phone_revision, r.answers::text as answers,
           (select count(*)::int from work_attachments x where x.record_client_id = r.offline_client_id) as photos,
           (select count(*)::int from signed_documents d where d.record_client_id = r.offline_client_id and d.kind = 'work_completion') as signatures,
           (select count(*)::int from signed_documents d where d.record_client_id = r.offline_client_id and d.kind = 'work_completion' and d.content_sha256 = r.summary_sha256) as matching,
           (select count(*)::int from audit_events e where e.entity_id = r.id and e.action = 'work_record.completed') as completions
         from work_records r where r.job_id = any($1) order by r.job_id = $2 desc`,
        [[a.jobId, b.jobId], a.jobId],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ status: "completed", validation_status: "valid", photos: 2, signatures: 1, matching: 1, completions: 1 });
    }
    expect(await count("select count(*) as n from work_sync_conflicts where job_id = any($1)", [[a.jobId, b.jobId]])).toBe(0);

    // B keeps the newer answers, not the older draft that was in flight.
    const recB = rows.find((r) => r.job_id === b.jobId)!;
    expect(recB.answers).toContain("Newer answer (B)");
    expect(recB.answers).toContain("Cleaned the pump intake (B)");
    expect(recB.answers).not.toContain("Older answer (B)");
    expect(recB.phone_revision).toBeGreaterThan(heldBRevision);

    for (const wo of [a, b]) expect((await (await api.get(`/api/work-orders/${wo.id}`)).json()).status).toBe("completed");
  } finally {
    // Later specs count today's work visits on the route and map: these move to yesterday.
    await db.query("update jobs set scheduled_date = scheduled_date - 1 where id = any($1)", [[a.jobId, b.jobId]]);
    await db.end();
  }
});
