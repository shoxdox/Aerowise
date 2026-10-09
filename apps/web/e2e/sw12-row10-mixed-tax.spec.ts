import { expect, test } from "@playwright/test";
import pg from "pg";
import { connectQuickBooks, disconnectQuickBooks, syncQuickBooksOnce } from "./sw12-worker-steps.ts";

// SW-12 plan §12 row 10, browser half: the office issues an invoice with a taxable and a
// non-taxable line. With QuickBooks sales tax sync off it waits in the conflict center as "Sales
// tax not mapped" (today's behavior); once the owner turns tax sync on with the test company's
// codes, the next sync sends it with its tax, or holds it as a totals mismatch. Against the
// built-in test QuickBooks company; a sync is run on demand because the e2e harness has no worker.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";

test("a mixed taxable invoice waits as unmapped tax with QuickBooks tax off, and syncs or is held as a mismatch with it on", async ({ page }) => {
  test.setTimeout(180_000);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  let connected = false;
  let taxBefore: { mode: string; taxableCode: { id: string } | null; nontaxableCode: { id: string } | null; taxRate: { id: string } | null } | null = null;

  try {
    await page.goto("/login");
    await page.getByLabel("Email").fill("owner@example.com");
    await page.getByLabel("Password").fill("aerowise-dev");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/inbox");
    const org = (await db.query("select m.organization_id as id from memberships m join users u on u.id = m.user_id where u.email = 'owner@example.com'")).rows[0].id as string;
    connected = await connectQuickBooks(page);
    // Tax sync off for the first half, whatever an earlier spec left; put back in finally.
    taxBefore = (await (await page.request.get("/api/quickbooks/mapping")).json()).tax;
    if (taxBefore!.mode !== "off") expect((await page.request.put("/api/quickbooks/mapping", { data: { taxMode: "off" } })).status()).toBe(200);

    // A customer QuickBooks does not have yet, so the sync creates it rather than asking.
    const customer = await (await page.request.post("/api/customers", { data: { displayName: `Row 10 Tax Customer ${crypto.randomUUID().slice(0, 8)}` } })).json();

    // The office writes the invoice: one non-taxable line, one taxable, 8.25% sales tax.
    await page.goto(`/invoices/new?customerId=${customer.id}`);
    await page.getByLabel("Description").first().fill("Aerator repair");
    await page.getByLabel("Price").first().fill("300");
    await page.getByRole("button", { name: "Add line" }).click();
    await page.getByLabel("Description").nth(1).fill("Chlorine");
    await page.getByLabel("Quantity").nth(1).fill("2");
    await page.getByLabel("Price").nth(1).fill("12.50");
    await page.getByLabel("Taxable").nth(1).check();
    await page.getByLabel("Sales tax (%)").fill("8.25");
    await page.getByRole("button", { name: "Create draft" }).click();
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
    const invoiceId = page.url().split("/").pop()!;
    await page.getByRole("button", { name: "Issue without emailing" }).click();
    await expect(page.getByRole("heading", { name: /^INV-\d+$/ })).toBeVisible();
    const inv = await (await page.request.get(`/api/invoices/${invoiceId}`)).json();
    expect([inv.subtotalCents, inv.taxCents, inv.totalCents]).toEqual([32500, 206, 32706]);

    const link = async () => (await db.query("select status, conflict_kind, external_id from quickbooks_links where entity_type = 'invoice' and entity_id = $1", [invoiceId])).rows[0];

    // Tax sync off: today's conflict, shown in the conflict center.
    syncQuickBooksOnce(org);
    expect(await link()).toMatchObject({ status: "conflict", conflict_kind: "tax_mapping_missing", external_id: null });
    await page.goto("/quickbooks");
    const record = page.getByTestId("qb-record").filter({ hasText: customer.displayName });
    await expect(record).toContainText("Sales tax not mapped");

    // The owner turns tax sync on with the test company's codes.
    const taxOn = page.getByLabel("Send sales tax to QuickBooks");
    await taxOn.check();
    await page.locator('select[name="taxableCode"]').selectOption({ label: "TAX" });
    await page.locator('select[name="nontaxableCode"]').selectOption({ label: "NON" });
    await page.locator('select[name="taxRate"]').selectOption({ label: "Travis County 8.25%" });
    await page.getByRole("button", { name: "Save" }).first().click();
    await expect(page.getByText("Saved")).toBeVisible();

    // The next sync sends it with its tax, or holds it as a totals mismatch; never left unmapped.
    syncQuickBooksOnce(org);
    const after = await link();
    expect(after.conflict_kind ?? null, JSON.stringify(after)).not.toBe("tax_mapping_missing");
    expect(["synced", "quarantined"], JSON.stringify(after)).toContain(after.status);
    if (after.status === "quarantined") expect(after.conflict_kind).toBe("tax_total_mismatch");
    else expect(after.external_id).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId("qb-record").filter({ hasText: customer.displayName }).filter({ hasText: "Sales tax not mapped" })).toHaveCount(0);
  } finally {
    if (taxBefore) {
      const restore = taxBefore.mode === "off" ? { taxMode: "off" } : { taxMode: taxBefore.mode, taxableCodeRef: taxBefore.taxableCode?.id, nontaxableCodeRef: taxBefore.nontaxableCode?.id, taxRateRef: taxBefore.taxRate?.id };
      await page.request.put("/api/quickbooks/mapping", { data: restore });
    }
    if (connected) await disconnectQuickBooks(page);
    await db.end();
  }
});
