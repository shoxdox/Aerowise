import { expect, test } from "@playwright/test";
import pg from "pg";
import { failFilingSendOnce, prepareFilingOnce } from "./sw12-worker-steps.ts";

// SW-12 plan §12 row 16, browser half: an Example County (fictional) inspection's filing is
// switched by the office to the authority's CSV export. The downloaded CSV starts with the demo
// notice column; making it sends nothing and the filing stays unsent until the office marks it
// filed; confirming is a separate step that needs the authority's acknowledgment.
//
// How the filing gets there (the e2e harness runs no worker): one run of the report step makes it,
// and Example County's fictional rules queue it to send by email at once. The office can switch only
// a ready or failed filing to CSV, so its queued send is run once with the mail provider down
// (a forced, test-only failure) and the office takes the CSV path from the failed filing. In the
// demo with the email outbox the send would succeed instead; the CSV path is the fallback.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });

test("an Example County filing exported as CSV carries the demo column, stays unsent until marked filed, and is confirmed separately", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();

  try {
    // A Blanco site of its own (the seed keeps Blanco in the fictional Example County; its Lake
    // Travis sites report to LCRA), under contract, with a visit on Tess's route today.
    const office = (await browser.newContext()).request;
    expect((await office.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
    const customer = await (await office.post("/api/customers", { data: { displayName: "Row 16 CSV check" } })).json();
    const site = await (await office.post(`/api/customers/${customer.id}/sites`, { data: { addressLine1: "16 Fixture Rd", city: "Blanco", state: "TX", postalCode: "78606", county: "Example County", permitNumber: "DEMO-016016" } })).json();
    expect((await office.post(`/api/sites/${site.id}/systems`, { data: { manufacturer: "Acme", chlorinationMethod: "tablet" } })).status()).toBe(201);
    const plan = ((await (await office.get("/api/plans")).json()).items as { id: string; name: string }[]).find((p) => p.name === "Residential annual")!;
    const { today } = (await (await office.get("/api/obligations/due?limit=1")).json()) as { today: string };
    const contracted = await office.post(`/api/sites/${site.id}/contracts`, { data: { planId: plan.id, startOn: today } });
    expect(contracted.status(), await contracted.text()).toBe(201);
    const contract = await contracted.json();
    const tess = ((await (await office.get("/api/technicians")).json()).items as { id: string; name: string }[]).find((t) => t.name === "Tess Tech")!;
    expect((await office.post("/api/jobs", { data: { obligationId: contract.obligations[0].id, technicianId: tess.id, scheduledDate: today } })).status()).toBe(201);

    // Tess finishes that inspection on the phone.
    const phone = await (await browser.newContext({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] })).newPage();
    await phone.goto("/login");
    await phone.getByLabel("Email").fill("tech@example.com");
    await phone.getByLabel("Password").fill("aerowise-dev");
    await phone.getByRole("button", { name: "Sign in" }).click();
    await phone.waitForURL("**/tech");
    await phone.locator(".stop-card", { hasText: "16 Fixture Rd" }).click();
    await phone.getByRole("button", { name: "Arrive and start inspection" }).click();
    await expect(phone.getByRole("group", { name: "Aerator" })).toBeVisible();
    for (const pass of await phone.getByRole("button", { name: "Pass", exact: true }).all()) await pass.click();
    await phone.getByRole("group", { name: "Chlorine device" }).getByRole("button", { name: "Working" }).click();
    await phone.getByLabel("Chlorine level").fill("1.5");
    await phone.getByLabel("Air pressure").fill("4");
    await phone.getByRole("group", { name: "Odor" }).getByRole("button", { name: "None" }).click();
    await phone.getByRole("group", { name: "Pumping needed" }).getByRole("button", { name: "No" }).click();
    await phone.getByLabel("Add photo: Overview of the unit").setInputFiles({ name: "overview.png", mimeType: "image/png", buffer: PNG });
    await phone.getByLabel("Add photo: Chlorinator").setInputFiles({ name: "chlorinator.png", mimeType: "image/png", buffer: PNG });
    await expect(phone.locator('[data-photo="chlorinator"]')).toContainText("1 taken");
    await phone.getByRole("button", { name: "Finish inspection" }).click();
    await expect(phone.getByText("not sent")).toHaveCount(0);
    await phone.context().close();

    const insp = (
      await db.query("select i.id, i.organization_id, s.county from inspections i join sites s on s.id = i.site_id join users u on u.id = i.technician_user_id where u.email = 'tech@example.com' and i.status = 'completed' order by i.completed_at desc limit 1")
    ).rows[0] as { id: string; organization_id: string; county: string };
    expect(insp.county).toBe("Example County");
    prepareFilingOnce(insp.organization_id, insp.id);
    const filing = (await db.query("select id, status, submission_method from filings where inspection_id = $1", [insp.id])).rows[0] as { id: string; status: string; submission_method: string };
    expect(filing, "the report step queues it to send by email").toMatchObject({ status: "queued", submission_method: "email" });
    failFilingSendOnce(insp.organization_id, filing.id);
    expect((await db.query("select status from filings where id = $1", [filing.id])).rows[0].status, "the send failed while the mail provider was down").toBe("failed");

    // The office switches it to the authority's CSV instead.
    await page.goto("/login");
    await page.getByLabel("Email").fill("owner@example.com");
    await page.getByLabel("Password").fill("aerowise-dev");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/inbox");
    await page.goto(`/filings/${filing.id}`);
    await page.getByRole("button", { name: "Export CSV instead" }).click();
    await expect(page.getByText("Upload the CSV")).toBeVisible();
    await expect(page.getByText("Making the CSV did not send anything.")).toBeVisible();

    // The CSV: the demo notice column first, on the header and the row.
    const href = await page.getByRole("link", { name: "Download the authority CSV" }).getAttribute("href");
    const csv = await page.request.get(href!);
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    const lines = (await csv.text()).replace(/^\uFEFF/, "").split("\r\n").filter(Boolean);
    expect(lines[0]!.split(",")[0]).toBe("aerowise_demo_notice");
    expect(lines[1]!.split(",")[0]).toBe("DEMO - FICTIONAL DATA - NOT FILED");

    // Still unsent: nothing went out, and it waits for the office.
    const row = async () => (await db.query("select status, submission_method, sent_at, confirmed_at from filings where id = $1", [filing.id])).rows[0];
    expect(await row()).toMatchObject({ status: "ready", submission_method: "csv_export", sent_at: null, confirmed_at: null });
    // Only the forced failed email attempt: no CSV attempt, nothing succeeded.
    expect((await db.query("select method, status from filing_attempts where filing_id = $1", [filing.id])).rows).toEqual([{ method: "email", status: "failed" }]);

    // Marked filed with the upload reference: sent, not confirmed.
    const upload = page.locator("form", { hasText: "Upload the CSV" });
    await upload.getByLabel("Upload or receipt reference").fill("UPL-ROW16");
    await upload.getByRole("button", { name: "Mark as filed" }).click();
    await expect(page.getByText("The authority acknowledged it")).toBeVisible();
    const sent = await row();
    expect(sent.status).toBe("sent");
    expect(sent.sent_at).not.toBeNull();
    expect(sent.confirmed_at).toBeNull();

    // Confirmed only when the office records the authority's acknowledgment.
    const ack = page.locator("form", { hasText: "The authority acknowledged it" });
    await ack.getByLabel("Received on").fill(today);
    await ack.getByLabel(/Their reference/).fill("ACK-ROW16");
    await ack.getByRole("button", { name: "Record acknowledgment" }).click();
    await expect(page.getByText("ACK-ROW16").first()).toBeVisible();
    expect((await row()).status).toBe("confirmed");
  } finally {
    await db.end();
  }
});
