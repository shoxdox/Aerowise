import { expect, test } from "@playwright/test";

/** Actual product pages and fictional application records, captured for the branch handoff. */
test("public and role experiences remain readable on desktop and two phone sizes", async ({ page }) => {
  test.setTimeout(240_000);
  for (const width of [1440, 375, 430]) {
    await page.setViewportSize({ width, height: width === 1440 ? 960 : 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "One price per contract" })).toBeVisible();
    await expect(page.locator(".price")).toContainText("$0.50 per active contract, per month");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`homepage-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  const started = Date.now();
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start my demo" }).click();
  await page.waitForURL("**/inbox", { timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Open completed report and evidence" })).toBeVisible();
  const journey = await (await page.request.get("/api/demo/journey")).json();
  await page.screenshot({ path: test.info().outputPath("owner-first-action.png"), fullPage: true });
  await page.getByRole("note").getByRole("button", { name: "Office", exact: true }).click();
  await page.waitForURL("**/inbox");
  await expect(page.getByRole("note")).toContainText("Active role: office");
  await page.screenshot({ path: test.info().outputPath("office-first-action.png"), fullPage: true });
  await page.goto(`/sites/${journey.case.siteId}`);
  await expect(page.getByRole("heading", { name: "Current record and next action" })).toBeVisible();
  await expect(page.getByText("Most recent report", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("mature-site-next-action.png"), fullPage: true });
  await page.goto(`/filings/${journey.case.filingId}`);
  await expect(page.getByRole("heading", { name: "Packages", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("completed-report-evidence.png"), fullPage: true });
  await page.getByRole("note").getByRole("button", { name: "Technician", exact: true }).click();
  await page.waitForURL("**/tech**");
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(page.locator(".stop-card").first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("technician-route-375.png"), fullPage: true });
  const link = await page.request.post("/api/demo/homeowner", { data: { customerId: journey.case.customerId } });
  expect(link.ok()).toBe(true);
  await page.goto((await link.json()).href);
  await expect(page.getByRole("heading", { name: `Hello, ${journey.case.customerName}` })).toBeVisible();
  await expect(page.getByRole("link", { name: /Report from/ }).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("populated-homeowner-375.png"), fullPage: true });
  expect(Date.now() - started, "the guided records are reachable within five minutes, including seed time").toBeLessThan(300_000);
});
