import { expect, test, type Page } from "@playwright/test";

async function invoice(page: Page) {
  expect((await page.request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  const customers = (await (await page.request.get("/api/customers?limit=10")).json()).items;
  const draft = await page.request.post("/api/invoices", { data: { customerId: customers[0].id, lines: [{ description: "Recovery regression fictional invoice", unitPriceCents: 1000 }] } });
  expect(draft.ok()).toBe(true);
  const issued = await page.request.post(`/api/invoices/${(await draft.json()).id}/issue`, { data: { send: false } });
  expect(issued.ok()).toBe(true);
  const inv = await issued.json();
  const path = new URL(inv.payUrl).pathname;
  const checkout = await page.request.post(`/api${path}/checkout`, { data: {} });
  expect(checkout.ok()).toBe(true);
  const sessionId = new URL((await checkout.json()).url).searchParams.get("session");
  return { path, sessionId };
}

test("a return before the card webhook blocks another payment, advances and stops polling", async ({ page }) => {
  const inv = await invoice(page);
  let reads = 0;
  page.on("request", (req) => { if (new URL(req.url()).pathname === `/api${inv.path}`) reads++; });
  await page.goto(`${inv.path}?paid=1`);
  await expect(page.getByRole("heading", { name: "Confirming your payment" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Pay \$/ })).toHaveCount(0);
  const applied = await page.request.post(`/api${inv.path}/test-checkout`, { data: { sessionId: inv.sessionId, outcome: "card" } });
  expect(applied.ok()).toBe(true);
  await expect(page.getByText(/This invoice is paid in full/)).toBeVisible({ timeout: 12_000 });
  const finished = reads;
  await page.waitForTimeout(3500);
  expect(reads).toBe(finished);
});

test("bank processing advances through the actual stand-in webhook without another pay action", async ({ page }) => {
  const inv = await invoice(page);
  expect((await page.request.post(`/api${inv.path}/test-checkout`, { data: { sessionId: inv.sessionId, outcome: "ach_pending" } })).ok()).toBe(true);
  await page.goto(inv.path);
  await expect(page.getByText(/Your bank payment is on its way/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Pay \$/ })).toHaveCount(0);
  expect((await page.request.post(`/api${inv.path}/test-checkout`, { data: { sessionId: inv.sessionId, outcome: "ach_clears" } })).ok()).toBe(true);
  await expect(page.getByText(/This invoice is paid in full/)).toBeVisible({ timeout: 12_000 });
});

test("confirmation checks are bounded and a manual refresh recovers after the wait", async ({ page }) => {
  const inv = await invoice(page);
  await page.clock.install();
  let reads = 0;
  page.on("request", (req) => { if (new URL(req.url()).pathname === `/api${inv.path}`) reads++; });
  await page.goto(`${inv.path}?paid=1`);
  await expect(page.getByRole("heading", { name: "Confirming your payment" })).toBeVisible();
  for (let i = 0; i < 20; i++) {
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === `/api${inv.path}`);
    await page.clock.runFor(3000);
    await response;
    await expect.poll(() => reads).toBe(i + 2);
    // Complete the asynchronous read before advancing the next scheduled interval.
    await expect(page.getByRole("button", { name: "Refresh payment status" })).toBeVisible();

  }
  await expect(page.getByText(/Automatic checks have paused/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Pay \$/ })).toHaveCount(0);
  await page.clock.runFor(10_000);
  expect(reads).toBe(21);
  expect((await page.request.post(`/api${inv.path}/test-checkout`, { data: { sessionId: inv.sessionId, outcome: "card" } })).ok()).toBe(true);
  await page.getByRole("button", { name: "Refresh payment status" }).click();
  await expect(page.getByText(/This invoice is paid in full/)).toBeVisible();
});

