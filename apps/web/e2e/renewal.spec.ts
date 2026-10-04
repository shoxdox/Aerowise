import { expect, test } from "@playwright/test";

test("the office runs the renewal campaign and the homeowner signs, pays and is renewed", async ({ page, browser }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  // Online payments use the built-in test Stripe account.
  await page.goto("/settings/billing");
  const connect = page.getByRole("button", { name: "Connect Stripe" });
  const connected = page.getByText("Customers can pay invoices by card or bank transfer");
  await expect(connect.or(connected).first()).toBeVisible();
  if (await connect.isVisible()) {
    await connect.click();
    await expect(page.getByText("Customers can pay invoices by card or bank transfer")).toBeVisible();
  }

  // The campaign starts renewals for contracts ending inside the window (widened here so
  // the demo data always has several).
  expect((await page.request.patch("/api/renewals/settings", { data: { windowDays: 180 } })).ok()).toBe(true);
  await page.goto("/renewals");
  await page.getByRole("button", { name: "Run campaign now" }).click();
  await expect(page.getByText(/^Campaign run: \d+ started/)).toBeVisible();
  const list = await (await page.request.get("/api/renewals?status=upcoming")).json();
  const pick = list.items.find((r: { hasEmail: boolean }) => r.hasEmail);
  expect(pick).toBeTruthy();

  // The office emails the link.
  await page.goto(`/renewals/${pick.id}`);
  await page.getByRole("button", { name: "Email link" }).click();
  await expect(page.getByText("Renewal emailed.")).toBeVisible();
  await expect(page.locator(".badge", { hasText: "Sent" })).toBeVisible();

  // The homeowner opens it without signing in, signs and pays.
  const { link } = await (await page.request.get(`/api/renewals/${pick.id}`)).json();
  const homeowner = await (await browser.newContext()).newPage();
  await homeowner.goto(new URL(link).pathname);
  await expect(homeowner.getByRole("heading", { name: "Renew your maintenance plan" })).toBeVisible();
  await homeowner.getByLabel("Your full name").fill("Pat Homeowner");
  await homeowner.getByRole("checkbox", { name: /I have read this agreement/ }).check();
  await homeowner.getByRole("button", { name: "Sign and continue to payment" }).click();
  await expect(homeowner.getByRole("heading", { name: "One last step" })).toBeVisible();
  await homeowner.getByRole("button", { name: /^Pay \$[\d,.]+ by card or bank$/ }).click();
  await homeowner.waitForURL(/test-checkout/);
  await homeowner.getByRole("button", { name: "Pay by card" }).click();
  await homeowner.waitForURL(/\/renew\/.+\?paid=1/);
  await expect(homeowner.getByRole("heading", { name: "You're renewed" })).toBeVisible();

  // The office sees the next term on the site.
  await page.reload();
  await expect(page.locator(".badge", { hasText: "Renewed" })).toBeVisible();
  await expect(page.getByText("Signed by Pat Homeowner").first()).toBeVisible();
  await page.goto(`/sites/${pick.site.id}`);
  await expect(page.getByRole("link", { name: "Renewal: renewed" })).toBeVisible();
});
