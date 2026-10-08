import { expect, test, type Page } from "@playwright/test";

// SW-5a: the e2e API runs with AEROWISE_FEATURES=work_orders,estimates (playwright.config.ts).

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");
}

test("the office sends an estimate, the homeowner picks options and signs, and it becomes a work order", async ({ page, browser }) => {
  await signIn(page);
  const sites = await (await page.request.get("/api/sites?limit=1")).json();
  const site = sites.items[0] as { id: string };

  await page.goto(`/sites/${site.id}`);
  await page.getByRole("link", { name: "Create estimate" }).click();
  await page.waitForURL(/\/estimates\/new\?siteId=/);
  await page.getByRole("combobox", { name: /^Kind of work/ }).selectOption({ label: "Repair" });
  await page.getByRole("textbox", { name: /^Title/ }).fill("Replace the aerator");
  await page.getByLabel("Line 1 description").fill("Aerator, installed");
  await page.getByLabel("Line 1 unit price").fill("400");
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByLabel("Line 2 description").fill("Alarm upgrade");
  await page.getByLabel("Line 2 unit price").fill("120");
  await page.getByLabel("Line 2 optional").check();
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.waitForURL(/\/estimates\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /EST-\d+ · Replace the aerator/ })).toBeVisible();
  await expect(page.getByTestId("estimate-status")).toHaveText("Draft");

  // Shared by the office rather than emailed, then a link to give the homeowner.
  await page.getByRole("button", { name: /Mark sent/ }).click();
  await expect(page.getByTestId("estimate-status")).toHaveText("Sent");
  await expect(page.getByTestId("estimate-total")).toHaveText("$520.00");
  await page.getByRole("button", { name: "Copy a link" }).click();
  const url = await page.getByTestId("estimate-link").innerText();
  const path = new URL(url).pathname;

  // The homeowner, signed out, leaves the option out and signs.
  const home = await browser.newContext();
  const homeowner = await home.newPage();
  await homeowner.goto(path);
  await expect(homeowner.getByRole("heading", { name: "Replace the aerator" })).toBeVisible();
  await expect(homeowner.getByTestId("estimate-total")).toHaveText("$520.00");
  await homeowner.getByRole("checkbox", { name: /Alarm upgrade/ }).uncheck();
  await expect(homeowner.getByTestId("estimate-total")).toHaveText("$400.00");
  await homeowner.getByLabel("Your full name").fill("Pat Homeowner");
  await homeowner.getByRole("checkbox", { name: /I have read this estimate/ }).check();
  await homeowner.getByRole("button", { name: /Accept for \$400\.00/ }).click();
  await expect(homeowner.getByRole("heading", { name: "Estimate accepted" })).toBeVisible();
  await expect(homeowner.getByTestId("estimate-outcome")).not.toContainText("Alarm upgrade");
  await home.close();

  // The office sees the signature and the work order it became.
  await page.reload();
  await expect(page.getByTestId("estimate-status")).toHaveText("Accepted");
  await expect(page.getByTestId("estimate-acceptance")).toContainText("Signed by Pat Homeowner");
  await page.getByRole("link", { name: /^WO-\d+$/ }).click();
  await page.waitForURL(/\/work\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Aerator, installed").first()).toBeVisible();
  await expect(page.getByText("Alarm upgrade")).toHaveCount(0);
});

test("an inspection issue or request in the inbox drafts one estimate however often it is pressed", async ({ page }) => {
  await signIn(page);
  const sites = await (await page.request.get("/api/sites?limit=1")).json();
  const siteId = sites.items[0].id as string;
  const created = await page.request.post("/api/service-requests", { data: { siteId, kind: "repair", description: "Alarm keeps sounding, please quote a fix.", receivedAt: new Date().toISOString() } });
  expect(created.ok()).toBeTruthy();
  const request = await created.json();

  await page.goto("/inbox");
  const item = page.locator("li.card").filter({ hasText: "Alarm keeps sounding, please quote a fix." });
  await item.getByRole("button", { name: "Estimate" }).click();
  await page.waitForURL(/\/estimates\/[0-9a-f-]{36}$/);
  const first = page.url().split("/").pop()!;
  await expect(page.getByTestId("estimate-status")).toHaveText("Draft");

  const again = await page.request.post(`/api/service-requests/${request.id}/estimate`, { data: {} });
  expect(again.status()).toBe(200);
  expect((await again.json()).id).toBe(first);
});
