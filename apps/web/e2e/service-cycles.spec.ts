import { expect, test, type Page } from "@playwright/test";

// SW-9: the e2e API runs with service_cycles on (playwright.config.ts). A plan gets a pumping
// cycle in the builder; the contract shows it, and its visit is booked as a work order.
// Fictional plan and customer throughout.

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");
}

test("the office adds pumping visits to a plan, and a contract's pumping visit is booked as a work order, never an inspection", async ({ page }) => {
  await signIn(page);
  const stamp = Date.now().toString(36);
  const plan = await (await page.request.post("/api/plans", { data: { name: `Pump Plus TEST ${stamp}`, termMonths: 12, visitsPerTerm: 2, priceCents: 40000 } })).json();

  await page.goto(`/plans/${plan.id}`);
  await page.getByRole("tab", { name: "Service" }).click();
  await expect(page.getByText("No pumping or maintenance visits.")).toBeVisible();
  await page.getByRole("button", { name: "Add pumping or maintenance visits" }).click();
  const cycle = page.getByTestId("plan-cycle");
  await cycle.getByLabel("Name", { exact: true }).fill("Tank pumping");
  await cycle.getByRole("combobox", { name: /^Booked as/ }).selectOption({ label: "Pumping" });
  await cycle.getByLabel(/^Every \(months\)/).fill("6");
  await page.getByRole("button", { name: "Save as version 2" }).click();
  await expect(page.getByText("Saved as version 2.")).toBeVisible();
  await page.getByRole("tab", { name: "Preview agreement" }).click();
  await expect(page.getByTestId("agreement-preview")).toContainText("Tank pumping");

  const { today } = await (await page.request.get("/api/obligations/due?limit=1")).json();
  const customer = await (await page.request.post("/api/customers", { data: { displayName: `Cycles TEST ${stamp}` } })).json();
  const site = await (await page.request.post(`/api/customers/${customer.id}/sites`, { data: { addressLine1: "12 Fictional Ln", city: "Austin" } })).json();
  const contract = await page.request.post(`/api/sites/${site.id}/contracts`, { data: { planId: plan.id, startOn: today } });
  expect(contract.status(), await contract.text()).toBe(201);

  await page.goto(`/sites/${site.id}`);
  await expect(page.getByTestId("contract-cycles")).toContainText("Tank pumping: Every 6 months");
  const visits = page.getByTestId("cycle-visit");
  await expect(visits).toHaveCount(2);
  await expect(visits.first()).toContainText("Tank pumping #1");
  await visits.first().getByRole("button", { name: "Book work" }).click();
  await page.waitForURL(/\/work\/[0-9a-f-]{36}$/);
  const workOrderId = page.url().split("/").pop()!;
  const wo = await (await page.request.get(`/api/work-orders/${workOrderId}`)).json();
  expect(wo.category).toBe("pumping");

  // Back on the site the visit names its order, and the next one can still be booked.
  await page.goto(`/sites/${site.id}`);
  await expect(visits.first().getByRole("link")).toContainText(wo.label ?? "");
  await expect(visits.first().getByRole("button", { name: "Book work" })).toHaveCount(0);
  await expect(visits.nth(1).getByRole("button", { name: "Book work" })).toBeVisible();

  // The due list keeps inspections by default; pumping visits are their own list.
  await page.goto("/due");
  await expect(page.getByRole("heading", { name: "Due inspections" })).toBeVisible();
  await page.getByRole("combobox", { name: "Type of visit" }).selectOption({ label: "Pumping" });
  await expect(page.getByRole("heading", { name: "Due pumping visits" })).toBeVisible();
});
