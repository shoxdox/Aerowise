import { runMonthlyBilling, TestBillingProvider } from "@aerowise/billing";
import { DEFAULT_SUBSCRIPTION_CONFIG, type SubscriptionState } from "@aerowise/domain";
import { drainTasks, scheduleBillingRuns } from "@aerowise/tasks";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createTenant, setupTestApp, type TestContext } from "./helpers.ts";

const ctx = setupTestApp();
const config = DEFAULT_SUBSCRIPTION_CONFIG;

type Tenant = Awaited<ReturnType<typeof createTenant>>;

async function addSite(t: Tenant, n: number) {
  return (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: `${n} Oak St`, city: "Austin" })).json();
}

/**
 * Org A on 2026-03-01 (ctx.now): one contract in force, one ending later (counted), one ended,
 * one cancelled, one not started yet. Two in force in all.
 */
async function orgWithContracts(c: TestContext, name = "Org A") {
  const t = await createTenant(c, name);
  const plan = (await t.api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
  const contract = async (siteId: string, startOn: string) => {
    const res = await t.api.post(`/sites/${siteId}/contracts`, { planId: plan.id, startOn });
    expect(res.statusCode).toBe(201);
    return res.json();
  };
  await contract(t.site.id, "2026-01-15");
  const ending = await contract((await addSite(t, 2)).id, "2026-02-01");
  expect((await t.api.post(`/contracts/${ending.id}/cancel`, { reason: "Selling the house", discontinuedBy: "owner", serviceEndsOn: "2026-04-30" })).statusCode).toBeLessThan(300);
  await contract((await addSite(t, 3)).id, "2024-06-01");
  const cancelled = await contract((await addSite(t, 4)).id, "2026-02-01");
  expect((await t.api.post(`/contracts/${cancelled.id}/cancel`, { reason: "Moved away" })).statusCode).toBeLessThan(300);
  await contract((await addSite(t, 5)).id, "2026-04-01");
  return { ...t, plan, contract };
}

async function setPlan(c: TestContext, organizationId: string, state: SubscriptionState, overrides: { price?: number; minimum?: number } = {}) {
  await c.db
    .updateTable("organizations")
    .set({
      subscriptionState: state,
      subscriptionEndsOn: state === "trial" || state === "design_partner" ? "2026-12-31" : null,
      pricePerContractCentsOverride: overrides.price ?? null,
      monthlyMinimumCentsOverride: overrides.minimum ?? null,
    })
    .where("id", "=", organizationId)
    .execute();
}

const periods = (c: TestContext) => c.db.selectFrom("billingPeriods").selectAll().orderBy("startsOn").execute();

describe("monthly active-contract count", () => {
  it("counts contracts in force on the month's first day, including ending ones, per organization", async () => {
    const a = await orgWithContracts(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const bPlan = (await b.api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
    expect((await b.api.post(`/sites/${b.site.id}/contracts`, { planId: bPlan.id, startOn: "2026-02-15" })).statusCode).toBe(201);
    await setPlan(ctx, a.org.id, "active");

    const provider = new TestBillingProvider();
    const resultA = await runMonthlyBilling(ctx.db, { provider, config, now: ctx.now }, a.org.id);
    const resultB = await runMonthlyBilling(ctx.db, { provider, config, now: ctx.now }, b.org.id);
    expect(resultA).toMatchObject({ counted: true, invoiced: true, status: "open" });
    // Org B is still on the default plan from before W4 (active), so it is invoiced too.
    expect(resultB).toMatchObject({ counted: true });

    const rows = await periods(ctx);
    const rowA = rows.find((r) => r.organizationId === a.org.id)!;
    const rowB = rows.find((r) => r.organizationId === b.org.id)!;
    expect(rowA).toMatchObject({
      startsOn: "2026-03-01",
      endsOn: "2026-03-31",
      countedOn: "2026-03-01",
      activeContracts: 2,
      subscriptionState: "active",
      pricePerContractCents: 150,
      monthlyMinimumCents: 9900,
      amountCents: 9900,
    });
    expect(rowB.activeContracts).toBe(1);
  });

  it("stores the count with each month and never changes it", async () => {
    const a = await orgWithContracts(ctx);
    await setPlan(ctx, a.org.id, "active");
    const provider = new TestBillingProvider();
    await runMonthlyBilling(ctx.db, { provider, config, now: ctx.now }, a.org.id);

    // A contract added later in the month does not change the month already counted.
    await a.contract((await addSite(a, 6)).id, "2026-03-01");
    const again = await runMonthlyBilling(ctx.db, { provider, config, now: new Date("2026-03-20T15:00:00Z") }, a.org.id);
    expect(again).toMatchObject({ counted: false, invoiced: false, status: "open" });
    expect((await periods(ctx)).map((p) => p.activeContracts)).toEqual([2]);
    expect(provider.invoices).toHaveLength(1);
    await expect(sql`update billing_periods set active_contracts = 5`.execute(ctx.db)).rejects.toThrow(/never change/);

    // The next month is a new count: the extra contract, and the one starting in April.
    const april = await runMonthlyBilling(ctx.db, { provider, config, now: new Date("2026-04-01T15:00:00Z") }, a.org.id);
    expect(april.counted).toBe(true);
    expect((await periods(ctx)).map((p) => [p.startsOn, p.activeContracts])).toEqual([
      ["2026-03-01", 2],
      ["2026-04-01", 4],
    ]);
  });

  it("uses the organization's time zone for the month", async () => {
    const a = await orgWithContracts(ctx);
    await setPlan(ctx, a.org.id, "active");
    // 03:00 UTC on April 1 is still March 31 in Texas.
    await runMonthlyBilling(ctx.db, { provider: null, config, now: new Date("2026-04-01T03:00:00Z") }, a.org.id);
    expect((await periods(ctx))[0]?.startsOn).toBe("2026-03-01");
  });
});

describe("monthly amount", () => {
  it("tops a small month up to the minimum, with a line for each", async () => {
    const a = await orgWithContracts(ctx);
    await setPlan(ctx, a.org.id, "active");
    const provider = new TestBillingProvider();
    await runMonthlyBilling(ctx.db, { provider, config, now: ctx.now }, a.org.id);

    expect(provider.customers).toEqual([expect.objectContaining({ organizationId: a.org.id, name: "Org A" })]);
    const org = await ctx.db.selectFrom("organizations").select("billingCustomerId").where("id", "=", a.org.id).executeTakeFirstOrThrow();
    expect(org.billingCustomerId).toBe(provider.customers[0]?.customerId);

    const [invoice] = provider.invoices;
    expect(invoice).toMatchObject({ description: "Aerowise, March 2026", totalCents: 9900, metadata: { organizationId: a.org.id } });
    expect(invoice?.lines).toEqual([
      { description: "Active maintenance contracts at $1.50 each", quantity: 2, unitAmountCents: 150 },
      { description: "Monthly minimum of $99.00", quantity: 1, unitAmountCents: 9600 },
    ]);
    const [period] = await periods(ctx);
    expect(period).toMatchObject({ status: "open", provider: "test", providerInvoiceId: invoice?.invoiceId, hostedInvoiceUrl: expect.stringContaining(invoice!.invoiceId) });
  });

  it("charges the founder price and minimum when set", async () => {
    const a = await orgWithContracts(ctx);
    await setPlan(ctx, a.org.id, "active", { price: 100, minimum: 0 });
    const provider = new TestBillingProvider();
    await runMonthlyBilling(ctx.db, { provider, config, now: ctx.now }, a.org.id);
    expect((await periods(ctx))[0]).toMatchObject({ activeContracts: 2, pricePerContractCents: 100, monthlyMinimumCents: 0, amountCents: 200 });
    expect(provider.invoices[0]?.lines).toEqual([{ description: "Active maintenance contracts at $1.00 each", quantity: 2, unitAmountCents: 100 }]);
  });

  it("uses the configured prices", async () => {
    const a = await orgWithContracts(ctx);
    await setPlan(ctx, a.org.id, "past_due");
    const provider = new TestBillingProvider();
    await runMonthlyBilling(ctx.db, { provider, config: { ...config, pricePerContractCents: 6000, monthlyMinimumCents: 5000 }, now: ctx.now }, a.org.id);
    expect((await periods(ctx))[0]).toMatchObject({ subscriptionState: "past_due", amountCents: 12000, status: "open" });
  });

  it("counts but does not charge free periods and read-only accounts", async () => {
    const provider = new TestBillingProvider();
    for (const [i, state] of (["trial", "design_partner", "read_only"] as const).entries()) {
      const t = await orgWithContracts(ctx, `Org ${i}`);
      await setPlan(ctx, t.org.id, state);
      expect(await runMonthlyBilling(ctx.db, { provider, config, now: ctx.now }, t.org.id)).toMatchObject({ status: "free", invoiced: false });
    }
    const rows = await periods(ctx);
    expect(rows.map((r) => [r.subscriptionState, r.activeContracts, r.amountCents, r.status]).sort()).toEqual([
      ["design_partner", 2, 0, "free"],
      ["read_only", 2, 0, "free"],
      ["trial", 2, 0, "free"],
    ]);
    expect(provider.invoices).toHaveLength(0);
    expect(provider.customers).toHaveLength(0);
  });
});

describe("invoicing retries", () => {
  it("leaves the month pending when Stripe fails, and invoices it once on the next run", async () => {
    const a = await orgWithContracts(ctx);
    await setPlan(ctx, a.org.id, "active");
    const provider = new TestBillingProvider();
    provider.failNext = 1;
    await expect(runMonthlyBilling(ctx.db, { provider, config, now: ctx.now }, a.org.id)).rejects.toThrow(/unreachable/);
    expect((await periods(ctx))[0]).toMatchObject({ status: "pending", activeContracts: 2, providerInvoiceId: null });

    expect(await runMonthlyBilling(ctx.db, { provider, config, now: ctx.now }, a.org.id)).toMatchObject({ counted: false, invoiced: true, status: "open" });
    expect(await runMonthlyBilling(ctx.db, { provider, config, now: ctx.now }, a.org.id)).toMatchObject({ invoiced: false });
    expect(provider.invoices).toHaveLength(1);
  });

  it("counts without invoicing when no billing provider is configured", async () => {
    const a = await orgWithContracts(ctx);
    await setPlan(ctx, a.org.id, "active");
    expect(await runMonthlyBilling(ctx.db, { provider: null, config, now: ctx.now }, a.org.id)).toMatchObject({ status: "pending", invoiced: false });
    const provider = new TestBillingProvider();
    expect(await runMonthlyBilling(ctx.db, { provider, config, now: ctx.now }, a.org.id)).toMatchObject({ status: "open", invoiced: true });
  });

  it("runs from the worker's queue once per interval for every organization", async () => {
    const a = await orgWithContracts(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    await setPlan(ctx, a.org.id, "active");
    await setPlan(ctx, b.org.id, "trial");
    const provider = new TestBillingProvider();
    await scheduleBillingRuns(ctx.db, ctx.now, 3_600_000);
    await scheduleBillingRuns(ctx.db, ctx.now, 3_600_000);
    await drainTasks({ db: ctx.db, store: ctx.store, now: () => ctx.now, billing: { provider, config } });
    const rows = await periods(ctx);
    expect(rows.map((r) => r.status).sort()).toEqual(["free", "open"]);
    expect(provider.invoices).toHaveLength(1);
    const tasks = await ctx.db.selectFrom("backgroundTasks").select("kind").where("kind", "=", "billing.monthly_run").execute();
    expect(tasks).toHaveLength(2);
  });
});

describe("Stripe Billing webhook", () => {
  async function invoicedMonth() {
    const a = await orgWithContracts(ctx);
    await setPlan(ctx, a.org.id, "active");
    const provider = new TestBillingProvider();
    await runMonthlyBilling(ctx.db, { provider, config, now: ctx.now }, a.org.id);
    return { provider, invoiceId: provider.invoices[0]!.invoiceId, orgId: a.org.id };
  }

  const deliver = (e: { body: string; signature: string }) =>
    ctx.app.inject({ method: "POST", url: "/webhooks/stripe-billing", payload: e.body, headers: { "content-type": "application/json", "stripe-signature": e.signature } });

  it("marks the month paid, once, and a later failure does not undo it", async () => {
    const { provider, invoiceId, orgId } = await invoicedMonth();
    const paid = provider.signedEvent("invoice.paid", { id: invoiceId, object: "invoice" });
    expect((await deliver(paid)).json()).toEqual({ received: true, outcome: "applied" });
    expect((await deliver(paid)).json()).toEqual({ received: true, outcome: "duplicate" });
    expect((await periods(ctx))[0]?.status).toBe("paid");

    await deliver(provider.signedEvent("invoice.payment_failed", { id: invoiceId, object: "invoice" }));
    expect((await periods(ctx))[0]?.status).toBe("paid");
    const events = await ctx.db.selectFrom("billingEvents").select(["type", "organizationId"]).orderBy("receivedAt").execute();
    expect(events).toEqual([
      { type: "invoice.paid", organizationId: orgId },
      { type: "invoice.payment_failed", organizationId: orgId },
    ]);
  });

  it("records a failed payment and a retry that reopens it", async () => {
    const { provider, invoiceId } = await invoicedMonth();
    await deliver(provider.signedEvent("invoice.payment_failed", { id: invoiceId, object: "invoice" }));
    expect((await periods(ctx))[0]?.status).toBe("failed");
    await deliver(provider.signedEvent("invoice.paid", { id: invoiceId, object: "invoice" }));
    expect((await periods(ctx))[0]?.status).toBe("paid");
  });

  it("ignores invoices it did not issue and refuses unsigned or Connect-signed requests", async () => {
    const provider = new TestBillingProvider();
    expect((await deliver(provider.signedEvent("invoice.paid", { id: "in_someone_else", object: "invoice" }))).json().outcome).toBe("ignored");
    expect((await deliver(provider.signedEvent("customer.created", { id: "cus_1", object: "customer" }))).json().outcome).toBe("ignored");

    const good = provider.signedEvent("invoice.paid", { id: "in_x", object: "invoice" });
    expect((await deliver({ body: good.body, signature: "t=1,v1=deadbeef" })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: "/webhooks/stripe-billing", payload: good.body, headers: { "content-type": "application/json" } })).statusCode).toBe(400);
    // A Stripe Connect (homeowner payments) signature is not valid here: the two are kept apart.
    const { TestPaymentProvider } = await import("@aerowise/payments");
    const connect = new TestPaymentProvider().signedEvent("invoice.paid", { id: "in_x" }, "acct_1");
    expect((await deliver(connect)).statusCode).toBe(400);
  });
});
