import { expect, test } from "@playwright/test";
import pg from "pg";

const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// No location permission: the browser answers every position request with "denied".
test.use({ permissions: [], serviceWorkers: "allow" });

/**
 * A technician whose phone has location turned off for the app is told so on the stop, and the
 * office learns it with the inspection, instead of a visit that silently has no GPS.
 */
test("a visit started with location denied says so on the phone and reaches the office as denied", async ({ page, browser }) => {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await page.goto("/login");
    await page.getByLabel("Email").fill("tech@example.com");
    await page.getByLabel("Password").fill("aerowise-dev");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/tech");
    await expect(page.locator(".stop-card").first()).toBeVisible();

    // A stop of its own on Tess's route today, so the seeded route is left as it is. It has
    // coordinates (no worker geocodes sites in these tests) because the map specs expect every
    // stop on the route to have a marker.
    const office = (await browser.newContext()).request;
    expect((await office.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
    const customer = await (await office.post("/api/customers", { data: { displayName: "Location denied check" } })).json();
    const address = "78 Fixture Rd";
    const site = await (await office.post(`/api/customers/${customer.id}/sites`, { data: { addressLine1: address, city: "Blanco", state: "TX", postalCode: "78606", county: "Example County", permitNumber: "DEMO-078078", lat: 30.1, lng: -98.42 } })).json();
    expect((await office.post(`/api/sites/${site.id}/systems`, { data: { manufacturer: "Acme", chlorinationMethod: "tablet" } })).status()).toBe(201);
    const plan = ((await (await office.get("/api/plans")).json()).items as { id: string; name: string }[]).find((p) => p.name === "Residential annual")!;
    const { today } = (await (await office.get("/api/obligations/due?limit=1")).json()) as { today: string };
    const contract = await (await office.post(`/api/sites/${site.id}/contracts`, { data: { planId: plan.id, startOn: today } })).json();
    const techs = (await (await office.get("/api/technicians")).json()).items as { id: string; name: string }[];
    const booked = await office.post("/api/jobs", { data: { obligationId: contract.obligations[0].id, technicianId: techs.find((t) => t.name === "Tess Tech")!.id, scheduledDate: today } });
    expect(booked.status()).toBe(201);
    const job = (await booked.json()) as { jobId: string };
    await page.getByRole("button", { name: "Refresh" }).click();
    const stop = page.locator(".stop-card", { hasText: address });
    await expect(stop).toBeVisible();

    // Arriving asks for the position; the phone says no, and the form says so.
    await stop.click();
    await page.getByRole("button", { name: "Arrive and start inspection" }).click();
    await expect(page.getByTestId("inspection-location")).toContainText("Location is off for Aerowise on this phone");
    for (const pass of await page.getByRole("button", { name: "Pass", exact: true }).all()) await pass.click();
    await page.getByRole("group", { name: "Chlorine device" }).getByRole("button", { name: "Working" }).click();
    await page.getByLabel("Chlorine level").fill("1.5");
    await page.getByLabel("Air pressure").fill("4");
    await page.getByRole("group", { name: "Odor" }).getByRole("button", { name: "None" }).click();
    await page.getByRole("group", { name: "Pumping needed" }).getByRole("button", { name: "No" }).click();
    await page.getByLabel("Add photo: Overview of the unit").setInputFiles({ name: "overview.png", mimeType: "image/png", buffer: PNG });
    await page.getByLabel("Add photo: Chlorinator").setInputFiles({ name: "chlorinator.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: "Finish inspection" }).click();
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });

    // The office's copy carries the reason, not just a missing position.
    const insp = (await (await office.get(`/api/jobs/${job.jobId}/inspection`)).json()) as { status: string; arrivalLat: number | null; locationStatus: string };
    expect(insp).toMatchObject({ status: "completed", arrivalLat: null, locationStatus: "denied" });
    const row = await db.query("select location_status from inspections where job_id = $1", [job.jobId]);
    expect(row.rows).toEqual([{ location_status: "denied" }]);
  } finally {
    await db.end();
  }
});
