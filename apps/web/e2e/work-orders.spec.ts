import { expect, test, type Page } from "@playwright/test";

// SW-1: the e2e API runs with AEROWISE_FEATURES=work_orders (playwright.config.ts).

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");
}

test("the office creates, schedules and completes a work order, and the schedule shows its kind", async ({ page }) => {
  await signIn(page);
  const sites = await (await page.request.get("/api/sites?limit=1")).json();
  const site = sites.items[0] as { id: string; addressLine1: string };

  await page.goto(`/sites/${site.id}`);
  await page.getByRole("link", { name: "Create work order" }).click();
  await page.waitForURL(/\/work\/new\?siteId=/);
  await page.getByRole("combobox", { name: "Kind of work" }).selectOption({ label: "Repair" });
  await page.getByRole("textbox", { name: /^Title/ }).fill("Replace the float switch");
  await page.getByLabel("What needs doing").fill("Alarm stays on after the pump runs.");
  await page.getByLabel("Line description").fill("Float switch");
  await page.getByLabel("Unit price in dollars").fill("85.50");
  await page.getByRole("button", { name: "Create work order" }).click();
  await page.waitForURL(/\/work\/[0-9a-f-]{36}$/);
  const workOrderId = page.url().split("/").pop()!;
  await expect(page.getByRole("heading", { name: /WO-\d+ · Replace the float switch/ })).toBeVisible();
  await expect(page.getByTestId("work-status")).toHaveText("Ready to schedule");
  await expect(page.getByText("$85.50").first()).toBeVisible();

  const { today } = await (await page.request.get("/api/obligations/due?limit=1")).json();
  await page.getByLabel("Visit date").fill(today);
  await page.getByRole("button", { name: "Schedule visit" }).click();
  await expect(page.getByTestId("work-status")).toHaveText("Scheduled");
  await expect(page.locator(".card strong").filter({ hasText: "Visit 1" })).toBeVisible();

  // The office schedule lists it beside inspections, with its kind and number.
  const wo = await (await page.request.get(`/api/work-orders/${workOrderId}`)).json();
  await page.goto("/schedule");
  await expect(page.getByTestId("stop-kind").filter({ hasText: `Repair · ${wo.label}` })).toBeVisible();

  // Done on a paper ticket until the phone gets its work form.
  await page.goto(`/work/${workOrderId}`);
  await page.getByRole("button", { name: "Complete without a field record" }).click();
  await page.getByLabel(/How was it done/).fill("Recorded on the paper ticket");
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(page.getByTestId("work-status")).toHaveText("Completed");
  await expect(page.getByTestId("work-timeline")).toContainText("Completed by the office without a field record");

  // It never reached a filing.
  const filings = await (await page.request.get("/api/filings?view=all")).json();
  expect(JSON.stringify(filings)).not.toContain(workOrderId);
});

test("a customer's request in the inbox becomes one work order however often it is turned", async ({ page }) => {
  await signIn(page);
  const sites = await (await page.request.get("/api/sites?limit=1")).json();
  const siteId = sites.items[0].id as string;
  const created = await page.request.post("/api/service-requests", { data: { siteId, kind: "pumping", description: "Due for a pump-out, please call.", receivedAt: new Date().toISOString() } });
  expect(created.ok()).toBeTruthy();
  const request = await created.json();

  await page.goto("/inbox");
  const item = page.locator("li.card").filter({ hasText: "Due for a pump-out, please call." });
  await item.getByRole("button", { name: "Turn into work order" }).click();
  await page.waitForURL(/\/work\/[0-9a-f-]{36}$/);
  const first = page.url().split("/").pop()!;
  await expect(page.getByText("Pumping").first()).toBeVisible();

  // The inbox now links to it instead, and asking the API again finds the same order.
  await page.goto("/inbox");
  await expect(item.getByRole("link", { name: /^WO-\d+$/ })).toBeVisible();
  const again = await page.request.post(`/api/service-requests/${request.id}/work-order`, { data: {} });
  expect(again.status()).toBe(200);
  expect((await again.json()).id).toBe(first);
});
