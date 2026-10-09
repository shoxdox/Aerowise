import { expect, test } from "@playwright/test";
import pg from "pg";

const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"], serviceWorkers: "allow" });

/**
 * The office gives a stop to someone else while the technician, out of signal, is inspecting
 * it. Back in signal nothing is refused or lost: the phone says the office holds it, and the
 * office accepts it from the inbox.
 */
test("an inspection finished offline for a reassigned visit is held, then accepted by the office", async ({ page, context, browser }) => {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await page.goto("/login");
    await page.getByLabel("Email").fill("tech@example.com");
    await page.getByLabel("Password").fill("aerowise-dev");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/tech");
    await expect(page.locator(".stop-card").first()).toBeVisible();
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);

    // A stop of its own on Tess's route today (a Blanco site, in the fictional county), so the
    // seeded route the other specs count on is left as it is.
    const office = (await browser.newContext()).request;
    expect((await office.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
    const customer = await (await office.post("/api/customers", { data: { displayName: "Held inspection check" } })).json();
    const address = "77 Fixture Rd";
    const site = await (await office.post(`/api/customers/${customer.id}/sites`, { data: { addressLine1: address, city: "Blanco", state: "TX", postalCode: "78606", county: "Example County", permitNumber: "DEMO-077077" } })).json();
    expect((await office.post(`/api/sites/${site.id}/systems`, { data: { manufacturer: "Acme", chlorinationMethod: "tablet" } })).status()).toBe(201);
    const plan = ((await (await office.get("/api/plans")).json()).items as { id: string; name: string }[]).find((p) => p.name === "Residential annual")!;
    const { today } = (await (await office.get("/api/obligations/due?limit=1")).json()) as { today: string };
    const contract = await (await office.post(`/api/sites/${site.id}/contracts`, { data: { planId: plan.id, startOn: today } })).json();
    const techs = (await (await office.get("/api/technicians")).json()).items as { id: string; name: string }[];
    const booked = await office.post("/api/jobs", { data: { obligationId: contract.obligations[0].id, technicianId: techs.find((t) => t.name === "Tess Tech")!.id, scheduledDate: today } });
    expect(booked.status()).toBe(201);
    const job = (await booked.json()) as { jobId: string };
    await page.getByRole("button", { name: "Refresh" }).click();
    const first = page.locator(".stop-card", { hasText: address });
    await expect(first).toBeVisible();

    // Out of signal, Tess starts and finishes the inspection; meanwhile the office gives the visit to Olivia.
    await context.setOffline(true);
    await first.click();
    await page.getByRole("button", { name: "Arrive and start inspection" }).click();
    await expect(page.getByRole("group", { name: "Aerator" })).toBeVisible();
    expect((await office.patch(`/api/jobs/${job.jobId}`, { data: { technicianId: techs.find((t) => t.name === "Olivia Owner")!.id } })).ok()).toBe(true);
    for (const pass of await page.getByRole("button", { name: "Pass", exact: true }).all()) await pass.click();
    await page.getByRole("group", { name: "Chlorine device" }).getByRole("button", { name: "Working" }).click();
    await page.getByLabel("Chlorine level").fill("1.5");
    await page.getByLabel("Air pressure").fill("4");
    await page.getByRole("group", { name: "Odor" }).getByRole("button", { name: "None" }).click();
    await page.getByRole("group", { name: "Pumping needed" }).getByRole("button", { name: "No" }).click();
    await page.getByLabel("Add photo: Overview of the unit").setInputFiles({ name: "overview.png", mimeType: "image/png", buffer: PNG });
    await page.getByLabel("Add photo: Chlorinator").setInputFiles({ name: "chlorinator.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: "Finish inspection" }).click();
    const stop = page.locator(".stop-card", { hasText: address });
    await expect(stop).toContainText("Done · not sent yet");

    // Back in signal: held for the office, photos included; the phone says so and stops editing.
    await context.setOffline(false);
    await page.getByRole("button", { name: "Try now" }).click({ timeout: 30_000 }).catch(() => {});
    await expect(stop).toContainText("Held for the office", { timeout: 60_000 });
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
    await stop.click();
    await page.getByRole("button", { name: "Continue inspection" }).click();
    await expect(page.getByTestId("inspection-held")).toContainText("given to another technician");
    const held = (await db.query("select id, status, offline_client_id from inspection_sync_conflicts where job_id = $1", [job.jobId])).rows[0] as { id: string; status: string; offline_client_id: string };
    expect(held.status).toBe("held");
    expect(Number((await db.query("select count(*) as n from attachments where inspection_client_id = $1 and inspection_id is null", [held.offline_client_id])).rows[0].n)).toBe(2);

    // The office accepts it from the inbox: the visit's inspection, completed, with both photos.
    const inbox = (await (await office.get("/api/inbox")).json()).items as { kind: string; target: { id: string } }[];
    expect(inbox.find((i) => i.kind === "inspection_held")?.target.id).toBe(held.id);
    expect((await office.post(`/api/inspections/conflicts/${held.id}/attach`, { data: {} })).ok()).toBe(true);
    const rows = (await db.query("select status, (select count(*)::int from attachments a where a.inspection_id = i.id) as photos from inspections i where job_id = $1", [job.jobId])).rows;
    expect(rows).toEqual([{ status: "completed", photos: 2 }]);
  } finally {
    await db.end();
  }
});
