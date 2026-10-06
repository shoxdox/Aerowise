import { expect, test } from "@playwright/test";

// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("the owner sets the company's service counties and logo", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  await page.goto("/settings/company");
  await expect(page.getByLabel("Company name")).toHaveValue("Hill Country Aerobic Services (demo)");
  await page.getByLabel("Service counties").fill("Example County\nSample County");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");

  await expect(page.getByText("No logo yet.")).toBeVisible();
  await page.getByLabel("Logo file").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByRole("img", { name: "Company logo" })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Service counties")).toHaveValue("Example County\nSample County");
});
