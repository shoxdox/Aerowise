import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// SW-12 browser halves of plan §12 rows 26 and 33 (§8.5 R4 tests 1–5 on the phone): the office
// reassigns a work visit, cancels it or completes it on paper while the technician's phone is
// offline, either before the phone's first draft sync or after it but before the first upload,
// with two photos and a customer signature taken offline. Every send is answered 202 "held for
// the office", never a failed item; one conflict holds the record, both photos and the signature;
// the outbox empties; the office resolves it; after a reassignment the new technician completes
// their own record. Pixel 7 emulation; not a physical-phone check.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });

async function office(browser: Browser): Promise<APIRequestContext> {
  const request = (await browser.newContext()).request;
  expect((await request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return request;
}

/** A second technician for this run, invited and joined through the API; returns their id and sign-in. */
async function secondTech(browser: Browser, api: APIRequestContext, stamp: string) {
  const email = `rita.${stamp}@example.com`;
  const sent = await api.post("/api/invitations", { data: { email, name: `Rita Relief ${stamp}`, role: "technician" } });
  expect(sent.status()).toBe(201);
  const token = new URL((await sent.json()).url).pathname.split("/").pop()!;
  // Accepting signs the new person in, so it happens in a context of its own.
  const invitee = await browser.newContext();
  const joined = await invitee.request.post(`/api/invitations/accept/${token}`, { data: { password: "rita-secret-1", name: `Rita Relief ${stamp}` } });
  expect(joined.ok(), await joined.text()).toBe(true);
  await invitee.close();
  const techs = (await (await api.get("/api/technicians")).json()).items as { id: string; name: string }[];
  return { id: techs.find((t) => t.name === `Rita Relief ${stamp}`)!.id, email, password: "rita-secret-1" };
}

/** A repair work order for Tess Tech today; returns its id and its visit's job id. */
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

async function signIn(page: Page, email: string, password = "aerowise-dev") {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/tech");
  await expect(page.getByTestId("work-stops")).toBeVisible();
}

async function fillRepair(page: Page, done: string) {
  await page.getByLabel("Problem found").fill("Alarm stays on after the pump runs");
  await page.getByLabel("Work performed").fill(done);
  await page.getByRole("group", { name: "Follow-up visit needed" }).getByRole("button", { name: "No", exact: true }).click();
  await page.getByLabel("Add photo: Before the repair").setInputFiles({ name: "before.png", mimeType: "image/png", buffer: PNG });
  await page.getByLabel("Add photo: After the repair").setInputFiles({ name: "after.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator('[data-photo="after"]')).toContainText("1 taken");
}

async function signAndFinish(page: Page) {
  await page.getByRole("button", { name: "Review and sign" }).click();
  await page.getByLabel("Name of the person signing").fill("Pat Customer");
  const box = (await page.getByLabel("Signature pad").boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 15, { steps: 5 });
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 15, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Sign and finish visit" }).click();
}

/** The work outbox on the phone. */
function outbox(page: Page) {
  return page.evaluate(async () => {
    const name = (await indexedDB.databases()).map((d) => d.name ?? "").find((n) => n.startsWith("aerowise-tech-work:"));
    if (!name) return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const req = db.transaction(["outbox"], "readonly").objectStore("outbox").getAll();
    const ops = await new Promise<{ kind: string; failed?: string }[]>((r) => (req.onsuccess = () => r(req.result)));
    db.close();
    return ops.map((o) => ({ kind: o.kind, failed: o.failed ?? null }));
  });
}

type Conflict = { id: string; jobId: string; reason: string; status: string; photoCount: number; signatureCount: number; technicianName: string; payload: { status?: string } | null };

for (const when of ["before the first draft sync", "after the draft sync, before the first upload"] as const) {
  for (const how of ["reassigned", "cancelled", "office_completed"] as const) {
    test(`a visit ${how.replace("_", "-")} ${when} is held for the office with both photos and the signature, never failed`, async ({ page, context, browser }) => {
      const api = await office(browser);
      const stamp = `${Date.now()}`;
      const title = `Float switch (${how}, ${when === "before the first draft sync" ? "no draft" : "draft sent"} ${stamp})`;
      const wo = await repairForTess(api, title);
      const rita = how === "reassigned" ? await secondTech(browser, api, stamp) : null;
      const db = new pg.Client({ connectionString: databaseUrl });
      await db.connect();
      // Every answer the phone gets for this visit's work.
      const answers: number[] = [];
      page.on("response", (r) => {
        if (/\/api\/work\/(sync|[^/]+\/(photos|signatures)\/)/.test(r.url()) && r.request().method() === "PUT") answers.push(r.status());
      });
      try {
        await signIn(page, "tech@example.com");
        const card = page.locator(".work-card", { hasText: title });
        if (when === "before the first draft sync") {
          // No signal from the moment the work starts: the server has never heard of the record.
          await context.setOffline(true);
          await card.click();
          await page.getByRole("button", { name: "Arrive and start work" }).click();
        } else {
          // Started with signal, so the office has the draft; the rest happens with none.
          await card.click();
          await page.getByRole("button", { name: "Arrive and start work" }).click();
          await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 30_000 });
          await expect.poll(async () => (await db.query("select count(*)::int as n from work_records where job_id = $1", [wo.jobId])).rows[0].n).toBe(1);
          await context.setOffline(true);
        }
        await fillRepair(page, "Replaced the float switch and tested the alarm");
        await signAndFinish(page);
        await expect(card).toContainText("Done · not sent yet");

        // Meanwhile the office takes the visit away.
        const taken =
          how === "reassigned"
            ? await api.patch(`/api/jobs/${wo.jobId}`, { data: { technicianId: rita!.id } })
            : how === "cancelled"
              ? await api.post(`/api/jobs/${wo.jobId}/cancel`, { data: { reason: "Customer rescheduled" } })
              : await api.post(`/api/work-orders/${wo.id}/complete`, { data: { reason: "Done on paper" } });
        expect(taken.ok(), await taken.text()).toBe(true);

        // Back in signal: every send is held for the office, none fails, and the outbox empties.
        await context.setOffline(false);
        await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
        expect(await outbox(page)).toEqual([]);
        await expect(page.locator(".sync.error")).toHaveCount(0);
        expect(answers.length).toBeGreaterThanOrEqual(4);
        expect(answers.every((s) => s === 200 || s === 201 || s === 202)).toBe(true);
        expect(answers.filter((s) => s === 202).length).toBeGreaterThanOrEqual(when === "before the first draft sync" ? 4 : 3);
        await page.getByRole("button", { name: "Refresh" }).click();
        const kept = page.locator(".work-card, [data-testid=off-route-work] li", { hasText: title });
        await expect(kept).toContainText("Held for the office");

        // One conflict holds the finished record, both photos and the signature; no field record.
        const conflicts = ((await (await api.get("/api/work/conflicts")).json()).items as Conflict[]).filter((c) => c.jobId === wo.jobId);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]).toMatchObject({ reason: how, status: "held", photoCount: 2, signatureCount: 1, technicianName: "Tess Tech", payload: { status: "completed" } });
        expect((await db.query("select count(*)::int as n from work_records where job_id = $1", [wo.jobId])).rows[0].n).toBe(0);
        expect((await db.query("select count(*)::int as n from work_attachments a join work_sync_conflicts c on c.offline_client_id = a.record_client_id and c.organization_id = a.organization_id where c.id = $1", [conflicts[0]!.id])).rows[0].n).toBe(2);

        // The office resolves it on the work order.
        const officePage = await (await browser.newContext()).newPage();
        await officePage.goto("/login");
        await officePage.getByLabel("Email").fill("owner@example.com");
        await officePage.getByLabel("Password").fill("aerowise-dev");
        await officePage.getByRole("button", { name: "Sign in" }).click();
        await officePage.waitForURL("**/inbox");
        await officePage.goto(`/work/${wo.id}`);
        const held = officePage.getByTestId("held-records");
        await expect(held).toContainText("finished on the phone · 2 photos · 1 signatures");

        if (how === "reassigned") {
          // The new technician finishes their own record for the same visit.
          const relief = await browser.newContext({ ...test.info().project.use, geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });
          const phone = await relief.newPage();
          await signIn(phone, rita!.email, rita!.password);
          await phone.locator(".work-card", { hasText: title }).click();
          await phone.getByRole("button", { name: "Arrive and start work" }).click();
          await fillRepair(phone, "Checked the switch Tess replaced");
          await phone.getByRole("button", { name: "Review and sign" }).click();
          await phone.getByRole("button", { name: "Finish without a signature" }).click();
          await expect(phone.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
          await expect
            .poll(async () => (await db.query("select r.status from work_records r join users u on u.id = r.technician_user_id where r.job_id = $1 and u.email = $2", [wo.jobId, rita!.email])).rows)
            .toEqual([{ status: "completed" }]);
          await relief.close();
          // Tess's record is set aside, with the reason.
          await held.getByRole("button", { name: "Set aside" }).click();
          await held.getByLabel("Why is it set aside?").fill("Rita redid the visit");
          await held.getByRole("button", { name: "Set aside" }).click();
          await expect(held).toContainText("Rita redid the visit");
          expect(((await (await api.get("/api/work/conflicts")).json()).items as Conflict[]).find((c) => c.jobId === wo.jobId)!.status).toBe("dismissed");
        } else {
          // The phone's work is kept: the office accepts it onto the work order.
          await held.getByRole("button", { name: "Accept this record" }).click();
          await expect(held).toContainText("accepted");
          expect(((await (await api.get("/api/work/conflicts")).json()).items as Conflict[]).find((c) => c.jobId === wo.jobId)!.status).toBe("attached");
          // Completed on paper, then the phone's record accepted: the paper reason gives way to the record.
          if (how === "office_completed") expect(await (await api.get(`/api/work-orders/${wo.id}`)).json()).toMatchObject({ status: "completed", completedWithoutRecordReason: null });
        }
        await officePage.context().close();
      } finally {
        await api.post(`/api/work-orders/${wo.id}/cancel`, { data: { reason: "e2e cleanup" } });
        // Later specs count today's work visits on the route and map: this one moves to yesterday.
        await db.query("update jobs set scheduled_date = scheduled_date - 1 where id = $1", [wo.jobId]);
        await db.end();
        // The relief technician was only for this run.
        if (rita) expect((await api.post(`/api/users/${rita.id}/deactivate`, { data: {} })).status()).toBe(204);
      }
    });
  }
}
