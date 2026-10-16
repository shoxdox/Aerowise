import { expect, test } from "@playwright/test";

test("the office runs the renewal campaign and the homeowner signs, pays and is renewed", async ({ page, browser }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  // Online payments use the built-in test payment provider.
  await page.goto("/settings/billing");
  const connect = page.getByRole("button", { name: "Connect Stripe" });
  const connected = page.getByText("Try a simulated card or bank payment. No payment goes to Stripe or a bank.");
  await expect(connect.or(connected).first()).toBeVisible();
  if (await connect.isVisible()) {
    await connect.click();
    await expect(connected).toBeVisible();
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
  // The term reads exactly as the signed agreement will print it.
  const view = await (await page.request.get(`/api${new URL(link).pathname}`)).json();
  for (const row of view.termRows as { key: string; value: string }[]) await expect(homeowner.getByTestId(`renewal-${row.key}`)).toHaveText(row.value.replace(/\n/g, ""));
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

test("a renewal made by phone closes the emailed offer, and the homeowner's link says nothing is due", async ({ page, browser }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  // An open offer on an auto-renewing contract.
  expect((await page.request.patch("/api/renewals/settings", { data: { windowDays: 180 } })).ok()).toBe(true);
  expect((await page.request.post("/api/renewals/campaign", { data: {} })).ok()).toBe(true);
  const list = await (await page.request.get("/api/renewals?status=upcoming&limit=200")).json();
  let pick: { id: string; contractId: string; link: string; site: { id: string } } | null = null;
  for (const item of list.items as { id: string }[]) {
    const detail = await (await page.request.get(`/api/renewals/${item.id}`)).json();
    if (detail.autoRenewContract) {
      pick = detail;
      break;
    }
  }
  expect(pick, "an open offer on an auto-renewing contract").not.toBeNull();
  const path = new URL(pick!.link).pathname;

  // The homeowner is told it renews automatically, on the page and in the terms they sign.
  const homeowner = await (await browser.newContext()).newPage();
  await homeowner.goto(path);
  await expect(homeowner.getByTestId("renewal-renews")).toHaveText("Automatically, unless either party gives written notice before this term ends.");
  await expect(homeowner.getByText(/renews automatically unless either party gives written notice before it ends/)).toBeVisible();

  // While the offer is open (the homeowner has just viewed it), the site points to it instead of offering 'Renew now'.
  await page.goto(`/sites/${pick!.site.id}`);
  const offer = page.getByRole("link", { name: "Renewal viewed — view" });
  await expect(offer).toBeVisible();
  await expect(page.locator("details", { has: offer }).getByRole("button", { name: "Renew now" })).toHaveCount(0);

  // The term is made another way (a second tab, or the API): the offer closes with it.
  expect((await page.request.post(`/api/contracts/${pick!.contractId}/renew`, { data: {} })).status()).toBe(201);
  await homeowner.reload();
  await expect(homeowner.getByRole("heading", { name: "Your plan was already renewed" })).toBeVisible();
  await expect(homeowner.getByText(/^Nothing is due here\./)).toBeVisible();
  await expect(homeowner.getByRole("button", { name: /^Sign/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("link", { name: "Renewal: renewed another way" })).toBeVisible();
});
