import { expect, test } from "@playwright/test";

test("a platform admin creates an organization in /admin, and the office sign-in cannot get there", async ({ page }) => {
  // Office staff are sent to the console's own sign-in, and their password does not work there.
  await page.goto("/admin");
  await page.waitForURL("**/admin/login?next=%2Fadmin");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Email or password is incorrect")).toBeVisible();

  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Organizations" })).toBeVisible();
  // The seeded demo company, with its contracts and three users.
  const demo = page.getByRole("row", { name: /Hill Country Aerobic Services/ });
  await expect(demo).toBeVisible();
  await expect(demo.getByRole("cell").nth(2)).toHaveText("3");

  await page.getByRole("button", { name: "New organization" }).click();
  await page.getByLabel("Company name").fill("Brazos Aerobic Co");
  await page.getByLabel("Office phone").fill("(979) 555-0100");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("status")).toHaveText("Created Brazos Aerobic Co.");
  const row = page.getByRole("row", { name: /Brazos Aerobic Co/ });
  await expect(row.getByRole("cell").nth(1)).toHaveText("0");
  await expect(row.getByRole("cell").nth(3)).toHaveText("Never");
});
