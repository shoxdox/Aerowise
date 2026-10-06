import { expect, test } from "@playwright/test";

test("the owner asks for a full data export", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  await page.goto("/settings/export");
  await expect(page.getByText("No exports yet")).toBeVisible();
  await page.getByRole("button", { name: "Prepare an export" }).click();
  // The e2e run has no worker, so the export stays in the queue.
  await expect(page.getByRole("button", { name: "Preparing your export…" })).toBeDisabled();
  await expect(page.getByRole("cell", { name: "Preparing…" })).toBeVisible();
});
