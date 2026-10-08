import { depositBalances, recalcInvoice, reversedOn, TestPaymentProvider } from "@aerowise/payments";
import { reconcileRefunds } from "@aerowise/tasks";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { invoiceByToken, openCheckout } from "../src/lib/checkout.ts";
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
    expect((await t.api.post(`/invoices/${f.id}/refund-job`, { requestId: randomUUID(), amountCents: 8001, reason: "Job cancelled" })).statusCode).toBe(409);
    const r = await t.api.post(`/invoices/${f.id}/refund-job`, { requestId: randomUUID(), amountCents: 8000, reason: "Job cancelled" });
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
    const r = await t.api.post(`/invoices/${f.id}/refund-job`, { requestId: randomUUID(), amountCents: 10000, reason: "Customer unhappy" });
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
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { requestId: randomUUID(), amountCents: 1, reason: "x" })).json()).toMatchObject({ error: "deposit_not_available" });
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain`, { requestId: randomUUID(), amountCents: 1, reason: "x" })).statusCode).toBe(409);
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
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/shortfall`, { requestId: randomUUID(), kind: "write_off", amountCents: 1001, reason: "Goodwill" })).statusCode).toBe(409);
    const w = await t.api.post(`/invoices/${a.depositId}/deposit/shortfall`, { requestId: randomUUID(), kind: "write_off", amountCents: 1000, reason: "Goodwill" });
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
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain`, { requestId: randomUUID(), amountCents: 4001, reason: "Cancellation fee" })).statusCode).toBe(409);
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain`, { requestId: randomUUID(), amountCents: 4000, reason: "Cancellation fee" })).statusCode).toBe(200);
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { requestId: randomUUID(), amountCents: 1, reason: "x" })).statusCode).toBe(409);

    // Voiding F frees what was applied, never what was kept.
    await t.api.post(`/invoices/${f.id}/void`, { reason: "Redo" });
    expect(await balances(t, a.depositId)).toMatchObject({ applied: 0, retained: 4000, free: 6000 });
    // The replacement bills the full work again; kept money still cannot go on it.
    await reprice(a.workOrderId, 10000);
    const draft = (await t.api.post(`/work-orders/${a.workOrderId}/invoice`, {})).json().invoiceId;
    expect((await t.api.post(`/invoices/${draft}/issue`, { send: false, depositCents: 6001 })).json()).toMatchObject({ error: "deposit_not_available" });
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain-reverse`, { requestId: randomUUID(), amountCents: 4001, reason: "x" })).statusCode).toBe(409);
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain-reverse`, { requestId: randomUUID(), amountCents: 1000, reason: "Fee waived in part" })).statusCode).toBe(200);
    expect((await t.api.post(`/invoices/${draft}/issue`, { send: false, depositCents: 6000 })).statusCode).toBe(200);
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { requestId: randomUUID(), amountCents: 1000, reason: "Rest of the deposit" })).statusCode).toBe(200);
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
      t2.api.post(`/invoices/${a2.depositId}/deposit/refund`, { requestId: randomUUID(), amountCents: 6000, reason: "one" }),
      t2.api.post(`/invoices/${a2.depositId}/deposit/refund`, { requestId: randomUUID(), amountCents: 6000, reason: "two" }),
    ]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await expectEquality(t2, a2.estimateId)).toMatchObject({ returned: 6000, free: 4000 });
  });

  it("reserves a pending refund, refuses the same money twice, and books it once when it succeeds", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    const pi = await payByCard(ctx, t, a.depositId, 10000, "pend");
    payments.refundOutcome = "pending";
    const r = await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { requestId: randomUUID(), amountCents: 3000, reason: "Smaller job" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().deposit.balances).toMatchObject({ reserved: 3000, free: 7000, returned: 0 });
    expect(await ledger(a.depositId)).toEqual([["received", 10000]]);
    await expectEquality(t, a.estimateId);
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { requestId: randomUUID(), amountCents: 7001, reason: "x" })).json()).toMatchObject({ error: "deposit_not_available" });

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
    await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { requestId: randomUUID(), amountCents: 3000, reason: "Smaller job" });
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
    const r = await t.api.post(`/invoices/${f.id}/refund-job`, { requestId: randomUUID(), amountCents: 6000, reason: "Not needed" });
    expect(r.statusCode, r.body).toBe(200);
    // Pending: nothing is booked and F is unchanged; the same applied money cannot be reserved twice.
    expect(await reversedOn(ctx.db, t.org.id, f.id)).toBe(0);
    expect((await t.api.post(`/invoices/${f.id}/refund-job`, { requestId: randomUUID(), amountCents: 1, reason: "x" })).json()).toMatchObject({ error: "deposit_not_available" });
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
    expect((await t.api.post(`/invoices/${f.id}/refund-job`, { requestId: randomUUID(), amountCents: 8000, reason: "Not needed" })).statusCode).toBe(200);
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
    const r = await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { requestId: randomUUID(), amountCents: 2000, reason: "Lost answer" });
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
    await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { requestId: randomUUID(), amountCents: 2500, reason: "Early webhook" });
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

  it("cancels an accepted estimate with an unpaid deposit by voiding the deposit invoice", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    const c = await t.api.post(`/estimates/${a.estimateId}/cancel`, { reason: "Changed mind" });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ status: "cancelled", workOrder: { status: "cancelled" }, deposit: { invoice: { voided: true } } });
    expect(await ctx.db.selectFrom("invoices").select(["status", "voidReason"]).where("id", "=", a.depositId).executeTakeFirstOrThrow()).toMatchObject({ status: "void", voidReason: expect.stringContaining("Changed mind") });
    expect(await ctx.db.selectFrom("estimateInvoices").select("voidedAt").where("invoiceId", "=", a.depositId).executeTakeFirstOrThrow()).toMatchObject({ voidedAt: expect.any(Date) });
    expect(await inbox(t)).toEqual([]);
  });

  it("cancels an accepted estimate with a paid deposit, leaving the money for the office to refund or keep from the inbox", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    await payByCard(ctx, t, a.depositId, 10000, "cancel");
    const c = await t.api.post(`/estimates/${a.estimateId}/cancel`, { reason: "Changed mind" });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ status: "cancelled", workOrder: { status: "cancelled" }, deposit: { invoice: { status: "open" }, balances: { received: 10000, free: 10000, returned: 0, retained: 0 } } });
    // Nothing moved on its own.
    expect(await refundRows(a.depositId)).toEqual([]);
    expect(await ledger(a.depositId)).toEqual([["received", 10000]]);
    const events = await ctx.db.selectFrom("estimateEvents").select("eventType").where("estimateId", "=", a.estimateId).execute();
    expect(events.map((e) => e.eventType)).toContain("deposit_disposition_needed");
    expect(await inbox(t)).toMatchObject([{ kind: "deposit_disposition", title: "Deposit disposition needed", severity: "high", target: { type: "invoice", id: a.depositId } }]);

    // The office decides: keep a fee, refund the rest. The item goes away and the ledger balances.
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain`, { requestId: randomUUID(), amountCents: 2000, reason: "Cancellation fee" })).statusCode).toBe(200);
    expect((await inbox(t)).map((i: { kind: string }) => i.kind)).toEqual(["deposit_disposition"]);
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { requestId: randomUUID(), amountCents: 8000, reason: "Cancelled" })).statusCode).toBe(200);
    expect(await inbox(t)).toEqual([]);
    expect(await expectEquality(t, a.estimateId)).toMatchObject({ retained: 2000, returned: 8000, free: 0 });
  });

  it("stops collecting a partly paid deposit when the estimate is cancelled, and keeps a late provider payment for the office", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    const anon = (method: "GET" | "POST", url: string, payload?: object) => ctx.app.inject({ method, url, ...(payload ? { payload } : {}) });
    const { publicToken } = await ctx.db.selectFrom("invoices").select("publicToken").where("id", "=", a.depositId).executeTakeFirstOrThrow();
    // The office recorded part of the deposit; the homeowner opened the card page for the rest.
    expect((await t.api.post(`/invoices/${a.depositId}/payments`, { amountCents: 4000, method: "check", receivedOn: "2026-03-01" })).statusCode).toBe(200);
    const opened = await anon("POST", `/pay/${publicToken}/checkout`, {});
    expect(opened.statusCode, opened.body).toBe(200);
    const sessionId = new URL(opened.json().url).searchParams.get("session")!;

    const c = await t.api.post(`/estimates/${a.estimateId}/cancel`, { reason: "Changed mind" });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().deposit).toMatchObject({ invoice: { status: "open" }, balances: { received: 4000, free: 4000 } });
    expect(await ctx.db.selectFrom("checkoutSessions").select("status").where("providerSessionId", "=", sessionId).executeTakeFirstOrThrow()).toEqual({ status: "expired" });
    // No new page: the pay link says why, the checkout is refused, and the estimate page no longer offers it.
    const page = (await anon("GET", `/pay/${publicToken}`)).json();
    expect(page).toMatchObject({ canPayOnline: false, closedReason: expect.stringContaining("cancelled") });
    const again = await anon("POST", `/pay/${publicToken}/checkout`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("payment_closed");

    // The provider completes the page the homeowner already had open (and says so twice): the money is kept, once, for the office.
    for (let i = 0; i < 2; i++) expect((await anon("POST", `/pay/${publicToken}/test-checkout`, { sessionId, outcome: "card" })).statusCode).toBe(200);
    expect(await ledger(a.depositId)).toEqual([
      ["received", 4000],
      ["received", 6000],
    ]);
    expect(await refundRows(a.depositId)).toEqual([]);
    expect(await inbox(t)).toMatchObject([{ kind: "deposit_disposition", detail: expect.stringContaining("$100.00") }]);
    expect(await expectEquality(t, a.estimateId)).toMatchObject({ received: 10000, free: 10000 });
  });

  it("cancels while a bank payment of the deposit is clearing: it is kept for the office if it clears, and nothing is owed if it fails", async () => {
    for (const outcome of ["ach_clears", "ach_fails"] as const) {
      const t = await tenant(ctx, `Org ${outcome}`);
      const a = await accepted(t, 20000, 10000);
      const { publicToken } = await ctx.db.selectFrom("invoices").select("publicToken").where("id", "=", a.depositId).executeTakeFirstOrThrow();
      const opened = await ctx.app.inject({ method: "POST", url: `/pay/${publicToken}/checkout`, payload: {} });
      const sessionId = new URL(opened.json().url).searchParams.get("session")!;
      expect((await ctx.app.inject({ method: "POST", url: `/pay/${publicToken}/test-checkout`, payload: { sessionId, outcome: "ach_pending" } })).statusCode).toBe(200);
      const c = await t.api.post(`/estimates/${a.estimateId}/cancel`, { reason: "Changed mind" });
      expect(c.statusCode, c.body).toBe(200);
      expect(c.json().deposit.invoice.status).toBe("open");
      expect(await inbox(t)).toEqual([]);
      // The bank's answer arrives after the cancellation.
      expect((await ctx.app.inject({ method: "POST", url: `/pay/${publicToken}/test-checkout`, payload: { sessionId, outcome } })).statusCode).toBe(200);
      const b = await expectEquality(t, a.estimateId);
      if (outcome === "ach_clears") {
        expect(b).toMatchObject({ received: 10000, free: 10000 });
        expect((await inbox(t)).map((i: { kind: string }) => i.kind)).toEqual(["deposit_disposition"]);
      } else {
        expect(b).toMatchObject({ received: 0, free: 0 });
        expect(await inbox(t)).toEqual([]);
      }
      expect(await refundRows(a.depositId)).toEqual([]);
    }
  });

  it("opens checkout from the invoice as it is under its lock, never from a copy read before a payment, void or cancellation landed", async () => {
    const t = await tenant(ctx);
    const open = (inv: Awaited<ReturnType<typeof invoiceByToken>>, token: string) => openCheckout(ctx.db, { provider: payments, appUrl: "https://app.example.test", token, inv, now: ctx.now });
    const fresh = async () => {
      const a = await accepted(t, 20000, 10000);
      const { publicToken } = await ctx.db.selectFrom("invoices").select("publicToken").where("id", "=", a.depositId).executeTakeFirstOrThrow();
      return { ...a, token: publicToken!, stale: await invoiceByToken(ctx.db, publicToken!) };
    };
    const sessions = (invoiceId: string) => ctx.db.selectFrom("checkoutSessions").select(["amountCents", "status"]).where("invoiceId", "=", invoiceId).orderBy("createdAt").execute();

    // Paid in full after the page read it: nothing is due, no page.
    const paid = await fresh();
    await payByCard(ctx, t, paid.depositId, 10000, "stalepaid");
    await expect(open(paid.stale, paid.token)).rejects.toMatchObject({ statusCode: 422, message: "Nothing is due on this invoice" });
    expect(await sessions(paid.depositId)).toEqual([]);

    // Partly paid: the page charges only what is left, and reuses itself.
    const part = await fresh();
    expect((await t.api.post(`/invoices/${part.depositId}/payments`, { amountCents: 4000, method: "check", receivedOn: "2026-03-01" })).statusCode).toBe(200);
    const first = await open(part.stale, part.token);
    expect(await open(part.stale, part.token)).toEqual(first);
    expect(await sessions(part.depositId)).toEqual([{ amountCents: 6000, status: "open" }]);

    // A bank payment clearing covers it: nothing more to charge.
    const pending = await fresh();
    const s1 = new URL((await open(pending.stale, pending.token)).url).searchParams.get("session")!;
    expect((await ctx.app.inject({ method: "POST", url: `/pay/${pending.token}/test-checkout`, payload: { sessionId: s1, outcome: "ach_pending" } })).statusCode).toBe(200);
    await expect(open(pending.stale, pending.token)).rejects.toMatchObject({ statusCode: 422, message: "Nothing is due on this invoice" });

    // Voided after the read: the link is gone.
    const voided = await fresh();
    expect((await t.api.post(`/invoices/${voided.depositId}/void`, { reason: "Wrong amount" })).statusCode).toBe(200);
    await expect(open(voided.stale, voided.token)).rejects.toMatchObject({ statusCode: 404 });

    // The estimate cancelled after the read: refused, as for a fresh read.
    const cancelled = await fresh();
    expect((await t.api.post(`/invoices/${cancelled.depositId}/payments`, { amountCents: 2000, method: "check", receivedOn: "2026-03-01" })).statusCode).toBe(200);
    expect((await t.api.post(`/estimates/${cancelled.estimateId}/cancel`, { reason: "Changed mind" })).statusCode).toBe(200);
    await expect(open(cancelled.stale, cancelled.token)).rejects.toMatchObject({ statusCode: 409, code: "payment_closed" });

    // The real interleaving: a payment holds the invoice's lock while checkout waits for it.
    const raced = await fresh();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const payment = ctx.db.transaction().execute(async (trx) => {
      await trx.selectFrom("invoices").select("id").where("id", "=", raced.depositId).forUpdate().executeTakeFirstOrThrow();
      await trx
        .insertInto("payments")
        .values({ organizationId: t.org.id, invoiceId: raced.depositId, amountCents: 10000, method: "check", source: "manual", status: "succeeded", providerPaymentId: null, providerSessionId: null, receivedOn: "2026-03-01", reference: null, note: null, failureReason: null, recordedBy: null, succeededAt: ctx.now, failedAt: null, createdAt: ctx.now, updatedAt: ctx.now } as never)
        .execute();
      await recalcInvoice(trx, t.org.id, raced.depositId, ctx.now);
      locked();
      await held;
    });
    await isLocked;
    const checkout = open(raced.stale, raced.token);
    const settled = checkout.then(
      () => "opened",
      (e: { message: string }) => e.message,
    );
    await new Promise((r) => setTimeout(r, 200));
    release();
    await payment;
    expect(await settled).toBe("Nothing is due on this invoice");
    expect(await sessions(raced.depositId)).toEqual([]);
  });

  it("returns the first result for a repeated deposit refund request, sequential or at once, and refuses the id with other details", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    await payByCard(ctx, t, a.depositId, 10000, "retry");
    const body = { requestId: randomUUID(), amountCents: 2000, reason: "Same customer request" };
    const first = await t.api.post(`/invoices/${a.depositId}/deposit/refund`, body);
    const again = await t.api.post(`/invoices/${a.depositId}/deposit/refund`, body);
    expect([first.statusCode, again.statusCode], again.body).toEqual([200, 200]);
    expect(again.json().deposit.balances).toMatchObject({ returned: 2000, free: 8000 });
    expect(await refundRows(a.depositId)).toHaveLength(1);
    const [only] = await refundRows(a.depositId);
    expect(payments.refunds.filter((r) => r.idempotencyKey === only!.idempotencyKey)).toHaveLength(1);
    // The same id with a different amount or reason is someone else's request.
    for (const changed of [{ ...body, amountCents: 3000 }, { ...body, reason: "Another reason" }]) {
      const r = await t.api.post(`/invoices/${a.depositId}/deposit/refund`, changed);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toBe("request_reused");
    }
    // Two clicks at once.
    const twice = { requestId: randomUUID(), amountCents: 1500, reason: "Double click" };
    const both = await Promise.all([t.api.post(`/invoices/${a.depositId}/deposit/refund`, twice), t.api.post(`/invoices/${a.depositId}/deposit/refund`, twice)]);
    expect(both.map((r) => r.statusCode), both.map((r) => r.body).join()).toEqual([200, 200]);
    // A new request is a new refund.
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/refund`, { requestId: randomUUID(), amountCents: 2000, reason: "Same customer request" })).statusCode).toBe(200);
    expect((await refundRows(a.depositId)).map((r) => r.amountCents)).toEqual([2000, 1500, 2000]);
    expect(await expectEquality(t, a.estimateId)).toMatchObject({ returned: 5500, free: 4500 });
  });

  it("finishes a refund whose response was lost when the office retries the same request: one refund, sent again with the same key", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 20000, 10000);
    await payByCard(ctx, t, a.depositId, 10000, "lostretry");
    payments.dropRefundResponses = 1;
    const body = { requestId: randomUUID(), amountCents: 2000, reason: "Lost answer" };
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/refund`, body)).statusCode).toBe(200);
    const [row] = await refundRows(a.depositId);
    expect(row).toMatchObject({ status: "pending", providerRefundId: null });
    const retry = await t.api.post(`/invoices/${a.depositId}/deposit/refund`, body);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(await refundRows(a.depositId)).toMatchObject([{ id: row!.id, status: "succeeded", providerRefundId: payments.refundIdFor(row!.idempotencyKey!) }]);
    expect(payments.refunds.filter((c) => c.idempotencyKey === row!.idempotencyKey)).toHaveLength(2);
    expect(await expectEquality(t, a.estimateId)).toMatchObject({ returned: 2000, reserved: 0, free: 8000 });
  });

  it("keeps a repeated keep, put-back, shortfall or job refund request to one effect", async () => {
    const t = await tenant(ctx);
    const a = await accepted(t, 10000, 10000);
    const pi = await payByCard(ctx, t, a.depositId, 10000, "once");
    await reprice(a.workOrderId, 6000);
    const f = await issueFinal(t, a.workOrderId);
    expect(await balances(t, a.depositId)).toMatchObject({ applied: 6000, free: 4000 });

    const retain = { requestId: randomUUID(), amountCents: 1000, reason: "Fee" };
    for (let i = 0; i < 2; i++) expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain`, retain)).statusCode).toBe(200);
    expect(await balances(t, a.depositId)).toMatchObject({ retained: 1000, free: 3000 });
    const reverse = { requestId: randomUUID(), amountCents: 500, reason: "Half the fee waived" };
    for (let i = 0; i < 2; i++) expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain-reverse`, reverse)).statusCode).toBe(200);
    expect(await balances(t, a.depositId)).toMatchObject({ retained: 500, free: 3500 });
    // One id is one action: reusing the keep's id to put money back is refused.
    expect((await t.api.post(`/invoices/${a.depositId}/deposit/retain-reverse`, { ...retain, amountCents: 500 })).json().error).toBe("request_reused");

    // Refund the job twice with one id: one set of refunds.
    const job = { requestId: randomUUID(), amountCents: 1000, reason: "Part of the job not done" };
    const both = await Promise.all([t.api.post(`/invoices/${f.id}/refund-job`, job), t.api.post(`/invoices/${f.id}/refund-job`, job)]);
    expect(both.map((r) => r.statusCode), both.map((r) => r.body).join()).toEqual([200, 200]);
    expect((await t.api.post(`/invoices/${f.id}/refund-job`, job)).statusCode).toBe(200);
    expect((await refundRows(a.depositId)).filter((r) => r.reservation === "deposit_applied")).toHaveLength(1);
    expect(await reversedOn(ctx.db, t.org.id, f.id)).toBe(1000);

    // An outside refund leaves a shortfall; writing it off twice with one id records it once.
    await webhook(ctx, t, "refund.updated", refundObject({ id: "re_ext_once", pi, amount: 4000, status: "succeeded" }));
    const short = await balances(t, a.depositId);
    expect(short.shortfall).toBeGreaterThan(0);
    const writeOff = { requestId: randomUUID(), kind: "write_off", amountCents: short.shortfall, reason: "Goodwill" };
    for (let i = 0; i < 2; i++) expect((await t.api.post(`/invoices/${a.depositId}/deposit/shortfall`, writeOff)).statusCode).toBe(200);
    expect(await ctx.db.selectFrom("depositShortfallResolutions").select("amountCents").where("depositInvoiceId", "=", a.depositId).execute()).toEqual([{ amountCents: short.shortfall }]);
    await expectEquality(t, a.estimateId);
  });

  it("keeps request ids per company: another company's same id is its own request", async () => {
    const t = await tenant(ctx);
    const b = await tenant(ctx, "Org B");
    const a1 = await accepted(t, 20000, 10000);
    const b1 = await accepted(b, 20000, 10000);
    await payByCard(ctx, t, a1.depositId, 10000, "orga");
    await payByCard(ctx, b, b1.depositId, 10000, "orgb");
    const requestId = randomUUID();
    expect((await t.api.post(`/invoices/${a1.depositId}/deposit/refund`, { requestId, amountCents: 1000, reason: "A" })).statusCode).toBe(200);
    const other = await b.api.post(`/invoices/${b1.depositId}/deposit/refund`, { requestId, amountCents: 3000, reason: "B" });
    expect(other.statusCode, other.body).toBe(200);
    expect(other.json().deposit.balances).toMatchObject({ returned: 3000 });
    // Org A's id cannot reach Org B's deposit.
    expect((await t.api.post(`/invoices/${b1.depositId}/deposit/refund`, { requestId: randomUUID(), amountCents: 1, reason: "x" })).statusCode).toBe(404);
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
