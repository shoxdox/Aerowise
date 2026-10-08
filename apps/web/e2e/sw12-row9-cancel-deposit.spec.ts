import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { connectQuickBooks, disconnectQuickBooks, syncQuickBooksOnce } from "./sw12-quickbooks.ts";

// SW-12 plan §12 row 9, browser half: the office cancels accepted work whose deposit is paid, then
// settles the deposit from the inbox: refunded in one case, kept with a reason in the other. The
// work order and its visit are cancelled, the inbox asks for a decision and nothing moves until
// the office makes it, and the decision is on the deposit ledger. With the built-in test
// QuickBooks company connected, a sync keeps the deposit and its refund out of QuickBooks behind
// the deposit-mapping conflict (plan §3.6 and SW-5's "QuickBooks deposit handling behind its
// conflict"); no Refund Receipt is written for it. On the e2e demo company with test payments.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");
}

/** An estimate accepted on paper, its $150 deposit paid by card on the test checkout, and a visit scheduled today. */
async function acceptedWithPaidDeposit(api: APIRequestContext, db: pg.Client, title: string) {
  const site = (await (await api.get("/api/sites?limit=1")).json()).items[0] as { id: string };
  const made = await api.post("/api/estimates", { data: { siteId: site.id, title, lines: [{ description: "Pump, installed", quantity: 1, unitPriceCents: 60000 }], depositCents: 15000 } });
  expect(made.status(), await made.text()).toBe(201);
  const est = await made.json();
  const accepted = await api.post(`/api/estimates/${est.id}/record-acceptance`, { data: { evidence: "Signed paper copy" } });
  expect(accepted.status(), await accepted.text()).toBe(200);
  const depositId = (await db.query("select invoice_id from estimate_invoices where estimate_id = $1 and role = 'deposit'", [est.id])).rows[0].invoice_id as string;
  const deposit = await (await api.get(`/api/invoices/${depositId}`)).json();
  const token = new URL(deposit.payUrl).pathname.split("/").pop()!;
  const { url } = await (await api.post(`/api/pay/${token}/checkout`, { data: {} })).json();
  const paid = await api.post(`/api/pay/${token}/test-checkout`, { data: { sessionId: new URL(url, "http://x").searchParams.get("session"), outcome: "card" } });
  expect((await paid.json()).ok).toBe(true);
  const workOrderId = (await (await api.get(`/api/estimates/${est.id}`)).json()).workOrder.id as string;
  const techs = (await (await api.get("/api/technicians")).json()).items as { id: string; name: string }[];
  const { today } = await (await api.get("/api/obligations/due?limit=1")).json();
  const scheduled = await api.post(`/api/work-orders/${workOrderId}/schedule`, { data: { technicianId: techs.find((t) => t.name === "Tess Tech")!.id, scheduledDate: today } });
  expect(scheduled.status()).toBe(201);
  return { id: est.id as string, depositId, depositNumber: deposit.number as string, workOrderId, jobId: (await scheduled.json()).visits[0].jobId as string };
}

