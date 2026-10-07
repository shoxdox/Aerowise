import { expect, test } from "@playwright/test";

test("the owner sees what the company pays Aerowise and saves a card", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  await page.goto("/settings/subscription");
  await expect(page.getByRole("heading", { name: "Aerowise subscription" })).toBeVisible();
  // The demo company is a paying account; the estimate follows its active contracts.
  await expect(page.getByTestId("plan-line")).toHaveText("Active");
  await expect(page.getByTestId("estimate")).toContainText(/estimated for \d+ active contracts as of/);
  await expect(page.getByTestId("payment-method")).toContainText("No test payment method saved yet. Adding one only simulates monthly billing.");

  // The test provider stands in for Stripe's page and comes straight back.
  await page.getByRole("button", { name: "Add payment method" }).click();
  await page.waitForURL("**/settings/subscription?payment=test");
  await expect(page.getByTestId("payment-method")).toHaveText("Visa ending 4242, expires 12/2034");
  await expect(page.getByRole("button", { name: "Change payment method" })).toBeVisible();
});
