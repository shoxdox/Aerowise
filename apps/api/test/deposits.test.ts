import { depositBalances, reversedOn, TestPaymentProvider } from "@aerowise/payments";
import { reconcileRefunds } from "@aerowise/tasks";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createTenant, setupTestApp, type TestContext } from "./helpers.ts";

// SW-5b deposits (service workflows plan §3.6), with the built-in test payment provider only:
// the ledger's balances, refunds that are reserved and booked only when the provider says the
// money moved, webhooks replayed and out of order, and the ledger equality after every step.

const payments = new TestPaymentProvider();
const ctx = setupTestApp({ features: ["work_orders", "service_items", "estimates", "deposits"], payments });

afterEach(() => {
  payments.refundOutcome = "succeeded";
  payments.dropRefundResponses = 0;
});

async function tenant(c: TestContext, name = "Org A") {
  const t = await createTenant(c, name);
  await t.api.patch(`/contacts/${t.contact.id}`, { email: "pat@example.test" });
  expect((await t.api.post("/billing/stripe/connect", {})).statusCode).toBe(200);
  expect((await t.api.post("/billing/stripe/refresh", {})).json().stripe.chargesEnabled).toBe(true);
  const org = await c.db.selectFrom("organizations").select("stripeAccountId").where("id", "=", t.org.id).executeTakeFirstOrThrow();
  return { ...t, accountId: org.stripeAccountId! };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

/** An estimate for `workCents` of untaxed work asking for `depositCents`, accepted by the office. */
async function accepted(t: Tenant, workCents: number, depositCents: number) {
  const e = await t.api.post("/estimates", { siteId: t.site.id, lines: [{ description: "Replace aerator", quantity: 1, unitPriceCents: workCents }], depositCents });
  expect(e.statusCode, e.body).toBe(201);
  const r = await t.api.post(`/estimates/${e.json().id}/record-acceptance`, { evidence: "Signed paper copy" });
  expect(r.statusCode, r.body).toBe(200);
  const est = r.json();
  expect(est.deposit).toMatchObject({ requestedCents: depositCents, invoice: { status: "open", totalCents: depositCents } });
  return { estimateId: est.id as string, depositId: est.deposit.invoice.id as string, workOrderId: est.workOrder.id as string };
}

async function webhook(c: TestContext, t: Tenant, type: string, object: Record<string, unknown>) {
  const e = payments.signedEvent(type, object, t.accountId);
  const res = await c.app.inject({ method: "POST", url: "/webhooks/stripe", payload: e.body, headers: { "content-type": "application/json", "stripe-signature": e.signature } });
  expect(res.statusCode, res.body).toBe(200);
  return { res, e };
}

/** A card payment through checkout, as Stripe reports it. Returns its PaymentIntent id. */
async function payByCard(c: TestContext, t: Tenant, invoiceId: string, amount: number, name: string) {
  await webhook(c, t, "checkout.session.completed", {
    id: `cs_test_${name}`,
    object: "checkout.session",
    payment_status: "paid",
    payment_intent: `pi_test_${name}`,
    amount_total: amount,
    metadata: { organizationId: t.org.id, invoiceId },
  });
  return `pi_test_${name}`;
}

const refundObject = (o: { id: string; pi: string; amount: number; status: string; refundId?: string }) => ({
  id: o.id,
  object: "refund",
  payment_intent: o.pi,
  amount: o.amount,
  status: o.status,
  failure_reason: o.status === "failed" ? "expired_or_canceled_card" : null,
  metadata: o.refundId ? { refundId: o.refundId } : {},
});

/** The work order's final invoice, issued; `depositCents` as the office asks, else all free money. */
async function issueFinal(t: Tenant, workOrderId: string, depositCents?: number) {
  const made = await t.api.post(`/work-orders/${workOrderId}/invoice`, {});
  expect([200, 201], made.body).toContain(made.statusCode);
  const res = await t.api.post(`/invoices/${made.json().invoiceId}/issue`, { send: false, ...(depositCents !== undefined ? { depositCents } : {}) });
  return { id: made.json().invoiceId as string, res };
}

/** The work came in cheaper than estimated: the work order's one line, repriced before invoicing. */
async function reprice(workOrderId: string, cents: number) {
  await ctx.db.updateTable("workOrderLines").set({ unitPriceCents: cents }).where("workOrderId", "=", workOrderId).execute();
}

const balances = (t: Tenant, depositId: string) => depositBalances(ctx.db, t.org.id, depositId);
const ledger = async (depositId: string) =>
  (await ctx.db.selectFrom("depositLedger").select(["kind", "amountCents"]).where("depositInvoiceId", "=", depositId).orderBy("seq").execute()).map((r) => [r.kind, r.amountCents]);
const refundRows = (depositId: string) =>
  ctx.db
    .selectFrom("refunds as f")
    .innerJoin("payments as p", "p.id", "f.paymentId")
    .select(["f.id", "f.status", "f.amountCents", "f.providerRefundId", "f.idempotencyKey", "f.reservation"])
    .where("p.invoiceId", "=", depositId)
    .orderBy("f.createdAt")
    .execute();

/**
 * The plan's ledger equality, P + Σ due_F = Σ (G_F − C_F) + T + U + Q − S, for an estimate.
 * F's columns stay as issued; a deposit reversal is the credit on F (C_F) and comes off what
 * is applied to it, which leaves F's amount due unchanged.
 */
async function expectEquality(t: Tenant, estimateId: string) {
  const links = await ctx.db.selectFrom("estimateInvoices").select(["invoiceId", "role", "voidedAt"]).where("estimateId", "=", estimateId).execute();
  const d = links.find((l) => l.role === "deposit")!;
  const finals = links.filter((l) => l.role === "final");
  const ids = [d.invoiceId, ...finals.map((f) => f.invoiceId)];
  const p = await sql<{ p: number }>`
    select coalesce(sum(p.amount_cents), 0)::int - coalesce((select sum(f.amount_cents) from refunds f join payments q on q.id = f.payment_id where q.invoice_id = any(${ids}::uuid[]) and f.status = 'succeeded'), 0)::int as p
    from payments p where p.invoice_id = any(${ids}::uuid[]) and p.status = 'succeeded'`.execute(ctx.db);
  let due = 0;
  let worth = 0;
  for (const f of finals.filter((x) => x.voidedAt === null)) {
    const inv = await ctx.db.selectFrom("invoices").selectAll().where("id", "=", f.invoiceId).executeTakeFirstOrThrow();
    const reversed = await reversedOn(ctx.db, t.org.id, f.invoiceId);
    const g = inv.subtotalCents - inv.discountCents + inv.taxCents;
    const credits = inv.creditedCents + reversed;
    due += g - (inv.depositAppliedCents - reversed) - credits - inv.paidCents;
    worth += g - credits;
  }
  const b = await balances(t, d.invoiceId);
  expect(b.free, "U is never negative").toBeGreaterThanOrEqual(0);
  expect(p.rows[0]!.p + due).toBe(worth + b.retained + b.free + b.reserved - b.shortfall);
  return b;
}

const inbox = async (t: Tenant) => (await t.api.get("/inbox")).json().items.filter((i: { kind: string }) => i.kind.startsWith("deposit_"));

describe("deposits", () => {
  it("issues one untaxed deposit invoice on acceptance and shows it on the homeowner's estimate", async () => {
    const t = await tenant(ctx);
    await t.api.patch("/billing/settings", { defaultTaxRateBps: 825 });
    const e = await t.api.post("/estimates", { siteId: t.site.id, lines: [{ description: "Replace aerator", quantity: 1, unitPriceCents: 50000, taxable: true }], depositCents: 20000 });
    expect(e.json().draft.depositCents).toBe(20000);
    await t.api.post(`/estimates/${e.json().id}/send`, { email: false });
    const token = (await t.api.post(`/estimates/${e.json().id}/link`, {})).json().url.split("/estimate/")[1];
    expect((await ctx.app.inject({ method: "GET", url: `/estimate/${token}` })).json()).toMatchObject({ version: { depositCents: 20000 }, deposit: null });
    const est = (await t.api.get(`/estimates/${e.json().id}`)).json();
    const acc = await ctx.app.inject({
      method: "POST",
      url: `/estimate/${token}/accept`,
      payload: { version: 1, selectedOptionalLineIds: [], signerName: "Pat Homeowner", signature: { kind: "typed" }, agree: true },
    });
    expect(acc.statusCode, acc.body).toBe(200);
    const pub = (await ctx.app.inject({ method: "GET", url: `/estimate/${token}` })).json();
    expect(pub.deposit).toMatchObject({ amountCents: 20000, paymentStatus: "unpaid" });
    expect(pub.deposit.payUrl).toMatch(/\/pay\/[A-Za-z0-9_-]+$/);
    const detail = (await t.api.get(`/estimates/${est.id}`)).json();
    const d = await ctx.db.selectFrom("invoices").selectAll().where("id", "=", detail.deposit.invoice.id).executeTakeFirstOrThrow();
    // H-DEP-1: an untaxed prepayment, never tied to the work order's own invoice.
    expect(d).toMatchObject({ status: "open", taxCents: 0, totalCents: 20000, workOrderId: null });
    const signed = await ctx.db.selectFrom("signedDocuments").select("content").where("estimateId", "=", est.id).executeTakeFirstOrThrow();
    expect((signed.content as { depositCents: number }).depositCents).toBe(20000);

    // A deposit invoice's payment is refunded from the deposit, never by the generic route.
    const pi = await payByCard(ctx, t, d.id, 20000, "dep1");
    const pay = await ctx.db.selectFrom("payments").select("id").where("providerPaymentId", "=", pi).executeTakeFirstOrThrow();
    expect((await t.api.post(`/payments/${pay.id}/refund`, { amountCents: 100, reason: "test" })).statusCode).toBe(409);
    expect(await ledger(d.id)).toEqual([["received", 20000]]);
    await expectEquality(t, est.id);
  });

  it("caps the deposit at the accepted total and needs the deposits feature to ask for one", async () => {
    const t = await tenant(ctx);
    const e = (await t.api.post("/estimates", { siteId: t.site.id, lines: [{ description: "Small job", quantity: 1, unitPriceCents: 5000, optional: true }, { description: "Visit", quantity: 1, unitPriceCents: 1000 }], depositCents: 4000 })).json();
    await t.api.post(`/estimates/${e.id}/send`, { email: false });
    const r = (await t.api.post(`/estimates/${e.id}/record-acceptance`, { selectedOptionalLineIds: [], evidence: "Phone" })).json();
    expect(r.deposit.invoice.totalCents).toBe(1000);
  });

  it("applies a deposit to a partly paid final invoice and keeps the equality", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 12000, 5000);
    await payByCard(ctx, t, a.depositId, 5000, "p1");
    await expectEquality(t, a.estimateId);
    const f = await issueFinal(t, a.workOrderId);
    expect(f.res.statusCode, f.res.body).toBe(200);
    expect(f.res.json()).toMatchObject({ subtotalCents: 12000, depositAppliedCents: 5000, totalCents: 7000, amountDueCents: 7000 });
    const pdfTotals = (await ctx.db.selectFrom("invoices").select("snapshot").where("id", "=", f.id).executeTakeFirstOrThrow()).snapshot as { depositAppliedCents: number; totalCents: number };
    expect(pdfTotals).toMatchObject({ depositAppliedCents: 5000, totalCents: 7000 });
    expect((await t.api.post(`/invoices/${f.id}/payments`, { amountCents: 3000, method: "check", receivedOn: "2026-03-01" })).statusCode).toBe(200);
    expect((await t.api.get(`/invoices/${f.id}`)).json()).toMatchObject({ paymentStatus: "partial", amountDueCents: 4000 });
    const b = await expectEquality(t, a.estimateId);
    expect(b).toMatchObject({ received: 5000, applied: 5000, free: 0, shortfall: 0 });
    const link = await ctx.db.selectFrom("estimateInvoices").selectAll().where("invoiceId", "=", f.id).executeTakeFirstOrThrow();
    expect(link).toMatchObject({ role: "final", replacesInvoiceId: null, voidedAt: null });
  });

  it("funds a final invoice entirely from the deposit, $0 due, then refunds the whole job", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 8000, 8000);
    await payByCard(ctx, t, a.depositId, 8000, "full");
    const f = await issueFinal(t, a.workOrderId);
    expect(f.res.json()).toMatchObject({ depositAppliedCents: 8000, totalCents: 0, paymentStatus: "paid", amountDueCents: 0 });
    await expectEquality(t, a.estimateId);
    // More than was applied: refused.
    expect((await t.api.post(`/invoices/${f.id}/refund-job`, { amountCents: 8001, reason: "Job cancelled" })).statusCode).toBe(409);
    const r = await t.api.post(`/invoices/${f.id}/refund-job`, { amountCents: 8000, reason: "Job cancelled" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().deposit.balances).toMatchObject({ returned: 8000, applied: 0, free: 0, shortfall: 0 });
    expect(await reversedOn(ctx.db, t.org.id, f.id)).toBe(8000);
    // F's own columns are as issued: nothing is owed again.
    expect((await t.api.get(`/invoices/${f.id}`)).json()).toMatchObject({ totalCents: 0, amountDueCents: 0 });
    await expectEquality(t, a.estimateId);
  });

  it("refunds everything the customer paid: the invoice's payment and the deposit applied to it", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 10000, 6000);
    await payByCard(ctx, t, a.depositId, 6000, "d");
    const f = await issueFinal(t, a.workOrderId);
    await payByCard(ctx, t, f.id, 4000, "f");
    expect((await t.api.get(`/invoices/${f.id}`)).json().paymentStatus).toBe("paid");
    const r = await t.api.post(`/invoices/${f.id}/refund-job`, { amountCents: 10000, reason: "Customer unhappy" });
    expect(r.statusCode, r.body).toBe(200);
    expect((await t.api.get(`/invoices/${f.id}`)).json()).toMatchObject({ paidCents: 0, creditedCents: 4000, amountDueCents: 0, paymentStatus: "refunded" });
    expect(await ledger(a.depositId)).toEqual([
      ["received", 6000],
      ["applied", 6000],
      ["deposit_reversal", 6000],
    ]);
    const b = await expectEquality(t, a.estimateId);
    expect(b).toMatchObject({ received: 6000, returned: 6000, applied: 0, free: 0 });
  });

  it("follows the worked example: two external refunds, replays, a refused apply, void, release, and apply up to what is free", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    const pi = await payByCard(ctx, t, a.depositId, 10000, "we");
    const f = await issueFinal(t, a.workOrderId);
    expect(f.res.json()).toMatchObject({ depositAppliedCents: 10000, totalCents: 10000 });

    const first = await webhook(ctx, t, "refund.updated", refundObject({ id: "re_ext_1", pi, amount: 2000, status: "succeeded" }));
    expect(await balances(t, a.depositId)).toMatchObject({ returned: 2000, applied: 10000, shortfall: 2000, free: 0 });
    const second = await webhook(ctx, t, "refund.updated", refundObject({ id: "re_ext_2", pi, amount: 3000, status: "succeeded" }));
    expect(await balances(t, a.depositId)).toMatchObject({ returned: 5000, applied: 10000, shortfall: 5000, free: 0 });
    await expectEquality(t, a.estimateId);

    // Replays: the same events again, and the same refunds in new events. Nothing changes.
    for (const e of [first.e, second.e]) {
      const res = await ctx.app.inject({ method: "POST", url: "/webhooks/stripe", payload: e.body, headers: { "content-type": "application/json", "stripe-signature": e.signature } });
      expect(res.statusCode).toBe(200);
    }
    await webhook(ctx, t, "refund.updated", refundObject({ id: "re_ext_1", pi, amount: 2000, status: "succeeded" }));
    await webhook(ctx, t, "refund.created", refundObject({ id: "re_ext_2", pi, amount: 3000, status: "succeeded" }));
    expect(await ledger(a.depositId)).toEqual([
      ["received", 10000],
      ["applied", 10000],
      ["refunded_external", 2000],
      ["shortfall", 2000],
      ["refunded_external", 3000],
      ["shortfall", 3000],
    ]);
    expect(await balances(t, a.depositId)).toMatchObject({ shortfall: 5000, free: 0 });

    // One more cent cannot be taken from D, by refund or by keeping it.
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { amountCents: 1, reason: "x" })).json()).toMatchObject({ error: "deposit_not_available" });
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain`, { amountCents: 1, reason: "x" })).statusCode).toBe(409);
    expect((await inbox(t)).map((i: { kind: string }) => i.kind)).toEqual(["deposit_shortfall"]);

    // Void F: everything applied comes back and the shortfall it no longer needs is released.
    expect((await t.api.post(`/invoices/${f.id}/void`, { reason: "Wrong lines" })).statusCode).toBe(200);
    expect((await ledger(a.depositId)).slice(-2)).toEqual([
      ["unapplied", 10000],
      ["shortfall_released", 5000],
    ]);
    expect(await expectEquality(t, a.estimateId)).toMatchObject({ applied: 0, shortfall: 0, free: 5000 });

    // F2 replaces F; applying 6000 is refused, 5000 is applied; asking again returns F2.
    const made = await t.api.post(`/work-orders/${a.workOrderId}/invoice`, {});
    expect(made.statusCode).toBe(201);
    const f2 = made.json().invoiceId as string;
    expect((await t.api.post(`/invoices/${f2}/issue`, { send: false, depositCents: 6000 })).json()).toMatchObject({ error: "deposit_not_available" });
    expect((await t.api.get(`/invoices/${f2}`)).json().status).toBe("draft");
    const issued = await t.api.post(`/invoices/${f2}/issue`, { send: false, depositCents: 5000 });
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json()).toMatchObject({ depositAppliedCents: 5000, totalCents: 15000 });
    expect(await ctx.db.selectFrom("estimateInvoices").select(["replacesInvoiceId", "voidedAt"]).where("invoiceId", "=", f2).executeTakeFirstOrThrow()).toEqual({ replacesInvoiceId: f.id, voidedAt: null });
    expect((await t.api.post(`/work-orders/${a.workOrderId}/invoice`, {})).json()).toMatchObject({ invoiceId: f2 });
    expect(await expectEquality(t, a.estimateId)).toMatchObject({ applied: 5000, shortfall: 0, free: 0 });
  });

  it("books a shortfall only for the real deficit when the final invoice took part of the deposit, and resolves it", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 10000, 10000);
    const pi = await payByCard(ctx, t, a.depositId, 10000, "part");
    // A deposit larger than the final amount: applied only up to F's total (I4).
    const f = await issueFinal(t, a.workOrderId);
    expect(f.res.json()).toMatchObject({ depositAppliedCents: 10000, totalCents: 0 });
    // Shrink the work: void and bill 6000 instead.
    await t.api.post(`/invoices/${f.id}/void`, { reason: "Less work" });
    await reprice(a.workOrderId, 6000);
    const f2 = await issueFinal(t, a.workOrderId);
    expect(f2.res.json()).toMatchObject({ depositAppliedCents: 6000, totalCents: 0 });
    expect(await balances(t, a.depositId)).toMatchObject({ applied: 6000, free: 4000 });
    expect((await inbox(t)).map((i: { kind: string }) => i.kind)).toEqual(["deposit_unapplied"]);

    await webhook(ctx, t, "refund.updated", refundObject({ id: "re_ext_part", pi, amount: 5000, status: "succeeded" }));
    expect(await expectEquality(t, a.estimateId)).toMatchObject({ returned: 5000, applied: 6000, shortfall: 1000, free: 0 });
    expect((await inbox(t)).map((i: { kind: string; detail: string }) => [i.kind, i.detail.includes("$10.00")])).toEqual([["deposit_shortfall", true]]);
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/shortfall`, { kind: "write_off", amountCents: 1001, reason: "Goodwill" })).statusCode).toBe(409);
    const w = await t.api.post(`/invoices/${a.depositId}/deposit/shortfall`, { kind: "write_off", amountCents: 1000, reason: "Goodwill" });
    expect(w.statusCode, w.body).toBe(200);
    expect(w.json().deposit.balances).toMatchObject({ shortfall: 1000, shortfallOutstanding: 0, overResolved: 0 });
    expect(await inbox(t)).toEqual([]);
  });

  it("keeps a retained remainder out of refunds and applies until the keeping is reversed", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 10000, 10000);
    await payByCard(ctx, t, a.depositId, 10000, "ret");
    await reprice(a.workOrderId, 6000);
    const f = await issueFinal(t, a.workOrderId);
    expect(await balances(t, a.depositId)).toMatchObject({ applied: 6000, free: 4000 });
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain`, { amountCents: 4001, reason: "Cancellation fee" })).statusCode).toBe(409);
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain`, { amountCents: 4000, reason: "Cancellation fee" })).statusCode).toBe(200);
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { amountCents: 1, reason: "x" })).statusCode).toBe(409);

    // Voiding F frees what was applied, never what was kept.
    await t.api.post(`/invoices/${f.id}/void`, { reason: "Redo" });
    expect(await balances(t, a.depositId)).toMatchObject({ applied: 0, retained: 4000, free: 6000 });
    // The replacement bills the full work again; kept money still cannot go on it.
    await reprice(a.workOrderId, 10000);
    const draft = (await t.api.post(`/work-orders/${a.workOrderId}/invoice`, {})).json().invoiceId;
    expect((await t.api.post(`/invoices/${draft}/issue`, { send: false, depositCents: 6001 })).json()).toMatchObject({ error: "deposit_not_available" });
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain-reverse`, { amountCents: 4001, reason: "x" })).statusCode).toBe(409);
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain-reverse`, { amountCents: 1000, reason: "Fee waived in part" })).statusCode).toBe(200);
    expect((await t.api.post(`/invoices/${draft}/issue`, { send: false, depositCents: 6000 })).statusCode).toBe(200);
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { amountCents: 1000, reason: "Rest of the deposit" })).statusCode).toBe(200);
    expect(await expectEquality(t, a.estimateId)).toMatchObject({ applied: 6000, retained: 3000, returned: 1000, free: 0 });
  });

  it("serializes applying the deposit and a refund webhook on the deposit's lock", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    const pi = await payByCard(ctx, t, a.depositId, 10000, "race");
    const draft = (await t.api.post(`/work-orders/${a.workOrderId}/invoice`, {})).json().invoiceId;
    const e = payments.signedEvent("refund.updated", refundObject({ id: "re_race", pi, amount: 4000, status: "succeeded" }), t.accountId);
    const [issued, hook] = await Promise.all([
      t.api.post(`/invoices/${draft}/issue`, { send: false }),
      ctx.app.inject({ method: "POST", url: "/webhooks/stripe", payload: e.body, headers: { "content-type": "application/json", "stripe-signature": e.signature } }),
    ]);
    expect([issued.statusCode, hook.statusCode]).toEqual([200, 200]);
    const b = await expectEquality(t, a.estimateId);
    // Either order: the refund before (6000 applied, no deficit) or after (10000 applied, 4000 short).
    expect([b.applied, b.shortfall].join()).toMatch(/^(6000,0|10000,4000)$/);
    expect(issued.json().depositAppliedCents).toBe(b.applied);

    // Two refunds of the same free money at once: one is refused.
    const t2 = await tenant(ctx, "Org B");
    const a2 = await accepted(t2, 20000, 10000);
    await payByCard(ctx, t2, a2.depositId, 10000, "race2");
    const both = await Promise.all([
      t2.api.post(`/invoices/${a2.depositId}/deposit/refund`, { amountCents: 6000, reason: "one" }),
      t2.api.post(`/invoices/${a2.depositId}/deposit/refund`, { amountCents: 6000, reason: "two" }),
    ]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await expectEquality(t2, a2.estimateId)).toMatchObject({ returned: 6000, free: 4000 });
  });

  it("reserves a pending refund, refuses the same money twice, and books it once when it succeeds", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    const pi = await payByCard(ctx, t, a.depositId, 10000, "pend");
    payments.refundOutcome = "pending";
    const r = await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { amountCents: 3000, reason: "Smaller job" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().deposit.balances).toMatchObject({ reserved: 3000, free: 7000, returned: 0 });
    expect(await ledger(a.depositId)).toEqual([["received", 10000]]);
    await expectEquality(t, a.estimateId);
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { amountCents: 7001, reason: "x" })).json()).toMatchObject({ error: "deposit_not_available" });

    const [row] = await refundRows(a.depositId);
    expect(row).toMatchObject({ status: "pending", reservation: "deposit_free" });
    expect(row!.providerRefundId).toBe(payments.refundIdFor(row!.idempotencyKey!));
    for (let i = 0; i < 2; i++) await webhook(ctx, t, "refund.updated", refundObject({ id: row!.providerRefundId!, pi, amount: 3000, status: "succeeded", refundId: row!.id }));
    expect(await ledger(a.depositId)).toEqual([
      ["received", 10000],
      ["refunded", 3000],
    ]);
    expect(await expectEquality(t, a.estimateId)).toMatchObject({ reserved: 0, returned: 3000, free: 7000 });
    expect(await refundRows(a.depositId)).toHaveLength(1);
  });

  it("releases a reservation once when the refund fails, with one Refund failed item", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    const pi = await payByCard(ctx, t, a.depositId, 10000, "fail");
    payments.refundOutcome = "pending";
    await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { amountCents: 3000, reason: "Smaller job" });
    const [row] = await refundRows(a.depositId);
    expect(await balances(t, a.depositId)).toMatchObject({ reserved: 3000, free: 7000 });
    for (let i = 0; i < 2; i++) await webhook(ctx, t, "refund.updated", refundObject({ id: row!.providerRefundId!, pi, amount: 3000, status: "failed", refundId: row!.id }));
    expect(await ledger(a.depositId)).toEqual([["received", 10000]]);
    expect(await expectEquality(t, a.estimateId)).toMatchObject({ reserved: 0, returned: 0, free: 10000 });
    const items = await inbox(t);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "deposit_refund_failed", title: "Refund failed" });
  });

  it("credits the final invoice for the job refund's deposit part only when it succeeds, and only once", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 10000, 6000);
    const pi = await payByCard(ctx, t, a.depositId, 6000, "rj");
    const f = await issueFinal(t, a.workOrderId);
    payments.refundOutcome = "pending";
    const r = await t.api.post(`/invoices/${f.id}/refund-job`, { amountCents: 6000, reason: "Not needed" });
    expect(r.statusCode, r.body).toBe(200);
    // Pending: nothing is booked and F is unchanged; the same applied money cannot be reserved twice.
    expect(await reversedOn(ctx.db, t.org.id, f.id)).toBe(0);
    expect((await t.api.post(`/invoices/${f.id}/refund-job`, { amountCents: 1, reason: "x" })).json()).toMatchObject({ error: "deposit_not_available" });
    // Nor can F be voided under the pending reversal.
    expect((await t.api.post(`/invoices/${f.id}/void`, { reason: "x" })).json()).toMatchObject({ error: "refund_pending" });
    await expectEquality(t, a.estimateId);
    const [row] = await refundRows(a.depositId);
    expect(row).toMatchObject({ reservation: "deposit_applied", status: "pending" });
    for (let i = 0; i < 2; i++) await webhook(ctx, t, "refund.updated", refundObject({ id: row!.providerRefundId!, pi, amount: 6000, status: "succeeded", refundId: row!.id }));
    expect(await reversedOn(ctx.db, t.org.id, f.id)).toBe(6000);
    expect((await ledger(a.depositId)).filter(([k]) => k === "deposit_reversal")).toEqual([["deposit_reversal", 6000]]);
    expect((await t.api.get(`/invoices/${f.id}`)).json()).toMatchObject({ totalCents: 4000, amountDueCents: 4000 });
    expect(await expectEquality(t, a.estimateId)).toMatchObject({ applied: 0, returned: 6000, free: 0, shortfall: 0 });
  });

  it("leaves the final invoice unchanged when the job refund's deposit part fails", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 10000, 10000);
    const pi = await payByCard(ctx, t, a.depositId, 10000, "rjf");
    await reprice(a.workOrderId, 8000);
    const f = await issueFinal(t, a.workOrderId);
    const before = (await t.api.get(`/invoices/${f.id}`)).json();
    payments.refundOutcome = "pending";
    expect((await t.api.post(`/invoices/${f.id}/refund-job`, { amountCents: 8000, reason: "Not needed" })).statusCode).toBe(200);
    const [row] = await refundRows(a.depositId);
    for (let i = 0; i < 2; i++) await webhook(ctx, t, "refund.updated", refundObject({ id: row!.providerRefundId!, pi, amount: 8000, status: "failed", refundId: row!.id }));
    expect(await reversedOn(ctx.db, t.org.id, f.id)).toBe(0);
    const after = (await t.api.get(`/invoices/${f.id}`)).json();
    expect([after.totalCents, after.amountDueCents, after.paymentStatus]).toEqual([before.totalCents, before.amountDueCents, before.paymentStatus]);
    expect(await expectEquality(t, a.estimateId)).toMatchObject({ applied: 8000, free: 2000 });
    expect((await inbox(t)).filter((i: { kind: string }) => i.kind === "deposit_refund_failed")).toMatchObject([{ target: { type: "invoice", id: f.id } }]);
  });

  it("asks again with the same key when the provider's answer was lost: one refund, one settlement", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    await payByCard(ctx, t, a.depositId, 10000, "lost");
    payments.dropRefundResponses = 1;
    const r = await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { amountCents: 2000, reason: "Lost answer" });
    expect(r.statusCode, r.body).toBe(200);
    const [row] = await refundRows(a.depositId);
    expect(row).toMatchObject({ status: "pending", providerRefundId: null });
    expect(r.json().deposit.balances).toMatchObject({ reserved: 2000, free: 8000 });
    // Too soon: the request may still be finishing.
    expect(await reconcileRefunds(ctx.db, payments, () => ctx.now)).toEqual({ sent: 0, failed: 0 });
    ctx.now = new Date(ctx.now.getTime() + 6 * 60_000);
    expect(await reconcileRefunds(ctx.db, payments, () => ctx.now)).toEqual({ sent: 1, failed: 0 });
    const calls = payments.refunds.filter((c) => c.idempotencyKey === row!.idempotencyKey);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.metadata.refundId).toBe(row!.id);
    const [settled] = await refundRows(a.depositId);
    expect(settled).toMatchObject({ status: "succeeded", providerRefundId: payments.refundIdFor(row!.idempotencyKey!) });
    expect(await ledger(a.depositId)).toEqual([
      ["received", 10000],
      ["refunded", 2000],
    ]);
    expect(await reconcileRefunds(ctx.db, payments, () => ctx.now)).toEqual({ sent: 0, failed: 0 });
    await expectEquality(t, a.estimateId);
  });

  it("settles a reservation from a webhook that arrives before the route stored the provider's id, never as an external refund", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    const pi = await payByCard(ctx, t, a.depositId, 10000, "early");
    payments.dropRefundResponses = 1;
    await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { amountCents: 2500, reason: "Early webhook" });
    const [row] = await refundRows(a.depositId);
    const providerId = payments.refundIdFor(row!.idempotencyKey!)!;
    expect(row!.providerRefundId).toBeNull();
    // Metadata naming the reservation is trusted only when payment and amount agree.
    const forged = await webhook(ctx, t, "refund.updated", refundObject({ id: "re_test_forged", pi, amount: 9999, status: "succeeded", refundId: row!.id }));
    expect(await ctx.db.selectFrom("stripeEvents").select("outcome").where("id", "=", forged.e.event.id).executeTakeFirstOrThrow()).toEqual({ outcome: "ignored: refund does not match the reservation it names" });
    expect(await ledger(a.depositId)).toEqual([["received", 10000]]);

    await webhook(ctx, t, "refund.created", refundObject({ id: providerId, pi, amount: 2500, status: "succeeded", refundId: row!.id }));
    expect(await refundRows(a.depositId)).toMatchObject([{ id: row!.id, status: "succeeded", providerRefundId: providerId }]);
    expect(await ledger(a.depositId)).toEqual([
      ["received", 10000],
      ["refunded", 2500],
    ]);
    // The late answer or the reconcile task finds it settled and does nothing more.
    ctx.now = new Date(ctx.now.getTime() + 6 * 60_000);
    expect(await reconcileRefunds(ctx.db, payments, () => ctx.now)).toEqual({ sent: 0, failed: 0 });
    expect(await expectEquality(t, a.estimateId)).toMatchObject({ returned: 2500, reserved: 0, free: 7500 });
  });

  it("refuses to cancel the estimate while its deposit is payable or held, and allows it once settled", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    expect((await t.api.post(`/estimates/${a.estimateId}/cancel`, { reason: "Changed mind" })).json()).toMatchObject({ error: "work_started", message: expect.stringContaining("Void the deposit invoice") });
    await payByCard(ctx, t, a.depositId, 10000, "cancel");
    expect((await t.api.post(`/estimates/${a.estimateId}/cancel`, { reason: "Changed mind" })).json().message).toContain("Refund or keep it first");
    await t.api.post(`/invoices/${a.depositId}/deposit/retain`, { amountCents: 2000, reason: "Cancellation fee" });
    await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { amountCents: 8000, reason: "Cancelled" });
    const c = await t.api.post(`/estimates/${a.estimateId}/cancel`, { reason: "Changed mind" });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().deposit.balances).toMatchObject({ retained: 2000, returned: 8000, free: 0 });
  });

  it("keeps the ledger append-only and rejects an unreconciled write at commit", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    await payByCard(ctx, t, a.depositId, 10000, "ao");
    await expect(sql`update deposit_ledger set amount_cents = 1`.execute(ctx.db)).rejects.toThrow(/never changed/);
    await expect(sql`delete from deposit_ledger`.execute(ctx.db)).rejects.toThrow(/never changed/);
    // Retaining more than was received without a shortfall entry breaks I1.
    await expect(
      ctx.db
        .insertInto("depositLedger")
        .values({ organizationId: t.org.id, depositInvoiceId: a.depositId, estimateId: a.estimateId, kind: "retained", amountCents: 20000, causeKey: "manual", reason: "x" })
        .execute(),
    ).rejects.toThrow(/not reconciled/);
  });
});
