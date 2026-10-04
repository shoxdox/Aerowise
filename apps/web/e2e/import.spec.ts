import { expect, test } from "@playwright/test";

const CSV = [
  "Customer,Service Address,City,Zip,Permit #,Phone,Plan,Start Date",
  "Ivy Import,10 Import Way,Austin,78701,IMP-1,512-555-0190,Residential annual,4/1/2026",
  "Ivy Import,12 Import Way,Austin,78701,,512-555-0190,,",
  "No Address,,Austin,78701,,,,",
  "Ivy Twice,10 Import Way.,Austin,78701,,,,",
].join("\n");

test("the office previews a CSV, sees its problems, and imports it", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("office@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  await page.goto("/import");
  await page.getByLabel("Spreadsheet").setInputFiles({ name: "customers.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await page.waitForURL(/\/import\/[0-9a-f-]{36}$/);

  await expect(page.locator(".tile", { hasText: "Ready" })).toContainText("2");
  await expect(page.locator(".tile", { hasText: "Duplicates" })).toContainText("1");
  await expect(page.locator(".tile", { hasText: "Can't import" })).toContainText("1");
  await expect(page.getByText("No service address")).toBeVisible();
  await expect(page.getByText("Same as Row 2")).toBeVisible();

  await page.getByRole("button", { name: "Import 2 rows" }).click();
  await expect(page.getByText("Imported 1 new customer, 2 sites and 1 contract")).toBeVisible();

  await page.goto("/customers");
  await page.getByPlaceholder(/search/i).fill("Ivy Import");
  await expect(page.getByRole("link", { name: "Ivy Import" })).toBeVisible();
});