test("cancelled accepted work with a paid deposit: refunded in one case, kept with a reason in the other, decided only by the office", async ({ page }) => {
  test.setTimeout(240_000);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const jobs: string[] = [];
  let connected = false;
  const tag = crypto.randomUUID().slice(0, 8);

  try {
    await signIn(page);
    const org = (await db.query("select m.organization_id as id from memberships m join users u on u.id = m.user_id where u.email = 'owner@example.com'")).rows[0].id as string;
    connected = await connectQuickBooks(page);

    for (const disposition of ["refund", "keep"] as const) {
      const e = await acceptedWithPaidDeposit(page.request, db, `Row 9 ${disposition} ${tag}`);
      jobs.push(e.jobId);

      // The office cancels the accepted work.
      await page.goto(`/estimates/${e.id}`);
      await expect(page.getByTestId("deposit-received")).toHaveText("$150.00");
      await page.getByRole("button", { name: "Cancel the work" }).click();
      await page.getByLabel("Why cancel?").fill("The homeowner sold the house");
      await page.getByRole("button", { name: "Cancel the accepted work" }).click();
      await expect(page.getByTestId("estimate-status")).toHaveText("Cancelled after acceptance");
      expect((await db.query("select status from work_orders where id = $1", [e.workOrderId])).rows[0].status).toBe("cancelled");
      expect((await db.query("select status from jobs where id = $1", [e.jobId])).rows[0].status).toBe("cancelled");
      expect(await db.query("select state from coverage_uses where work_order_id = $1 and state <> 'released'", [e.workOrderId]).then((r) => r.rowCount)).toBe(0);

      // Nothing is refunded or kept on its own: the money waits, and the inbox asks.
      const ledger = async () => (await db.query("select kind, amount_cents, reason from deposit_ledger where deposit_invoice_id = $1 order by seq", [e.depositId])).rows as { kind: string; amount_cents: number; reason: string | null }[];
      expect((await ledger()).map((l) => l.kind)).toEqual(["received"]);
      await page.goto("/inbox");
      const item = page.locator("li.card").filter({ hasText: "Deposit disposition needed" }).filter({ hasText: e.depositNumber });
      await expect(item).toBeVisible();
      await item.getByRole("link", { name: "Refund or keep" }).click();
      // The deposit invoice sends the office on to its estimate, where the deposit is settled.
      await page.waitForURL(`**/invoices/${e.depositId}`);
      await page.getByRole("link", { name: /^EST-\d+$/ }).click();
      await page.waitForURL(`**/estimates/${e.id}`);
      const panel = page.getByTestId("deposit-panel");
      await expect(panel).toBeVisible();
      await expect(page.getByTestId("deposit-free")).toHaveText("$150.00");

      if (disposition === "refund") {
        await panel.getByRole("button", { name: "Refund the deposit" }).click();
        await panel.getByLabel("Reason").fill("Work cancelled before it started");
        await panel.getByRole("button", { name: "Save" }).click();
        await expect(panel.locator("dt", { hasText: "Refunded" })).toBeVisible();
        await expect(page.getByTestId("deposit-free")).toHaveText("$0.00");
        expect((await ledger()).map((l) => [l.kind, l.amount_cents])).toEqual([
          ["received", 15000],
          ["refunded", 15000],
        ]);
        expect((await db.query("select status from refunds where payment_id in (select id from payments where invoice_id = $1)", [e.depositId])).rows.map((r) => r.status)).toEqual(["succeeded"]);
      } else {
        await panel.getByRole("button", { name: "Keep it" }).click();
        await panel.getByLabel("Reason").fill("Kept under the estimate's cancellation terms");
        await panel.getByRole("button", { name: "Save" }).click();
        await expect(panel.locator("dt", { hasText: "Kept" })).toBeVisible();
        await expect(page.getByTestId("deposit-free")).toHaveText("$0.00");
        expect((await ledger()).map((l) => [l.kind, l.amount_cents, l.reason])).toEqual([
          ["received", 15000, null],
          ["retained", 15000, "Kept under the estimate's cancellation terms"],
        ]);
        expect(await db.query("select id from refunds where payment_id in (select id from payments where invoice_id = $1)", [e.depositId]).then((r) => r.rowCount)).toBe(0);
      }

      // The decision is made: the inbox no longer asks.
      await page.goto("/inbox");
      await expect(page.locator("li.card").filter({ hasText: "Deposit disposition needed" }).filter({ hasText: e.depositNumber })).toHaveCount(0);

      // QuickBooks: the deposit is held behind its mapping conflict, so no Refund Receipt is written.
      syncQuickBooksOnce(org);
      const link = async (type: string, id: string) => (await db.query("select status, conflict_kind, external_id from quickbooks_links where entity_type = $1 and entity_id = $2", [type, id])).rows[0];
      expect(await link("invoice", e.depositId)).toMatchObject({ status: "conflict", conflict_kind: "deposit_mapping_missing", external_id: null });
      if (disposition === "refund") {
        const refundId = (await db.query("select r.id from refunds r join payments p on p.id = r.payment_id where p.invoice_id = $1", [e.depositId])).rows[0].id as string;
        const refundLink = await link("refund", refundId);
        expect(refundLink?.external_id ?? null, JSON.stringify(refundLink)).toBeNull();
        expect(refundLink?.status ?? "none").not.toBe("synced");
      }
    }
  } finally {
    // Later specs count today's visits on the route and map: these move to yesterday.
    if (jobs.length) await db.query("update jobs set scheduled_date = scheduled_date - 1 where id = any($1)", [jobs]);
    if (connected) await disconnectQuickBooks(page);
    await db.end();
  }
});
