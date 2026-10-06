import path from "node:path";
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

test("the office picks a workbook sheet, fixes a column, and the choice is remembered", async ({ page }) => {
  const workbook = path.join(import.meta.dirname, "fixtures", "two-sheets.xlsx");
  await page.goto("/login");
  await page.getByLabel("Email").fill("office@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  await page.goto("/import");
  await page.getByLabel("Spreadsheet").setInputFiles(workbook);
  await page.waitForURL(/\/import\/[0-9a-f-]{36}$/);
  const sheet = page.getByLabel("Sheet", { exact: true });
  // The preview opens on the sheet that looks like a customer list, not the notes.
  await expect(sheet).toHaveValue("1");
  await sheet.selectOption({ label: "Read me (1 row)" });
  await expect(page.locator(".tile", { hasText: "Rows" })).toContainText("1");
  await sheet.selectOption({ label: "Customers (2 rows)" });
  await expect(page.locator(".tile", { hasText: "Can't import" })).toContainText("2");

  await page.getByLabel("Service address").selectOption({ label: "Where" });
  await expect(page.locator(".tile", { hasText: "Ready" })).toContainText("2");
  await page.getByRole("button", { name: "Import 2 rows" }).click();
  await expect(page.getByText("Imported 2 new customers, 2 sites and 0 contracts")).toBeVisible();

  await page.goto("/import");
  await page.getByLabel("Spreadsheet").setInputFiles(workbook);
  await page.waitForURL(/\/import\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Columns were matched using the choices saved with your last import")).toBeVisible();
  await expect(page.locator(".tile", { hasText: "Duplicates" })).toContainText("2");
});

test("the office undoes an import it got wrong", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("office@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  await page.goto("/import");
  const csv = "Customer,Service Address,City\nUma Undo,1 Oops Ct,Austin\n";
  await page.getByLabel("Spreadsheet").setInputFiles({ name: "wrong.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.waitForURL(/\/import\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Import 1 row" }).click();
  // The summary of what came in: one site with no permit and no county, so no authority.
  await expect(page.getByText("1 customer with 1 service site from this import")).toBeVisible();
  await expect(page.locator(".tile", { hasText: "Missing permit numbers" })).toContainText("1");
  await expect(page.getByRole("link", { name: "1 Oops Ct, Austin" }).first()).toBeVisible();
  await expect(page.getByText("Undo deletes the 1 new customer, 1 site, 0 contracts and 0 visits")).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Undo import" }).click();
  await expect(page.getByText(/Undone .*Nothing this import created remains/)).toBeVisible();

  await page.goto("/import/summary");
  await expect(page.locator(".tile", { hasText: "Active contracts" })).toBeVisible();

  await page.goto("/customers");
  await page.getByPlaceholder(/search/i).fill("Uma Undo");
  await expect(page.getByText("Uma Undo")).toHaveCount(0);
});
