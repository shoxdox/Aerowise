import { expect, test, type Page } from "@playwright/test";

// Fixes from the W11 walkthrough (docs/product/W11-WALKTHROUGH.md). The e2e device is a
// Pixel 7, so the office screens here are at phone width.

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("B1: a technician's menu has no Filings or Invoices, which their role can't open", async ({ page }) => {
  await signIn(page, "tech@example.com");
  await page.goto("/schedule");
  await page.getByRole("button", { name: "Menu" }).click();
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Schedule" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Filings" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Invoices" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "QuickBooks" })).toHaveCount(0);
});

test("B2: at 8:30 PM in Texas, a new contract starts today, not tomorrow (UTC)", async ({ page }) => {
  // 02:30 UTC on Jan 15 is 8:30 PM on Jan 14 in Central Time.
  await page.clock.setFixedTime(new Date("2030-01-15T02:30:00Z"));
  await signIn(page, "office@example.com");
  await page.goto("/sites");
  await page.locator("table a[href^='/sites/']").first().click();
  await page.getByRole("button", { name: "New contract" }).click();
  await expect(page.getByLabel("Start date")).toHaveValue("2030-01-14");
});

test("on a phone the office menu folds away, tables scroll in place, and owner-only pages say so", async ({ page }) => {
  await signIn(page, "office@example.com");

  // C3: the links are behind Menu, and choosing one folds them again.
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav).toBeHidden();
  await page.getByRole("button", { name: "Menu" }).click();
  await nav.getByRole("link", { name: "Due" }).click();
  await page.waitForURL("**/due");
  await expect(nav).toBeHidden();
  await expect(page.locator(".topbar .current-page")).toHaveText("Due");

  // C2: wide tables scroll inside their box, so the page itself never scrolls sideways.
  for (const path of ["/due", "/plans", "/settings/users"]) {
    await page.goto(path);
    await expect(page.locator("table").first()).toBeVisible();
    expect(await sideways(page), path).toBeLessThanOrEqual(0);
  }

  // C1: the export is the owner's; the office is told so instead of offered a button that fails.
  await page.goto("/settings/export");
  await expect(page.getByText("Only the owner can export the company's data.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare an export" })).toHaveCount(0);

  // C4: the schedule's day picker has a name.
  await page.goto("/schedule");
  await expect(page.getByLabel("Day", { exact: true })).toBeVisible();
});

test("second walk: a demo filing reads consistently and fits a phone", async ({ page }) => {
  await signIn(page, "office@example.com");
  // One of yesterday's Example County report filings (the demo also holds LCRA contract and report filings).
  const filings = (await (await page.request.get("/api/filings?view=all&kind=inspection_report")).json()).items as { id: string; jurisdiction: { key: string } | null }[];
  const example = filings.find((f) => f.jurisdiction?.key === "tx-example-county")!;
  await page.goto(`/filings/${example.id}`);
  // R1: the fictional county holds for the MP's signature like a real one, so the report it got was signed first.
  const panel = page.locator("section", { has: page.getByRole("heading", { name: "Maintenance provider signature" }) });
  await expect(panel).toContainText("signed by Olivia Owner");
  await expect(panel).not.toContainText("example county rules don't hold the filing");
  // R2: the manifest hash wraps instead of widening the page.
  await expect(page.getByText(/Manifest SHA-256/).first()).toBeVisible();
  expect(await sideways(page)).toBeLessThanOrEqual(0);
});
