import { expect, test, type Page } from "@playwright/test";

// SW-3: the e2e API runs with AEROWISE_FEATURES=work_orders,service_items (playwright.config.ts),
// so the demo story has given the company a small catalog.

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");
}

test("the office adds a service item, bills a work order by the hour from it, and gets one invoice", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Service items" }).first().click();
  await page.waitForURL("**/settings/service-items");
  await expect(page.getByTestId("service-items")).toContainText("Labor");
  await page.getByLabel("Name").fill("Diagnostic hour");
  await page.getByLabel("Price ($)").fill("110");
  await page.getByLabel("Charged").selectOption({ label: "per hour" });
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByTestId("service-items")).toContainText("Diagnostic hour");
  await expect(page.getByTestId("service-items")).toContainText("$110.00 per hour");

  const sites = await (await page.request.get("/api/sites?limit=1")).json();
  await page.goto(`/work/new?siteId=${sites.items[0].id}`);
  await page.getByRole("combobox", { name: "Kind of work" }).selectOption({ label: "Repair" });
  await page.getByRole("textbox", { name: /^Title/ }).fill("Find the alarm fault");
  await page.getByRole("combobox", { name: "Service item" }).selectOption({ label: "Diagnostic hour ($110.00 per hour)" });
  await page.getByLabel("Quantity").fill("1.25");
  await page.getByRole("button", { name: "Create work order" }).click();
  await page.waitForURL(/\/work\/[0-9a-f-]{36}$/);
  const workOrderId = page.url().split("/").pop()!;
  // 1.25 hours at $110.00.
  await expect(page.getByText("$137.50").first()).toBeVisible();

  const { today } = await (await page.request.get("/api/obligations/due?limit=1")).json();
  await page.getByLabel("Visit date").fill(today);
  await page.getByRole("button", { name: "Schedule visit" }).click();
  await page.getByRole("button", { name: "Complete without a field record" }).click();
  await page.getByLabel(/How was it done/).fill("TEST paper ticket");
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(page.getByTestId("work-status")).toHaveText("Completed");

  await page.getByRole("button", { name: "Create invoice" }).click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
  const invoiceId = page.url().split("/").pop()!;
  await expect(page.getByText("$137.50").first()).toBeVisible();
  const invoice = await (await page.request.get(`/api/invoices/${invoiceId}`)).json();
  expect(invoice.lines).toEqual([expect.objectContaining({ description: "Diagnostic hour", quantity: 1.25, quantityMilli: 1250, amountCents: 13750 })]);

  // The order is invoiced; asking again finds the same draft.
  await page.goto(`/work/${workOrderId}`);
  await expect(page.getByRole("button", { name: "Create invoice" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Draft · \$137\.50 · draft/ })).toBeVisible();
  const again = await page.request.post(`/api/work-orders/${workOrderId}/invoice`, { data: {} });
  expect(again.status()).toBe(200);
  expect((await again.json()).invoiceId).toBe(invoiceId);
});
