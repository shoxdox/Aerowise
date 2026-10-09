import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";

// A 1×1 PNG, enough for the browser to decode and re-encode.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"], serviceWorkers: "allow" });

async function signInAsTech(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("tech@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/tech");
  await expect(page.locator(".stop-card").first()).toBeVisible();
}

/**
 * The phone dies half-way through a stop and the technician carries on from the office spare:
 * the second phone continues the inspection the first one started, under the same id, instead
 * of starting a second one the server would refuse (which used to strand the whole visit).
 */
test("an inspection started on one phone is continued, not duplicated, on another", async ({ page, browser }) => {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    // Phone 1: start the first stop, answer a few things, and let it reach the office.
    await signInAsTech(page);
    const card = page.locator(".stop-card", { hasText: "To do" }).first();
    await card.click();
    await page.getByRole("button", { name: "Arrive and start inspection" }).click();
    await expect(page.getByRole("group", { name: "Aerator" })).toBeVisible();
    await page.getByRole("group", { name: "Aerator" }).getByRole("button", { name: "Pass", exact: true }).click();
    await page.getByLabel("Air pressure").fill("4");
    await page.getByLabel("Add photo: Overview of the unit").setInputFiles({ name: "overview.png", mimeType: "image/png", buffer: PNG });
    await expect(page.locator('[data-photo="overview"]')).toContainText("1 taken");
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    // The stop is found by its address below: the seed repeats customer names across sites.
    const started = (await db.query("select i.job_id, s.address_line1 from inspections i join sites s on s.id = i.site_id where i.status = 'draft' order by i.created_at desc limit 1")).rows[0] as { job_id: string; address_line1: string };
    expect(started).toBeTruthy();
    const jobId = started.job_id;
    await page.context().close();

    // Phone 2: a fresh browser profile, nothing of phone 1 on it.
    const phone2 = await browser.newContext({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });
    const p2 = await phone2.newPage();
    await signInAsTech(p2);
    const stop = p2.locator(".stop-card", { hasText: started.address_line1 });
    await expect(stop).toContainText("In progress · on another phone");
    await stop.click();
    await p2.getByRole("button", { name: "Continue inspection" }).click();

    // Phone 1's answers and its uploaded photo are there to carry on from.
    await expect(p2.getByRole("group", { name: "Aerator" }).getByRole("button", { name: "Pass", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(p2.getByLabel("Air pressure")).toHaveValue("4");
    await expect(p2.locator('[data-photo="overview"]')).toContainText("1 taken");
    // The rest of the form (a pressed Pass toggles off, so only the unanswered groups are clicked).
    for (const pass of await p2.getByRole("button", { name: "Pass", exact: true }).all()) {
      if ((await pass.getAttribute("aria-pressed")) !== "true") await pass.click();
    }
    await p2.getByRole("group", { name: "Chlorine device" }).getByRole("button", { name: "Working" }).click();
    await p2.getByLabel("Chlorine level").fill("1.5");
    await p2.getByRole("group", { name: "Odor" }).getByRole("button", { name: "None" }).click();
    await p2.getByRole("group", { name: "Pumping needed" }).getByRole("button", { name: "No" }).click();
    await p2.getByLabel("Add photo: Chlorinator").setInputFiles({ name: "chlorinator.png", mimeType: "image/png", buffer: PNG });
    await p2.getByRole("button", { name: "Finish inspection" }).click();
    await expect(p2.locator(".stop-card", { hasText: started.address_line1 })).toContainText("Done", { timeout: 30_000 });
    await expect(p2.getByTestId("sync-status")).toHaveText("All changes sent");

    // Exactly one inspection for the job, completed, with both phones' photos.
    const rows = (await db.query("select status from inspections where job_id = $1", [jobId])).rows;
    expect(rows).toEqual([{ status: "completed" }]);
    expect(Number((await db.query("select count(*) as n from attachments a join inspections i on i.id = a.inspection_id where i.job_id = $1", [jobId])).rows[0].n)).toBe(2);
    await phone2.close();
  } finally {
    await db.end();
  }
});
