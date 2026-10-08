import { expect, test, type Page } from "@playwright/test";

// SW-8: the e2e API runs with AEROWISE_FEATURES=work_orders,service_items,plan_builder
// (playwright.config.ts). Fictional plan, terms and customer throughout.

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");
}

test("the office gives a plan a coverage rule, and a work order at a site on it is billed at no charge", async ({ page }) => {
  await signIn(page);
  const stamp = Date.now().toString(36);
  const plan = await (await page.request.post("/api/plans", { data: { name: `Gold TEST ${stamp}`, termMonths: 12, visitsPerTerm: 2, priceCents: 40000 } })).json();

  await page.goto(`/plans/${plan.id}`);
  await page.getByRole("tab", { name: "Coverage" }).click();
  await expect(page.getByText("No coverage rules: this plan covers nothing.")).toBeVisible();
  await page.getByRole("button", { name: "Add rule" }).click();
  const rule = page.getByTestId("coverage-rule");
  await rule.getByLabel("Name", { exact: true }).fill("Repairs");
  await rule.getByRole("combobox", { name: /^Kind of work/ }).selectOption({ label: "Repair" });
  await rule.getByRole("combobox", { name: /^Effect/ }).selectOption({ label: "No charge" });
  await rule.getByLabel(/Work orders per term/).fill("1");
  await page.getByRole("button", { name: "Save as version 2" }).click();
  await expect(page.getByText("Saved as version 2.")).toBeVisible();
  await page.getByRole("tab", { name: "Preview agreement" }).click();
  await expect(page.getByTestId("agreement-preview")).toContainText("Repairs: Repair work, no charge, up to 1 work order per term");
  await page.getByRole("tab", { name: "Versions" }).click();
  await expect(page.getByRole("row")).toHaveCount(3);

  // A fictional customer with a site on that plan from today.
  const { today } = await (await page.request.get("/api/obligations/due?limit=1")).json();
  const customer = await (await page.request.post("/api/customers", { data: { displayName: `Coverage TEST ${stamp}` } })).json();
  const site = await (await page.request.post(`/api/customers/${customer.id}/sites`, { data: { addressLine1: "9 Fictional Ln", city: "Austin" } })).json();
  const contract = await page.request.post(`/api/sites/${site.id}/contracts`, { data: { planId: plan.id, startOn: today } });
  expect(contract.status()).toBe(201);
  await page.goto(`/sites/${site.id}`);
  await expect(page.getByTestId("contract-coverage")).toContainText("Repairs: Repair work, no charge, up to 1 work order per term");
  await expect(page.getByTestId("contract-coverage")).toContainText("0 of 1 used");

  const types = await (await page.request.get("/api/work-types")).json();
  const repair = types.items.find((t: { key: string }) => t.key === "repair");
  const wo = await (
    await page.request.post("/api/work-orders", {
      data: { siteId: site.id, workTypeId: repair.id, requestedOn: today, lines: [{ description: "Replace air pump", quantity: 1, unitPriceCents: 25000 }] },
    })
  ).json();
  await page.goto(`/work/${wo.id}`);
  const coverage = page.getByTestId("work-coverage");
  await expect(coverage).toContainText(`Gold TEST ${stamp}`);
  await coverage.getByRole("button", { name: "Apply coverage" }).click();
  await expect(coverage).toContainText("applied");
  await expect(coverage).toContainText("1 of 1 used this term");

  await page.getByRole("button", { name: "Create invoice" }).click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
  const invoiceId = page.url().split("/").pop()!;
  const invoice = await (await page.request.get(`/api/invoices/${invoiceId}`)).json();
  expect(invoice.lines).toEqual([expect.objectContaining({ description: `Replace air pump (Covered by Gold TEST ${stamp}: Repairs)`, unitPriceCents: 0, amountCents: 0 })]);
});
