import { expect, test } from "@playwright/test";

test("the owner connects QuickBooks, reviews customer matches and starts syncing", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  // Connect the built-in test company.
  await page.goto("/quickbooks");
  await page.getByRole("button", { name: "Connect QuickBooks" }).click();
  await page.waitForURL(/\/quickbooks\?connected=1/);
  await expect(page.locator(".badge", { hasText: "Connected" })).toBeVisible();
  await expect(page.locator(".badge", { hasText: "Test company" })).toBeVisible();

  // Invoice lines go to QuickBooks as "Services".
  await page.locator('select[name="defaultItem"]').selectOption({ label: "Services" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  // The review reads QuickBooks on the first visit and asks about the uncertain ones.
  await page.getByRole("link", { name: "Review customer matches" }).click();
  await page.waitForURL("**/quickbooks/review");
  await expect(page.getByText(/compared your customers with the 7 active customers/)).toBeVisible();
  const needChoice = page.locator(".tile", { hasText: "Need a choice" }).locator("strong");
  await expect(needChoice).not.toHaveText("0");
  const before = Number(await needChoice.textContent());
  const uncertain = page.getByTestId("review-row").filter({ has: page.locator(".badge.warn", { hasText: "Check this" }) }).first();
  await uncertain.getByRole("radio", { name: /^Link to/ }).first().check();
  await expect(needChoice).toHaveText(String(before - 1));

  // Anything left undecided waits in the conflict center.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Start syncing" }).click();
  await page.waitForURL(/\/quickbooks$/);
  await expect(page.getByRole("heading", { name: "Sync health" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs a decision" })).toBeVisible();
  if (before - 1 > 0) await expect(page.getByTestId("qb-record").first()).toContainText("Possible match in QuickBooks");
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
});
