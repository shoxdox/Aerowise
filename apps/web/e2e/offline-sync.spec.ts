import { expect, test } from "@playwright/test";
import pg from "pg";

const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";

// A 1×1 PNG, enough for the browser to decode and re-encode.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"], serviceWorkers: "allow" });

test("two inspections done with no signal reach the office exactly once", async ({ page, context }) => {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const count = async (query: string) => Number((await db.query(query)).rows[0].n);

  try {
    // Morning, with signal: sign in and open the route so the phone saves it.
    await page.goto("/login");
    await page.getByLabel("Email").fill("tech@example.com");
    await page.getByLabel("Password").fill("aerowise-dev");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/tech");
    await expect(page.locator(".stop-card").first()).toBeVisible();
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.waitForFunction(async () => (await (await caches.open("aerowise-shell-v1")).keys()).length > 5);

    // At the site, no signal. The app still opens.
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    // The demo banner (the e2e API runs in demo mode) stays up with no signal.
    await expect(page.getByRole("note").filter({ hasText: "Fictional demo company. Nothing is emailed, texted, filed or charged" })).toBeVisible();
    const before = {
      inspections: await count("select count(*) as n from inspections"),
      attachments: await count("select count(*) as n from attachments"),
      completed: await count("select count(*) as n from audit_events where action = 'inspection.completed'"),
      filings: await count("select count(*) as n from filings"),
      jobsDone: await count("select count(*) as n from jobs j join service_obligations o on o.id = j.obligation_id where j.status = 'completed' and o.status = 'completed'"),
    };
    // Two inspections, both with photos, with no signal.
    const stops = [];
    for (let i = 0; i < 2; i++) {
      const card = page.locator(".stop-card", { hasText: "To do" }).first();
      const customer = await card.locator("strong").innerText();
      await card.click();
      await page.getByRole("button", { name: "Arrive and start inspection" }).click();

      await expect(page.getByRole("group", { name: "Aerator" })).toBeVisible();
      for (const pass of await page.getByRole("button", { name: "Pass", exact: true }).all()) await pass.click();
      await page.getByRole("group", { name: "Chlorine device" }).getByRole("button", { name: "Working" }).click();
      await page.getByLabel("Chlorine level").fill("1.5");
      // Optional in the template, required by the (fake) county some seeded sites are in.
      await page.getByLabel("Air pressure").fill("4");
      await page.getByRole("group", { name: "Odor" }).getByRole("button", { name: "None" }).click();
      await page.getByRole("group", { name: "Pumping needed" }).getByRole("button", { name: "No" }).click();

      if (i === 0) {
        // Finishing without photos is refused on the phone, with the reason.
        await page.getByRole("button", { name: "Finish inspection" }).click();
        await expect(page.locator(".problems")).toContainText("Overview of the unit: 1 more photo needed");
      }

      await page.getByLabel("Add photo: Overview of the unit").setInputFiles({ name: "overview.png", mimeType: "image/png", buffer: PNG });
      await page.getByLabel("Add photo: Chlorinator").setInputFiles({ name: "chlorinator.png", mimeType: "image/png", buffer: PNG });
      await expect(page.locator('[data-photo="chlorinator"]')).toContainText("1 taken");
      await page.getByRole("button", { name: "Finish inspection" }).click();

      const stop = page.locator(".stop-card", { hasText: customer });
      await expect(stop).toContainText("Done · not sent yet");
      stops.push(stop);
    }
    await expect(page.getByTestId("sync-status")).toContainText("No signal");

    // Closing and reopening the app with no signal loses nothing.
    await page.reload();
    for (const stop of stops) await expect(stop).toContainText("Done · not sent yet");
    expect(await count("select count(*) as n from inspections")).toBe(before.inspections);

    // Back in signal, the first answer to the completing request is lost on the way
    // back: the server records it but the phone never hears, so the phone sends it again.
    let dropped = 0;
    await context.route("**/api/inspections/sync", async (route) => {
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
    await page.getByRole("button", { name: "Try now" }).click({ timeout: 30_000 }).catch(() => {});
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
    for (const stop of stops) {
      await expect(stop).toContainText("Done");
      await expect(stop).not.toContainText("not sent");
    }

    // Exactly once on the server: two inspections, four photos, two completions.
    expect(await count("select count(*) as n from inspections")).toBe(before.inspections + 2);
    expect(await count("select count(*) as n from attachments")).toBe(before.attachments + 4);
    expect(await count("select count(*) as n from audit_events where action = 'inspection.completed'")).toBe(before.completed + 2);
    expect(await count("select count(*) as n from audit_events where action = 'inspection.completion_rejected'")).toBe(0);
    // Each completed inspection opened exactly one filing.
    expect(await count("select count(*) as n from filings")).toBe(before.filings + 2);
    expect(await count("select count(*) as n from jobs j join service_obligations o on o.id = j.obligation_id where j.status = 'completed' and o.status = 'completed'")).toBe(
      before.jobsDone + 2,
    );
  } finally {
    await db.end();
  }
});


test("finishing online while a draft sync is in flight preserves the readings, photos and completion", async ({ page, context }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("tech@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/tech");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  let clientId = "";
  let captured!: () => void;
  const draftCaptured = new Promise<void>(resolve => { captured = resolve; });
  await context.route("**/api/inspections/sync", async route => {
    if (first) {
      first = false;
      clientId = route.request().postDataJSON().clientId;
      const response = await route.fetch();
      captured();
      await held;
      await route.fulfill({ response });
    } else await route.continue();
  });
  const card = page.locator(".stop-card", { hasText: "To do" }).first();
  const customer = await card.locator("strong").innerText();
  await card.click();
  await page.getByRole("button", { name: "Arrive and start inspection" }).click();
  await draftCaptured;
  for (const pass of await page.getByRole("button", { name: "Pass", exact: true }).all()) await pass.click();
  await page.getByRole("group", { name: "Chlorine device" }).getByRole("button", { name: "Working" }).click();
  await page.getByLabel("Chlorine level").fill("1.5");
  await page.getByLabel("Air pressure").fill("4");
  await page.getByRole("group", { name: "Odor", exact: true }).getByRole("button", { name: "None" }).click();
  await page.getByRole("group", { name: "Pumping needed" }).getByRole("button", { name: "No", exact: true }).click();
  for (const key of ["Overview of the unit", "Chlorinator"]) {
    await page.getByLabel(`Add photo: ${key}`).setInputFiles({ name: "test.png", mimeType: "image/png", buffer: PNG });
  }
  await expect(page.locator('[data-photo="chlorinator"]')).toContainText("1 taken");
  await page.getByRole("button", { name: "Finish inspection" }).click();
  const stop = page.locator(".stop-card", { hasText: customer });
  await expect(stop).toContainText("Done · not sent yet");
  release();
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
  await expect(stop).toContainText("Done");
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const result = await db.query("select i.status, i.validation_status, (select count(*)::int from attachments a where a.inspection_id=i.id) as photos, (select count(*)::int from audit_events a where a.entity_id=i.id and a.action='inspection.completed') as completions from inspections i where i.offline_client_id=$1", [clientId]);
    expect(result.rows).toEqual([{ status: "completed", validation_status: "valid", photos: 2, completions: 1 }]);
  } finally { await db.end(); }
});