test("a failed bank attempt is terminal after returning and offers explicit recovery", async ({ page }) => {
  const inv = await invoice(page);
  expect((await page.request.post(`/api${inv.path}/test-checkout`, { data: { sessionId: inv.sessionId, outcome: "ach_pending" } })).ok()).toBe(true);
  await page.goto(`${inv.path}?paid=1`);
  await expect(page.getByText(/Your bank payment is on its way/)).toBeVisible();
  expect((await page.request.post(`/api${inv.path}/test-checkout`, { data: { sessionId: inv.sessionId, outcome: "ach_fails" } })).ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "Payment did not clear" })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByRole("button", { name: "Retry payment of $10.00" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh payment status" })).toHaveCount(0);
});

test("an original renewal link keeps a bank reservation visible and resolves terminal failure", async ({ page }) => {
  expect((await page.request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  const customer = await (await page.request.post("/api/customers", { data: { displayName: "Fictional renewal recovery" } })).json();
  const site = await (await page.request.post(`/api/customers/${customer.id}/sites`, { data: { addressLine1: "13 Recovery Example Road", city: "Austin" } })).json();
  const plan = await (await page.request.post("/api/plans", { data: { name: "Recovery example plan", termMonths: 1, visitsPerTerm: 1, priceCents: 1000 } })).json();
  const { today } = await (await page.request.get("/api/obligations/due?limit=1")).json();
  const contract = await (await page.request.post(`/api/sites/${site.id}/contracts`, { data: { planId: plan.id, startOn: today } })).json();
  const renewal = await (await page.request.post(`/api/contracts/${contract.id}/renewal`, { data: { send: false } })).json();
  const path = new URL(renewal.link).pathname;
  const view = await (await page.request.get(`/api${path}`)).json();
  const signed = await page.request.post(`/api${path}/sign`, { data: { version: view.version, contact: { email: "fictional-renewal@example.test", phone: null }, signerName: "Fictional Regression Customer", signature: { kind: "typed" }, agree: true } });
  expect(signed.ok()).toBe(true);
  const checkout = new URL((await (await page.request.post(`/api${path}/checkout`, { data: {} })).json()).url);
  const payPath = checkout.pathname.replace(/\/test-checkout$/, "");
  const step = (outcome: string) => page.request.post(`/api${payPath}/test-checkout`, { data: { sessionId: checkout.searchParams.get("session"), outcome } });
  expect((await step("ach_pending")).ok()).toBe(true);
  await page.goto(path); // Original email link, without a paid return flag.
  await expect(page.getByRole("heading", { name: "Confirming your payment" })).toBeVisible();
  await expect(page.getByText(/Your payment is pending/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Pay \$/ })).toHaveCount(0);
  expect((await step("ach_fails")).ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "Payment did not clear" })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByRole("link", { name: "Open invoice and payment recovery" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh payment status" })).toHaveCount(0);
});

for (const [route, kind] of [["pay", "invoice"], ["renew", "renewal"], ["estimate", "estimate"], ["portal", "account"]] as const) {
  test(`${kind} distinguishes a temporary failure from missing, expired and revoked access`, async ({ page }) => {
    const path = `/${route}/${"x".repeat(43)}`;
    let response = { status: 503, error: "unavailable", message: "Controlled server failure" };
    await page.route(`**/api${path}`, (r) => r.fulfill({ status: response.status, json: response }));
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "This page could not load" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Email me a new link" })).toHaveCount(0);
    response = { status: 404, error: "not_found", message: "Not found" };
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { name: `This ${kind} link was not found` })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    response = { status: 410, error: "expired", message: "Expired" };
    await page.reload();
    await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
    response = { status: 410, error: "revoked", message: "Revoked" };
    await page.reload();
    await expect(page.getByRole("heading", { name: "This link was turned off" })).toBeVisible();
  });
}

test("a valid invoice survives a stalled read and retries; offline is named correctly", async ({ page, context }) => {
  const inv = await invoice(page);
  await page.route(`**/api${inv.path}`, () => new Promise<void>(() => {}));
  await page.goto(inv.path);
  await expect(page.getByRole("heading", { name: "The request took too long" })).toBeVisible({ timeout: 25_000 });
  await page.unroute(`**/api${inv.path}`);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("button", { name: "Pay $10.00 by card or bank" })).toBeVisible();
  await page.goto(`${inv.path}?paid=1`);
  await expect(page.getByRole("button", { name: "Refresh payment status" })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Refresh payment status" }).click();
  await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Confirming your payment" })).toBeVisible();
});
