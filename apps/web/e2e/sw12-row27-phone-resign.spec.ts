import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// SW-12 browser halves of plan §12 row 27: a customer signature, then an edit of a signed field,
// and a form change while the phone is offline. The customer signs the summary of what is on the
// form at that moment, so an edit after they saw it needs their signature on the new summary; a
// signed record can no longer be changed on the phone; the server refuses a signature whose hash
// does not match. A form version the company saves while the phone is offline does not touch
// the visit: the phone finishes on the version it has, and the server accepts it.
// Pixel 7 emulation; not a physical-phone check.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });

async function office(browser: Browser): Promise<APIRequestContext> {
  const request = (await browser.newContext()).request;
  expect((await request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return request;
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

/** Later specs count today's work visits on the route and map: a finished one moves to yesterday. */
async function offToday(jobId: string) {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query("update jobs set scheduled_date = scheduled_date - 1 where id = $1", [jobId]);
  } finally {
    await db.end();
  }
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("tech@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
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

async function draw(page: Page) {
  const box = (await page.getByLabel("Signature pad").boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 15, { steps: 5 });
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 15, { steps: 5 });
  await page.mouse.up();
}

type Stored = {
  clientId: string;
  templateId: string;
  status: string;
  validationStatus: string;
  summary: { answers: { label: string; answer: string }[] } | null;
  summarySha256: string | null;
  signatures: { contentSha256: string; signerName: string }[];
};

test("an edit after the customer saw the summary is signed on the new summary, the signed record is locked, and a mismatched hash is refused", async ({ page, context, browser }) => {
  const api = await office(browser);
  const title = `Alarm relay (re-sign ${Date.now()})`;
  const wo = await repairForTess(api, title);
  try {
    await signIn(page);
    await page.locator(".work-card", { hasText: title }).click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 30_000 });
    await context.setOffline(true);

    // The customer reads the summary and starts to sign; then the technician goes back and changes the work done.
    await fillRepair(page, "Replaced the float switch");
    await page.getByRole("button", { name: "Review and sign" }).click();
    const summary = page.getByTestId("work-summary");
    await expect(summary).toContainText("Replaced the float switch");
    await page.getByLabel("Name of the person signing").fill("Pat Customer");
    await draw(page);
    await page.getByRole("button", { name: "Back to the form" }).click();
    await expect(page.getByTestId("work-signoff")).toHaveCount(0);
    await page.getByLabel("Work performed").fill("Replaced the float switch and the alarm relay");

    // Signing again shows the new summary, with nothing carried over from the first attempt.
    await page.getByRole("button", { name: "Review and sign" }).click();
    await expect(summary).toContainText("Replaced the float switch and the alarm relay");
    await expect(page.getByLabel("Name of the person signing")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Sign and finish visit" })).toBeDisabled();
    await page.getByLabel("Name of the person signing").fill("Pat Customer");
    await draw(page);
    await page.getByRole("button", { name: "Sign and finish visit" }).click();

    // Signed: the record can no longer be changed on the phone.
    await page.locator(".work-card", { hasText: title }).click();
    await expect(page.getByLabel("Work performed")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Review and sign" })).toHaveCount(0);
    await page.getByRole("button", { name: "‹ Back" }).click();

    await context.setOffline(false);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
    const stored = (await (await api.get(`/api/jobs/${wo.jobId}/work-record`)).json()) as Stored;
    expect(stored).toMatchObject({ status: "completed", validationStatus: "valid" });
    expect(stored.summary!.answers).toContainEqual({ label: "Work performed", answer: "Replaced the float switch and the alarm relay" });
    // One signature, on exactly the summary the record keeps.
    expect(stored.signatures).toHaveLength(1);
    expect(stored.signatures[0]).toMatchObject({ signerName: "Pat Customer", contentSha256: stored.summarySha256 });

    // A signature sent from this phone with a hash that does not match its summary never gets in.
    const forged = await page.request.put(`/api/work/${stored.clientId}/signatures/${crypto.randomUUID()}`, {
      data: { requirementKey: "customer_signoff", signerName: "Pat", capture: { kind: "typed" }, summary: stored.summary, summarySha256: "0".repeat(64), consentText: "ok", signedAt: new Date().toISOString() },
    });
    expect(forged.status()).toBe(422);
    expect(((await (await api.get(`/api/jobs/${wo.jobId}/work-record`)).json()) as Stored).signatures).toHaveLength(1);
  } finally {
    await api.post(`/api/work-orders/${wo.id}/cancel`, { data: { reason: "e2e cleanup" } });
    await offToday(wo.jobId);
  }
});

test("a form version saved while the phone is offline does not touch the visit: the phone finishes on the version it has", async ({ page, context, browser }) => {
  const api = await office(browser);
  const title = `Riser lid (form change ${Date.now()})`;
  const wo = await repairForTess(api, title);
  const before = (await (await api.get("/api/form-templates/work-repair")).json()) as { id: string; name: string; definition: { fields: { key: string }[] } };
  let changed = false;
  try {
    await signIn(page);
    await context.setOffline(true);

    // The company adds a required question while the technician has no signal.
    const stricter = await api.post("/api/form-templates/work-repair/versions", {
      data: {
        name: before.name,
        definition: { ...before.definition, fields: [...before.definition.fields, { key: "pump_model", label: "Pump model", section: "Repair", type: "text", required: true, maxLength: 200 }] },
      },
    });
    expect(stricter.status(), await stricter.text()).toBe(201);
    changed = true;
    const newer = (await stricter.json()) as { id: string };
    expect(newer.id).not.toBe(before.id);

    // The phone has the version it loaded; it finishes without the new question.
    await page.locator(".work-card", { hasText: title }).click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await fillRepair(page, "Replaced the riser lid screws");
    await expect(page.getByLabel("Pump model")).toHaveCount(0);
    await page.getByRole("button", { name: "Review and sign" }).click();
    await page.getByRole("button", { name: "Finish without a signature" }).click();
    await expect(page.locator(".work-card", { hasText: title })).toContainText("Done · not sent yet");

    await context.setOffline(false);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
    await expect(page.locator(".sync.error")).toHaveCount(0);
    const stored = (await (await api.get(`/api/jobs/${wo.jobId}/work-record`)).json()) as Stored;
    expect(stored).toMatchObject({ templateId: before.id, status: "completed", validationStatus: "valid" });
    expect((await (await api.get(`/api/work-orders/${wo.id}`)).json()).status).toBe("completed");
  } finally {
    // Put the form back as it was for later tests (versions are never edited, so this is a new one).
    if (changed) expect((await api.post("/api/form-templates/work-repair/versions", { data: { name: before.name, definition: before.definition } })).status()).toBe(201);
    await api.post(`/api/work-orders/${wo.id}/cancel`, { data: { reason: "e2e cleanup" } });
    await offToday(wo.jobId);
  }
});
