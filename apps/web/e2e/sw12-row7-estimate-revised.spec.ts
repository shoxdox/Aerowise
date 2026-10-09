import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

// SW-12 plan §12 row 7, demo half (test payments): the office sends an estimate with a deposit,
// the homeowner opens it, the office revises it while the homeowner's page still shows the old
// version, and the homeowner's accept of the old version is refused in the page (409). They accept
// the current one, pay the deposit by card, and the office completes the work order and issues the
// final invoice. One work order, one deposit invoice, one charge; the final amount due is the
// total less the deposit. Runs on the e2e demo company; the plan's trial org type is not covered
// here and stays listed as open for the final matrix.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");
}

test("a revised estimate refuses the old version in the homeowner's page, then one acceptance, one deposit charge and a final invoice net of the deposit", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const count = async (q: string, params: unknown[]) => Number((await db.query(q, params)).rows[0].n);
  const title = `Row 7 pump ${crypto.randomUUID().slice(0, 8)}`;

  try {
    await signIn(page);
    const site = (await (await page.request.get("/api/sites?limit=1")).json()).items[0] as { id: string };
    await page.goto(`/estimates/new?siteId=${site.id}`);
    await page.getByRole("textbox", { name: /^Title/ }).fill(title);
    await page.getByLabel("Line 1 description").fill("Pump, installed");
    await page.getByLabel("Line 1 unit price").fill("600");
    await page.getByRole("spinbutton", { name: /^Deposit/ }).fill("150");
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.waitForURL(/\/estimates\/[0-9a-f-]{36}$/);
    const estimateId = page.url().split("/").pop()!;
    await page.getByRole("button", { name: /Mark sent/ }).click();
    await expect(page.getByTestId("estimate-status")).toHaveText("Sent");
    await page.getByRole("button", { name: "Copy a link" }).click();
    const path = new URL(await page.getByTestId("estimate-link").innerText()).pathname;

    // The homeowner opens version 1 and starts filling it in.
    const home = await browser.newContext();
    const homeowner = await home.newPage();
    await homeowner.goto(path);
    await expect(homeowner.getByTestId("estimate-total")).toHaveText("$600.00");
    await homeowner.getByLabel("Your full name").fill("Pat Homeowner");
    await homeowner.getByRole("checkbox", { name: /I have read this estimate/ }).check();

    // Meanwhile the office revises the price and sends version 2.
    await page.getByRole("button", { name: "Revise" }).click();
    await expect(page.getByRole("heading", { name: "Draft of version 2" })).toBeVisible();
    await page.getByLabel("Line 1 unit price").fill("700");
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.getByRole("button", { name: /Mark sent/ }).click();
    await expect(page.getByTestId("estimate-status")).toHaveText("Sent");
    await expect(page.getByTestId("estimate-total")).toHaveText("$700.00");

    // Accepting the old version is refused in the page, which then shows the current version.
    const refused = homeowner.waitForResponse((r) => r.url().endsWith("/accept"));
    await homeowner.getByRole("button", { name: /Accept for \$600\.00/ }).click();
    expect((await refused).status()).toBe(409);
    expect((await (await refused).json()).error).toBe("estimate_revised");
    await expect(homeowner.getByText("This estimate was revised since you opened it. Review the new version before accepting.")).toBeVisible();
    await expect(homeowner.getByTestId("estimate-total")).toHaveText("$700.00");
    expect((await db.query("select status from estimates where id = $1", [estimateId])).rows[0].status).not.toBe("accepted");

    // The current version is accepted, and the deposit paid by card on the test checkout.
    await homeowner.getByLabel("Your full name").fill("Pat Homeowner");
    const agree = homeowner.getByRole("checkbox", { name: /I have read this estimate/ });
    if (!(await agree.isChecked())) await agree.check();
    await homeowner.getByRole("button", { name: /Accept for \$700\.00/ }).click();
    await expect(homeowner.getByRole("heading", { name: "Estimate accepted" })).toBeVisible();
    await expect(homeowner.getByTestId("estimate-deposit-status")).toContainText("A deposit of $150.00 is due now");
    await homeowner.getByRole("link", { name: "Pay the deposit" }).click();
    await homeowner.waitForURL(/\/pay\//);
    await homeowner.getByRole("button", { name: "Pay $150.00 by card or bank" }).click();
    await homeowner.waitForURL(/test-checkout/);
    await homeowner.getByRole("button", { name: "Pay by card" }).click();
    await expect(homeowner.getByText("This invoice is paid in full")).toBeVisible();
    await home.close();

    // The office: accepted on version 2, deposit held, then the work order is completed.
    await page.reload();
    await expect(page.getByTestId("estimate-acceptance")).toContainText("version 2");
    await expect(page.getByTestId("deposit-received")).toHaveText("$150.00");
    await page.getByRole("link", { name: /^WO-\d+$/ }).click();
    await page.waitForURL(/\/work\/[0-9a-f-]{36}$/);
    const workOrderId = page.url().split("/").pop()!;
    await expect(page.getByText("Pump, installed").first()).toBeVisible();
    await page.getByRole("button", { name: "Complete without a field record" }).click();
    await page.getByLabel(/How was it done/).fill("Recorded on the paper ticket");
    await page.getByRole("button", { name: "Complete", exact: true }).click();
    await expect(page.getByTestId("work-status")).toHaveText("Completed");

    // The final invoice takes the deposit off: $700 less $150.
    await page.getByRole("button", { name: "Create invoice" }).click();
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
    const finalId = page.url().split("/").pop()!;
    await page.getByRole("button", { name: "Issue without emailing" }).click();
    await expect(page.getByText("Deposit applied")).toBeVisible();
    const totals = page.locator("dl.totals");
    await expect(totals).toContainText("−$150.00");
    await expect(totals).toContainText("$550.00");
    const final = await (await page.request.get(`/api/invoices/${finalId}`)).json();
    expect(final.totalCents).toBe(55000);
    expect(final.depositAppliedCents).toBe(15000);

    // Exactly one of each.
    expect(await count("select count(*) as n from work_orders where source_kind = 'estimate' and source_id = $1", [estimateId])).toBe(1);
    expect((await db.query("select work_order_id from estimates where id = $1", [estimateId])).rows[0].work_order_id).toBe(workOrderId);
    expect(await count("select count(*) as n from estimate_invoices where estimate_id = $1 and role = 'deposit' and voided_at is null", [estimateId])).toBe(1);
    expect(await count("select count(*) as n from payments p join estimate_invoices e on e.invoice_id = p.invoice_id where e.estimate_id = $1 and p.status = 'succeeded'", [estimateId])).toBe(1);
    expect(await count("select count(*) as n from estimate_invoices where estimate_id = $1 and role = 'final'", [estimateId])).toBe(1);
  } finally {
    await db.end();
  }
});
