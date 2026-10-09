import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// SW-12 plan §12 row 8, browser half: the homeowner presses Accept in two tabs at once, then opens
// the deposit's checkout from two tabs and pays on both test-checkout pages, and pays again from a
// page reached with Back. One acceptance, one work order, one deposit invoice, one checkout page
// and one charge. (The API half, accept-once and checkout-under-lock with repeated request ids,
// is in estimates.test and deposits.test.) On the e2e demo company with test payments.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");
}

/** A sent estimate for $600 asking a $150 deposit; returns its id and the homeowner's link. */
async function sentEstimate(page: Page, title: string) {
  const site = (await (await page.request.get("/api/sites?limit=1")).json()).items[0] as { id: string };
  await page.goto(`/estimates/new?siteId=${site.id}`);
  await page.getByRole("textbox", { name: /^Title/ }).fill(title);
  await page.getByLabel("Line 1 description").fill("Pump, installed");
  await page.getByLabel("Line 1 unit price").fill("600");
  await page.getByRole("spinbutton", { name: /^Deposit/ }).fill("150");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.waitForURL(/\/estimates\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: /Mark sent/ }).click();
  await expect(page.getByTestId("estimate-status")).toHaveText("Sent");
  await page.getByRole("button", { name: "Copy a link" }).click();
  return { id: page.url().split("/").pop()!, path: new URL(await page.getByTestId("estimate-link").innerText()).pathname };
}

async function readyToAccept(browser: Browser, path: string) {
  const tab = await (await browser.newContext()).newPage();
  await tab.goto(path);
  await expect(tab.getByTestId("estimate-total")).toHaveText("$600.00");
  await tab.getByLabel("Your full name").fill("Pat Homeowner");
  await tab.getByRole("checkbox", { name: /I have read this estimate/ }).check();
  return tab;
}

test("a double accept and a replayed deposit checkout make one acceptance, one work order and one charge", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const count = async (q: string, params: unknown[]) => Number((await db.query(q, params)).rows[0].n);

  try {
    await signIn(page);
    const est = await sentEstimate(page, `Row 8 pump ${crypto.randomUUID().slice(0, 8)}`);

    // Two tabs, both pressed together.
    const tabs = [await readyToAccept(browser, est.path), await readyToAccept(browser, est.path)];
    const answers = tabs.map((t) => t.waitForResponse((r) => r.url().endsWith("/accept")));
    await Promise.all(tabs.map((t) => t.getByRole("button", { name: /Accept for \$600\.00/ }).click()));
    const bodies = await Promise.all(answers.map(async (a) => ({ status: (await a).status(), body: await (await a).json() })));
    expect(bodies.map((b) => b.status), JSON.stringify(bodies)).toEqual([200, 200]);
    expect(bodies.filter((b) => b.body.alreadyAccepted).length, "exactly one of the two made the acceptance").toBe(1);
    for (const t of tabs) await expect(t.getByRole("heading", { name: "Estimate accepted" })).toBeVisible();

    expect(await count("select count(*) as n from estimate_events where estimate_id = $1 and event_type = 'accepted'", [est.id])).toBe(1);
    expect(await count("select count(*) as n from work_orders where source_kind = 'estimate' and source_id = $1", [est.id])).toBe(1);
    expect(await count("select count(*) as n from estimate_invoices where estimate_id = $1 and role = 'deposit' and voided_at is null", [est.id])).toBe(1);
    const depositInvoiceId = (await db.query("select invoice_id from estimate_invoices where estimate_id = $1 and role = 'deposit'", [est.id])).rows[0].invoice_id as string;

    // Both tabs open the deposit's checkout; the second gets the same checkout page, not another.
    for (const t of tabs) {
      await t.getByRole("link", { name: "Pay the deposit" }).click();
      await t.waitForURL(/\/pay\//);
    }
    for (const t of tabs) {
      await t.getByRole("button", { name: "Pay $150.00 by card or bank" }).click();
      await t.waitForURL(/test-checkout/);
    }
    const session = (t: Page) => new URL(t.url()).searchParams.get("session");
    expect(session(tabs[1]!)).toBe(session(tabs[0]!));
    expect(await count("select count(*) as n from checkout_sessions where invoice_id = $1", [depositInvoiceId])).toBe(1);

    // Paid on the first tab, then the same checkout finished again on the second (a replayed
    // completion), and once more from a page reached with Back.
    await tabs[0]!.getByRole("button", { name: "Pay by card" }).click();
    await expect(tabs[0]!.getByText("This invoice is paid in full")).toBeVisible();
    const replay = tabs[1]!.waitForResponse((r) => r.url().endsWith("/test-checkout"));
    await tabs[1]!.getByRole("button", { name: "Pay by card" }).click();
    expect((await replay).status()).toBeLessThan(500);
    await tabs[0]!.goBack();
    await tabs[0]!.waitForURL(/test-checkout/);
    const again = tabs[0]!.waitForResponse((r) => r.url().endsWith("/test-checkout"));
    await tabs[0]!.getByRole("button", { name: "Pay by card" }).click();
    expect((await again).status()).toBeLessThan(500);
    await tabs[1]!.goto(new URL(tabs[1]!.url()).pathname.replace(/\/test-checkout$/, ""));
    await expect(tabs[1]!.getByText("This invoice is paid in full")).toBeVisible();

    expect(await count("select count(*) as n from payments where invoice_id = $1 and status = 'succeeded'", [depositInvoiceId])).toBe(1);
    expect(await count("select count(*) as n from payments where invoice_id = $1", [depositInvoiceId])).toBe(1);
    expect((await db.query("select coalesce(sum(amount_cents), 0)::int as cents from payments where invoice_id = $1", [depositInvoiceId])).rows[0].cents).toBe(15000);
    expect(await count("select count(*) as n from deposit_ledger where deposit_invoice_id = $1 and kind = 'received'", [depositInvoiceId])).toBe(1);

    // The office sees one deposit of $150.
    await page.goto(`/estimates/${est.id}`);
    await expect(page.getByTestId("deposit-received")).toHaveText("$150.00");
    for (const t of tabs) await t.context().close();
  } finally {
    await db.end();
  }
});
