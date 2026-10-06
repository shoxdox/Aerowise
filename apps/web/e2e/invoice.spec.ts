import { expect, test } from "@playwright/test";

test("the owner bills a contract and the homeowner pays it online", async ({ page, browser }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  // Connect the (test) Stripe account, unless the demo story already did.
  await page.goto("/settings/billing");
  const connected = page.getByText("Customers can pay invoices by card or bank transfer");
  const connect = page.getByRole("button", { name: "Connect Stripe" });
  await expect(connected.or(connect)).toBeVisible();
  if (await connect.isVisible()) await connect.click();
  await expect(connected).toBeVisible();

  // Bill the contract of a site whose customer has an email on file.
  const due = await (await page.request.get("/api/obligations/due?limit=50")).json();
  let siteId: string | undefined;
  for (const item of due.items) {
    const customer = await (await page.request.get(`/api/customers/${item.customer.id}`)).json();
    if (customer.contacts.some((c: { email: string | null }) => c.email)) {
      siteId = item.site.id;
      break;
    }
  }
  await page.goto(`/sites/${siteId}`);
  await page.getByRole("button", { name: "Bill next installment" }).first().click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
  const invoiceId = page.url().split("/").pop()!;
  await expect(page.getByRole("heading", { name: "Draft" })).toBeVisible();
  await page.getByRole("button", { name: "Issue and email" }).click();
  await expect(page.getByRole("heading", { name: /^INV-\d+$/ })).toBeVisible();
  await expect(page.locator(".badge", { hasText: "Unpaid" })).toBeVisible();

  // The homeowner opens the link from the email, without signing in.
  const { payUrl, totalCents } = await (await page.request.get(`/api/invoices/${invoiceId}`)).json();
  const homeowner = await (await browser.newContext()).newPage();
  await homeowner.goto(new URL(payUrl).pathname);
  const amount = (totalCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  await homeowner.getByRole("button", { name: `Pay ${amount} by card or bank` }).click();
  await homeowner.waitForURL(/test-checkout/);
  await homeowner.getByRole("button", { name: "Pay by card" }).click();
  await expect(homeowner.getByText("This invoice is paid in full")).toBeVisible();

  // The office sees it paid.
  await page.reload();
  await expect(page.locator(".badge", { hasText: "Paid" }).first()).toBeVisible();
  await expect(page.getByText(/Paid \$[\d,.]+ online by card/)).toBeVisible();

  // Refunds: Cancel sends nothing, and each choice sends its intent.
  const refundBodies: { amountCents: number; intent: string }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/payments\/[^/]+\/refund$/.test(r.url())) refundBodies.push(r.postDataJSON());
  });
  const refundForm = page.getByRole("form", { name: "Refund payment" });
  await page.getByRole("button", { name: "Refund", exact: true }).click();
  await expect(refundForm.getByLabel(/Ordinary refund/)).toBeChecked();
  await refundForm.getByLabel(/Reason/).fill("Changed my mind");
  await refundForm.getByRole("button", { name: "Cancel" }).click();
  await expect(refundForm).toBeHidden();
  expect(refundBodies).toEqual([]);

  await page.getByRole("button", { name: "Refund", exact: true }).click();
  await refundForm.getByLabel(/Amount/).fill("1.00");
  await refundForm.getByLabel(/Reason/).fill("Goodwill");
  await refundForm.getByRole("button", { name: "Refund", exact: true }).click();
  await expect(page.getByRole("cell").getByText(/Refund(ed| pending) \$1\.00: Goodwill/)).toBeVisible();

  await page.getByRole("button", { name: "Refund", exact: true }).click();
  await refundForm.getByLabel(/Amount/).fill("2.00");
  await refundForm.getByLabel(/Reason/).fill("Charged twice");
  await refundForm.getByLabel(/Reverse payment/).check();
  await refundForm.getByRole("button", { name: "Refund", exact: true }).click();
  await expect(page.getByRole("cell").getByText(/Refund(ed| pending) \$2\.00 \(payment reversed, owed again\): Charged twice/)).toBeVisible();
  expect(refundBodies.map((b) => [b.amountCents, b.intent])).toEqual([
    [100, "credit"],
    [200, "reverse"],
  ]);
});
