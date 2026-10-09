import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// SW-12 plan §12 row 5: an inspection issue found on the phone and a request a homeowner sent from
// the portal are each turned into work twice by the office, from two inbox tabs opened before
// either click. Each makes exactly one work order, and the history shows on both sides: the inbox
// item links its work order and the source records one conversion; the work order names its
// source and its timeline says where it came from.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });

async function signIn(page: Page, email: string, landing: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`**${landing}`);
}

/** Tess finishes her next inspection on the phone and records one issue. */
async function inspectWithIssue(browser: Browser, description: string) {
  const phone = await (await browser.newContext({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] })).newPage();
  await signIn(phone, "tech@example.com", "/tech");
  const stop = phone.locator(".stop-card", { hasText: "To do" }).first();
  await stop.click();
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
  await phone.getByRole("button", { name: "Add issue" }).click();
  await phone.getByLabel("Issue type").selectOption("repair_needed");
  await phone.getByLabel("Severity").selectOption("medium");
  await phone.getByLabel("Issue description").fill(description);
  await phone.getByRole("button", { name: "Finish inspection" }).click();
  await expect(phone.locator(".stop-card").filter({ hasText: "Done" }).first()).toBeVisible();
  await expect(phone.getByText("not sent")).toHaveCount(0);
  await phone.context().close();
}

/** A homeowner with a portal link asks for service from the portal. */
async function portalRequest(page: Page, browser: Browser, description: string) {
  const due = await (await page.request.get("/api/obligations/due?limit=50")).json();
  let customerId: string | undefined;
  for (const o of due.items as { customer: { id: string } }[]) {
    if ((await (await page.request.get(`/api/customers/${o.customer.id}/portal`)).json()).email) {
      customerId = o.customer.id;
      break;
    }
  }
  expect(customerId).toBeTruthy();
  await page.goto(`/customers/${customerId}`);
  await page.getByRole("button", { name: "Copy portal link" }).click();
  const url = (await page.locator(".portal-url").textContent())!;
  const homeowner = await (await browser.newContext()).newPage();
  await homeowner.goto(new URL(url).pathname);
  await homeowner.getByRole("button", { name: "Request service" }).first().click();
  await homeowner.getByLabel("What do you need?").selectOption("alarm");
  await homeowner.getByLabel("Tell us more").fill(description);
  await homeowner.getByRole("button", { name: "Send request" }).click();
  await expect(homeowner.getByText("Thanks, we have your request")).toBeVisible();
  await homeowner.context().close();
}

test("an inspection issue and a portal request, each turned into work from two tabs, make one work order each with history on both sides", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const tag = crypto.randomUUID().slice(0, 8);
  const issueText = `Row 5 issue ${tag}: effluent pump hums`;
  const requestText = `Row 5 request ${tag}: alarm light is on`;
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const count = async (q: string, params: unknown[]) => Number((await db.query(q, params)).rows[0].n);

  try {
    await inspectWithIssue(browser, issueText);
    await signIn(page, "owner@example.com", "/inbox");
    await portalRequest(page, browser, requestText);
    const issueId = (await db.query("select id from issues where description = $1", [issueText])).rows[0].id as string;
    const requestRow = (await db.query("select id, source from service_requests where description = $1", [requestText])).rows[0] as { id: string; source: string };
    expect(requestRow.source).toBe("portal");

    const sources = [
      { kind: "issue", id: issueId, text: issueText, audit: "issue.work_order_created", from: "Repair needed", created: "Created from an inspection issue: Repair needed" },
      { kind: "request", id: requestRow.id, text: requestText, audit: "service_request.work_order_created", from: "Customer request: alarm", created: "Created from the customer's request of" },
    ];
    for (const s of sources) {
      // Two inbox tabs, both open before either click, so the second click is on a stale page.
      const second = await page.context().newPage();
      await page.goto("/inbox");
      await second.goto("/inbox");
      const first = page.locator("li.card").filter({ hasText: s.text });
      const stale = second.locator("li.card").filter({ hasText: s.text });
      await expect(first.getByRole("button", { name: "Turn into work order" })).toBeVisible();
      await expect(stale.getByRole("button", { name: "Turn into work order" })).toBeVisible();

      await first.getByRole("button", { name: "Turn into work order" }).click();
      await page.waitForURL(/\/work\/[0-9a-f-]{36}$/);
      await stale.getByRole("button", { name: "Turn into work order" }).click();
      await second.waitForURL(/\/work\/[0-9a-f-]{36}$/);
      const id = page.url().split("/").pop()!;
      expect(second.url().split("/").pop(), `${s.kind}: the second click opens the same work order`).toBe(id);
      await second.close();

      // One work order for the source, and the source records one conversion.
      expect(await count("select count(*) as n from work_orders where source_id = $1", [s.id])).toBe(1);
      expect(await count("select count(*) as n from audit_events where action = $1 and entity_id = $2", [s.audit, s.id])).toBe(1);

      // The work order's side: where it came from, in its details and its timeline.
      const wo = await (await page.request.get(`/api/work-orders/${id}`)).json();
      await expect(page.getByRole("heading", { name: new RegExp(`${wo.label} ·`) })).toBeVisible();
      const from = page.locator("dt", { hasText: "From" }).locator("xpath=following-sibling::dd[1]");
      await expect(from).toContainText(s.from);
      await expect(from.getByRole("link")).toBeVisible();
      await expect(page.getByTestId("work-timeline")).toContainText(s.created);

      // The source's side: the inbox item now links its work order instead of offering another.
      await page.goto("/inbox");
      await expect(first.getByRole("link", { name: wo.label, exact: true })).toBeVisible();
      await expect(first.getByRole("button", { name: "Turn into work order" })).toHaveCount(0);
      await first.getByRole("link", { name: wo.label, exact: true }).click();
      await page.waitForURL(`**/work/${id}`);
    }
  } finally {
    await db.end();
  }
});
