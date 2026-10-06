import { expect, test } from "@playwright/test";

// The demo's five-minute path (W10.3): the seed plus the demo story leave the owner with a
// record of every step of the work, so none of the screens a visitor opens is empty.
test("the demo owner finds a filed and acknowledged inspection, a renewal and a paid invoice", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  // Due work, in a county with a ruleset.
  const due = await (await page.request.get("/api/obligations/due?limit=5")).json();
  expect(due.items.length).toBeGreaterThan(0);

  // Yesterday's inspection, filed with the county and acknowledged, with its proof.
  await page.goto("/filings");
  await page.getByRole("button", { name: "Acknowledged" }).click();
  await expect(page.getByText("Reference EC-DEMO-0042")).toBeVisible();
  // The table is wider than a phone; open the row's link directly.
  const href = await page.getByRole("row").filter({ hasText: "Reference EC-DEMO-0042" }).getByRole("link").getAttribute("href");
  await page.goto(href!);
  await expect(page.getByText(/Message ID /)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Packages" })).toBeVisible();

  // The other one waits for the county.
  await page.goto("/filings");
  await page.getByRole("button", { name: "Waiting for acknowledgment" }).click();
  await expect(page.getByRole("row").filter({ hasText: /Sent / }).first()).toBeVisible();

  // A renewal on its way to the customer.
  await page.goto("/renewals");
  await page.getByRole("button", { name: /^Sent \([1-9]/ }).click();
  await expect(page.getByRole("row").nth(1)).toBeVisible();

  // Invoices: one paid online, one waiting.
  await page.goto("/invoices");
  await page.getByRole("button", { name: "Paid", exact: true }).click();
  await expect(page.getByRole("row").nth(1)).toBeVisible();
  await page.getByRole("button", { name: "Unpaid", exact: true }).click();
  await expect(page.getByRole("row").nth(1)).toBeVisible();
});
