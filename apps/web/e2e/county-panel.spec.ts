import { expect, test } from "@playwright/test";

// W10.5: a site's panel says what its authority asks, and where that comes from.
test("the site panel shows the authority's interval, deadline, channel, contracts and acknowledgment", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("office@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  const sites = await (await page.request.get("/api/sites?limit=1")).json();
  await page.goto(`/sites/${sites.items[0].id}`);
  const panel = page.locator("dl").filter({ hasText: "Reports to" });
  await expect(panel.getByText("Example rules for the demo; no real authority.")).toBeVisible();
  await expect(panel.getByText("At least every 4 months.")).toBeVisible();
  await expect(panel.getByText("Within 14 days of the inspection.")).toBeVisible();
  await expect(panel.getByText(/^By email to filings@tx-example-county\.example\./)).toBeVisible();
  await expect(panel.getByText("Not filed with this authority.")).toBeVisible();
  await expect(panel.getByText(/record its reference to finish a filing/)).toBeVisible();
  await panel.screenshot({ path: "test-results/county-panel.png" });
});
