import type { EmailMessage, EmailResult, EmailTransport } from "@aerowise/compliance";
import { TestPaymentProvider } from "@aerowise/payments";
import { drainTasks } from "@aerowise/tasks";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";

const ctx = setupTestApp();

class FakeMail implements EmailTransport {
  readonly name = "fake";
  delivered = new Map<string, EmailMessage>();
  async send(m: EmailMessage): Promise<EmailResult> {
    if (!this.delivered.has(m.idempotencyKey)) this.delivered.set(m.idempotencyKey, m);
    return { messageId: `<${m.idempotencyKey}@fake>`, acceptedAt: new Date().toISOString(), response: {} };
  }
}
const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail, appUrl: "https://app.example.test" });
const stripe = new TestPaymentProvider();

const LINES = [
  { description: "Aerator repair", quantity: 1, unitPriceCents: 30000 },
  { description: "Chlorine tablets", quantity: 2, unitPriceCents: 1250, taxable: true },
];

/** A tenant whose customer has a billing email and whose Stripe account is ready. */
async function billingTenant(c: TestContext, name = "Org A", opts: { email?: boolean; stripe?: boolean } = {}) {
  const t = await createTenant(c, name);
  if (opts.email !== false) await t.api.post(`/customers/${t.customer.id}/contacts`, { name: "Billing", email: `billing@${name.replace(/\W/g, "").toLowerCase()}.test`, type: "billing" });
  if (opts.stripe !== false) {
    expect((await t.api.post("/billing/stripe/connect", {})).statusCode).toBe(200);
    expect((await t.api.post("/billing/stripe/refresh", {})).json().stripe.chargesEnabled).toBe(true);
  }
  const org = await c.db.selectFrom("organizations").select("stripeAccountId").where("id", "=", t.org.id).executeTakeFirstOrThrow();
  return { ...t, accountId: org.stripeAccountId };
}

async function issued(t: Awaited<ReturnType<typeof billingTenant>>, lines: object[] = LINES, send = true) {
  const draft = (await t.api.post("/invoices", { customerId: t.customer.id, siteId: t.site.id, lines })).json();
  const res = await t.api.post(`/invoices/${draft.id}/issue`, { send });
  expect(res.statusCode).toBe(200);
  const inv = res.json();
  return { ...inv, token: (inv.payUrl as string).split("/pay/")[1]! };
}

async function webhook(c: TestContext, type: string, object: Record<string, unknown>, account: string) {
  const e = stripe.signedEvent(type, object, account);
  const res = await c.app.inject({ method: "POST", url: "/webhooks/stripe", payload: e.body, headers: { "content-type": "application/json", "stripe-signature": e.signature } });
  return { res, e };
}

const session = (inv: { id: string }, orgId: string, opts: { id?: string; paid: boolean; amount: number }) => ({
  id: opts.id ?? "cs_test_manual",
  object: "checkout.session",
  payment_status: opts.paid ? "paid" : "unpaid",
  payment_intent: (opts.id ?? "cs_test_manual").replace(/^cs_/, "pi_"),
  amount_total: opts.amount,
  metadata: { organizationId: orgId, invoiceId: inv.id },
});

describe("drafts and issuing", () => {
  it("computes totals with tax on taxable lines and numbers invoices in order when issued", async () => {
    const t = await billingTenant(ctx);
    await t.api.patch("/billing/settings", { defaultTaxRateBps: 825, invoiceTermsDays: 15 });
    const draft = (await t.api.post("/invoices", { customerId: t.customer.id, siteId: t.site.id, lines: LINES })).json();
    expect(draft).toMatchObject({ status: "draft", number: null, subtotalCents: 32500, taxableCents: 2500, taxCents: 206, totalCents: 32706, termsDays: 15, taxRateBps: 825 });

    const edited = (await t.api.patch(`/invoices/${draft.id}`, { discountCents: 2500, memo: "Thanks!" })).json();
    expect(edited).toMatchObject({ discountCents: 2500, totalCents: 32500 - 2500 + Math.round((2500 - 192) * 0.0825), memo: "Thanks!" });

    ctx.now = new Date("2026-03-02T18:00:00Z");
    const first = (await t.api.post(`/invoices/${draft.id}/issue`, { send: false })).json();
    expect(first).toMatchObject({ status: "open", number: 1001, issuedOn: "2026-03-02", dueOn: "2026-03-17", paymentStatus: "unpaid", amountDueCents: edited.totalCents });
    expect(first.payUrl).toMatch(/^http:\/\/localhost:3000\/pay\/[A-Za-z0-9_-]{32}$/);
    const second = await issued(t, LINES, false);
    expect(second.number).toBe(1002);

    // An issued invoice says what it said.
    expect((await t.api.patch(`/invoices/${draft.id}`, { memo: "changed" })).statusCode).toBe(422);
    await expect(sql`update invoice_lines set unit_price_cents = 1 where invoice_id = ${draft.id}`.execute(ctx.db)).rejects.toThrow(/issued invoice/);
    await expect(sql`update invoices set total_cents = 1, subtotal_cents = 1 where id = ${draft.id}`.execute(ctx.db)).rejects.toThrow(/cannot be edited/);
    await expect(sql`delete from invoices where id = ${draft.id}`.execute(ctx.db)).rejects.toThrow(/voided, never deleted/);
  });

  it("refuses to send to a customer with no email and leaves the draft unnumbered", async () => {
    const t = await billingTenant(ctx, "Org A", { email: false });
    const draft = (await t.api.post("/invoices", { customerId: t.customer.id, lines: LINES })).json();
    const res = await t.api.post(`/invoices/${draft.id}/issue`, { send: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/no email/);
    expect((await t.api.get(`/invoices/${draft.id}`)).json()).toMatchObject({ status: "draft", number: null });
    // The number was not used up.
    expect((await t.api.post(`/invoices/${draft.id}/issue`, { send: false })).json().number).toBe(1001);
  });

  it("discards drafts but not issued invoices", async () => {
    const t = await billingTenant(ctx);
    const draft = (await t.api.post("/invoices", { customerId: t.customer.id, lines: LINES })).json();
    expect((await t.api.post(`/invoices/${draft.id}/discard`, {})).statusCode).toBe(204);
    expect((await t.api.get(`/invoices/${draft.id}`)).statusCode).toBe(404);
    const inv = await issued(t);
    expect((await t.api.post(`/invoices/${inv.id}/discard`, {})).statusCode).toBe(422);
  });

  it("emails the PDF and pay link once per send, even when the task runs again", async () => {
    const t = await billingTenant(ctx);
    const inv = await issued(t);
    expect(inv.pdfReady).toBe(false);
    await runWorker(ctx);

    const detail = (await t.api.get(`/invoices/${inv.id}`)).json();
    expect(detail.pdfReady).toBe(true);
    expect(detail.sentAt).not.toBeNull();
    expect(detail.events.map((e: { eventType: string }) => e.eventType)).toEqual(["created", "issued", "sent"]);
    const pdf = await t.api.get(`/invoices/${inv.id}/pdf`);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    const msg = mail.delivered.get(`invoice-${inv.id}-send-1`)!;
    expect(msg.to).toBe("billing@orga.test");
    expect(msg.subject).toContain("INV-1001");
    expect(msg.text).toContain(`https://app.example.test/pay/${inv.token}`);
    expect(msg.attachments[0]!.filename).toBe("INV-1001.pdf");

    await sql`update background_tasks set completed_at = null`.execute(ctx.db);
    await runWorker(ctx);
    expect([...mail.delivered.keys()].filter((k) => k.startsWith(`invoice-${inv.id}`))).toHaveLength(1);

    await t.api.post(`/invoices/${inv.id}/send`, {});
    await runWorker(ctx);
    expect(mail.delivered.has(`invoice-${inv.id}-send-2`)).toBe(true);
  });
});

describe("contract billing", () => {
  it("bills each installment once, and again only after its invoice is voided", async () => {
    const t = await billingTenant(ctx);
    const plan = (await t.api.post("/plans", { name: "Quarterly", termMonths: 12, visitsPerTerm: 3, priceCents: 30000, billingFrequency: "quarterly" })).json();
    const contract = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2026-01-15" })).json();

    const first = await t.api.post(`/contracts/${contract.id}/invoice`, {});
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ totalCents: 7500, site: { id: t.site.id }, customer: { id: t.customer.id } });
    expect(first.json().lines[0]).toMatchObject({ contractId: contract.id, installment: 1, periodStart: "2026-01-15", periodEnd: "2026-04-14" });
    expect(first.json().lines[0].description).toContain("payment 1 of 4");

    const second = (await t.api.post(`/contracts/${contract.id}/invoice`, {})).json();
    expect(second.lines[0].installment).toBe(2);
    expect((await t.api.post(`/contracts/${contract.id}/invoice`, { installment: 2 })).statusCode).toBe(422);

    // Editing a draft's lines keeps the installment on the line sent back with its id.
    const edited = (await t.api.patch(`/invoices/${second.id}`, { lines: [{ ...second.lines[0], unitPriceCents: 7000 }, { description: "Call-ahead", unitPriceCents: 500 }] })).json();
    expect(edited.lines.map((l: { installment: number | null }) => l.installment)).toEqual([2, null]);

    await t.api.post(`/invoices/${first.json().id}/issue`, { send: false });
    await t.api.post(`/invoices/${first.json().id}/void`, { reason: "Wrong price" });
    expect((await t.api.post(`/contracts/${contract.id}/invoice`, {})).json().lines[0].installment).toBe(1);
    await t.api.post(`/contracts/${contract.id}/invoice`, {});
    await t.api.post(`/contracts/${contract.id}/invoice`, {});
    const done = await t.api.post(`/contracts/${contract.id}/invoice`, {});
    expect(done.statusCode).toBe(422);
    expect(done.json().message).toMatch(/already on an invoice/);
  });
});

describe("payments recorded by the office", () => {
  it("tracks partial and full payment separately from the invoice status", async () => {
    const t = await billingTenant(ctx);
    const inv = await issued(t, [{ description: "Service", unitPriceCents: 10000 }]);
    const pay = (body: object) => t.api.post(`/invoices/${inv.id}/payments`, { method: "check", receivedOn: "2026-03-01", ...body });

    expect((await pay({ amountCents: 4000, reference: "Check 1201" })).json()).toMatchObject({ status: "open", paymentStatus: "partial", paidCents: 4000, amountDueCents: 6000 });
    const over = await pay({ amountCents: 6001 });
    expect(over.statusCode).toBe(422);
    expect(over.json().message).toContain("$60.00");
    const paid = (await pay({ amountCents: 6000, method: "cash" })).json();
    expect(paid).toMatchObject({ status: "open", paymentStatus: "paid", amountDueCents: 0 });

    // The site's compliance timeline shows the payments.
    const timeline = await ctx.db.selectFrom("complianceEvents").select(["eventType", "summary", "invoiceId"]).where("siteId", "=", t.site.id).execute();
    expect(timeline.filter((e) => e.eventType === "payment_received").map((e) => e.summary)).toEqual([
      "Payment received: $40.00 by check for INV-1001",
      "Payment received: $60.00 by cash for INV-1001",
    ]);

    // Only the owner refunds. Reversing a payment taken by mistake reopens the balance.
    const office = await createUser(ctx.db, t.org.id, "office");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    const check = paid.payments[0];
    expect((await officeApi.post(`/payments/${check.id}/refund`, { amountCents: 1000, reason: "Wrong customer" })).statusCode).toBe(403);
    const reversed = (await t.api.post(`/payments/${check.id}/refund`, { amountCents: 1000, reason: "Wrong customer", intent: "reverse" })).json();
    expect(reversed).toMatchObject({ paymentStatus: "partial", paidCents: 9000, creditedCents: 0, amountDueCents: 1000 });
    expect(reversed.payments[0]).toMatchObject({ refundedCents: 1000, refunds: [{ amountCents: 1000, status: "succeeded", intent: "reverse" }] });
    // An ordinary refund is a credit: the customer no longer owes it, so what is due stays the same.
    const credited = (await t.api.post(`/payments/${check.id}/refund`, { amountCents: 500, reason: "Overcharged" })).json();
    expect(credited).toMatchObject({ paymentStatus: "partial", paidCents: 8500, creditedCents: 500, amountDueCents: 1000 });
    expect(credited.payments[0].refunds[1]).toMatchObject({ amountCents: 500, intent: "credit" });
    expect(credited.events.at(-1).summary).toBe("Refunded $5.00: Overcharged");
    expect(reversed.events.at(-1).summary).toBe("Refunded $10.00 to reverse the payment (owed again): Wrong customer");
    expect((await t.api.post(`/payments/${check.id}/refund`, { amountCents: 2501, reason: "Too much" })).statusCode).toBe(422);

    // Voiding needs every payment refunded first.
    expect((await t.api.post(`/invoices/${inv.id}/void`, { reason: "Duplicate" })).statusCode).toBe(422);
  });

  it("marks a $0 invoice paid when issued", async () => {
    const t = await billingTenant(ctx);
    const inv = await issued(t, [{ description: "Warranty visit", unitPriceCents: 0 }], false);
    expect(inv).toMatchObject({ paymentStatus: "paid", amountDueCents: 0 });
  });
});

describe("paying online", () => {
  it("shows the invoice from its link and takes a card payment through checkout", async () => {
    const t = await billingTenant(ctx);
    const inv = await issued(t);
    const anon = client(ctx.app);

    const page = (await anon.get(`/pay/${inv.token}`)).json();
    expect(page).toMatchObject({ number: "INV-1001", customerName: "Org A customer", amountDueCents: 32500, canPayOnline: true, testMode: true, paymentStatus: "unpaid" });
    expect(page.provider.name).toBe("Org A");
    expect(JSON.stringify(page)).not.toContain(t.customer.id);

    const checkout = (await anon.post(`/pay/${inv.token}/checkout`, {})).json();
    expect(checkout.url).toMatch(new RegExp(`/pay/${inv.token}/test-checkout\\?session=cs_test_`));
    // Pressing Pay again reuses the same page.
    expect((await anon.post(`/pay/${inv.token}/checkout`, {})).json().url).toBe(checkout.url);

    const sessionId = new URL(checkout.url).searchParams.get("session")!;
    const declined = (await anon.post(`/pay/${inv.token}/test-checkout`, { sessionId, outcome: "declined" })).json();
    expect(declined.ok).toBe(false);
    expect((await anon.post(`/pay/${inv.token}/test-checkout`, { sessionId, outcome: "card" })).json().ok).toBe(true);

    const after = (await t.api.get(`/invoices/${inv.id}`)).json();
    expect(after).toMatchObject({ paymentStatus: "paid", paidCents: 32500, amountDueCents: 0 });
    expect(after.payments).toMatchObject([{ method: "card", source: "stripe", status: "succeeded", amountCents: 32500 }]);
    expect((await anon.get(`/pay/${inv.token}`)).json()).toMatchObject({ paymentStatus: "paid", canPayOnline: false });
    expect((await anon.post(`/pay/${inv.token}/checkout`, {})).statusCode).toBe(422);
  });

  it("ignores a replayed webhook and never records a payment twice", async () => {
    const t = await billingTenant(ctx);
    const inv = await issued(t);
    const { res, e } = await webhook(ctx, "checkout.session.completed", session(inv, t.org.id, { paid: true, amount: 32500 }), t.accountId!);
    expect(res.json().outcome).toMatch(/payment succeeded/);
    const replay = await ctx.app.inject({ method: "POST", url: "/webhooks/stripe", payload: e.body, headers: { "content-type": "application/json", "stripe-signature": e.signature } });
    expect(replay.json().outcome).toBe("duplicate");
    // The same payment under a new event id is recognized by its PaymentIntent.
    const again = await webhook(ctx, "checkout.session.completed", session(inv, t.org.id, { paid: true, amount: 32500 }), t.accountId!);
    expect(again.res.json().outcome).toMatch(/unchanged/);
    const payments = await ctx.db.selectFrom("payments").select("id").where("invoiceId", "=", inv.id).execute();
    expect(payments).toHaveLength(1);
  });

  it("shows a bank payment as processing until it clears, and flags it when it fails", async () => {
    const t = await billingTenant(ctx);
    const a = await issued(t);
    await webhook(ctx, "checkout.session.completed", session(a, t.org.id, { id: "cs_test_a", paid: false, amount: 32500 }), t.accountId!);
    expect((await t.api.get(`/invoices/${a.id}`)).json()).toMatchObject({ paymentStatus: "processing", pendingCents: 32500, amountDueCents: 0 });
    expect((await client(ctx.app).get(`/pay/${a.token}`)).json()).toMatchObject({ paymentStatus: "processing", canPayOnline: false });
    await webhook(ctx, "checkout.session.async_payment_succeeded", session(a, t.org.id, { id: "cs_test_a", paid: true, amount: 32500 }), t.accountId!);
    expect((await t.api.get(`/invoices/${a.id}`)).json()).toMatchObject({ paymentStatus: "paid", pendingCents: 0, paidCents: 32500 });

    const b = await issued(t);
    await webhook(ctx, "checkout.session.completed", session(b, t.org.id, { id: "cs_test_b", paid: false, amount: 32500 }), t.accountId!);
    await webhook(ctx, "checkout.session.async_payment_failed", session(b, t.org.id, { id: "cs_test_b", paid: false, amount: 32500 }), t.accountId!);
    const failed = (await t.api.get(`/invoices/${b.id}`)).json();
    expect(failed).toMatchObject({ paymentStatus: "unpaid", amountDueCents: 32500 });
    expect(failed.payments[0]).toMatchObject({ method: "ach", status: "failed", failureReason: "The bank payment did not go through" });
    // The customer can try again.
    expect((await client(ctx.app).get(`/pay/${b.token}`)).json().canPayOnline).toBe(true);

    const inbox = (await t.api.get("/inbox")).json();
    expect(inbox.items.find((i: { kind: string }) => i.kind === "payment_failed")).toMatchObject({ severity: "high", target: { type: "invoice", id: b.id } });
  });

  const intent = (inv: { id: string }, orgId: string, opts: { id: string; amount: number; verifyUrl?: string }) => ({
    id: opts.id,
    object: "payment_intent",
    amount: opts.amount,
    metadata: { organizationId: orgId, invoiceId: inv.id },
    next_action: opts.verifyUrl ? { type: "verify_with_microdeposits", verify_with_microdeposits: { hosted_verification_url: opts.verifyUrl, microdeposit_type: "descriptor_code" } } : null,
  });
  const VERIFY = "https://payments.stripe.com/microdeposit/pacs_test_123";

  it("asks the customer to verify their bank account when Stripe waits on microdeposits, until they do", async () => {
    const t = await billingTenant(ctx);
    const inv = await issued(t);
    await webhook(ctx, "checkout.session.completed", session(inv, t.org.id, { id: "cs_test_v", paid: false, amount: 32500 }), t.accountId!);
    const asked = await webhook(ctx, "payment_intent.requires_action", intent(inv, t.org.id, { id: "pi_test_v", amount: 32500, verifyUrl: VERIFY }), t.accountId!);
    expect(asked.res.json().outcome).toBe("payment waiting on bank verification");

    // The customer is told what to do, not that nothing is left to do.
    expect((await client(ctx.app).get(`/pay/${inv.token}`)).json()).toMatchObject({ paymentStatus: "processing", bankVerificationUrl: VERIFY, canPayOnline: false });
    const office = (await t.api.get(`/invoices/${inv.id}`)).json();
    expect(office.payments[0]).toMatchObject({ method: "ach", status: "pending", awaitingBankVerification: true });
    expect(office.events.map((e: { eventType: string }) => e.eventType)).toContain("payment_needs_verification");
    // A replay changes nothing.
    expect((await webhook(ctx, "payment_intent.requires_action", intent(inv, t.org.id, { id: "pi_test_v", amount: 32500, verifyUrl: VERIFY }), t.accountId!)).res.json().outcome).toMatch(/unchanged/);

    // Verified: the payment is clearing, with nothing left for the customer to do.
    expect((await webhook(ctx, "payment_intent.processing", intent(inv, t.org.id, { id: "pi_test_v", amount: 32500 }), t.accountId!)).res.json().outcome).toMatch(/verified/);
    expect((await client(ctx.app).get(`/pay/${inv.token}`)).json()).toMatchObject({ paymentStatus: "processing", bankVerificationUrl: null });
    expect((await t.api.get(`/invoices/${inv.id}`)).json().payments[0].awaitingBankVerification).toBe(false);

    await webhook(ctx, "checkout.session.async_payment_succeeded", session(inv, t.org.id, { id: "cs_test_v", paid: true, amount: 32500 }), t.accountId!);
    expect((await t.api.get(`/invoices/${inv.id}`)).json()).toMatchObject({ paymentStatus: "paid", pendingCents: 0 });
  });

  it("records a bank payment that needs verification even before checkout's own event, and only links to Stripe", async () => {
    const t = await billingTenant(ctx);
    const inv = await issued(t);
    await webhook(ctx, "payment_intent.requires_action", intent(inv, t.org.id, { id: "pi_test_early", amount: 32500, verifyUrl: VERIFY }), t.accountId!);
    const late = await webhook(ctx, "checkout.session.completed", session(inv, t.org.id, { id: "cs_test_early", paid: false, amount: 32500 }), t.accountId!);
    expect(late.res.json().outcome).toMatch(/unchanged: payment already pending/);
    expect((await client(ctx.app).get(`/pay/${inv.token}`)).json()).toMatchObject({ paymentStatus: "processing", pendingCents: 32500, bankVerificationUrl: VERIFY });
    const payments = await ctx.db.selectFrom("payments").select(["method", "status"]).where("invoiceId", "=", inv.id).execute();
    expect(payments).toEqual([{ method: "ach", status: "pending" }]);

    const other = await issued(t);
    const odd = await webhook(ctx, "payment_intent.requires_action", intent(other, t.org.id, { id: "pi_test_odd", amount: 32500, verifyUrl: "https://example.com/verify" }), t.accountId!);
    expect(odd.res.json().outcome).toBe("ignored: not a bank account verification");
    expect((await client(ctx.app).get(`/pay/${other.token}`)).json()).toMatchObject({ bankVerificationUrl: null, canPayOnline: true });
  });

  it("fails a bank payment whose account was never verified, and ignores a card declined at checkout", async () => {
    const t = await billingTenant(ctx);
    const inv = await issued(t);
    await webhook(ctx, "payment_intent.requires_action", intent(inv, t.org.id, { id: "pi_test_never", amount: 32500, verifyUrl: VERIFY }), t.accountId!);
    const failed = await webhook(ctx, "payment_intent.payment_failed", intent(inv, t.org.id, { id: "pi_test_never", amount: 32500 }), t.accountId!);
    expect(failed.res.json().outcome).toMatch(/payment failed/);
    expect((await client(ctx.app).get(`/pay/${inv.token}`)).json()).toMatchObject({ paymentStatus: "unpaid", bankVerificationUrl: null, canPayOnline: true });
    expect((await t.api.get(`/invoices/${inv.id}`)).json().payments[0]).toMatchObject({ status: "failed", awaitingBankVerification: false });

    const declined = await webhook(ctx, "payment_intent.payment_failed", intent(inv, t.org.id, { id: "pi_test_card", amount: 32500 }), t.accountId!);
    expect(declined.res.json().outcome).toBe("ignored: no payment recorded");
  });

  it("settles to the same result when events arrive out of order", async () => {
    const t = await billingTenant(ctx);
    const inv = await issued(t);
    await webhook(ctx, "checkout.session.async_payment_succeeded", session(inv, t.org.id, { paid: true, amount: 32500 }), t.accountId!);
    const late = await webhook(ctx, "checkout.session.completed", session(inv, t.org.id, { paid: false, amount: 32500 }), t.accountId!);
    expect(late.res.json().outcome).toMatch(/unchanged: payment already succeeded/);
    const paid = (await t.api.get(`/invoices/${inv.id}`)).json();
    expect(paid).toMatchObject({ paymentStatus: "paid", pendingCents: 0 });
    // Only a bank debit clears late, so it is recorded as one even when its first event is the last.
    expect(paid.payments[0]).toMatchObject({ method: "ach", status: "succeeded" });
  });

  it("rejects unsigned webhooks and ignores accounts it does not know", async () => {
    const t = await billingTenant(ctx);
    const inv = await issued(t);
    const e = stripe.signedEvent("checkout.session.completed", session(inv, t.org.id, { paid: true, amount: 32500 }), t.accountId!);
    const forged = await ctx.app.inject({ method: "POST", url: "/webhooks/stripe", payload: e.body.replace("32500", "1"), headers: { "content-type": "application/json", "stripe-signature": e.signature } });
    expect(forged.statusCode).toBe(400);
    const unsigned = await ctx.app.inject({ method: "POST", url: "/webhooks/stripe", payload: e.body, headers: { "content-type": "application/json" } });
    expect(unsigned.statusCode).toBe(400);
    const stranger = await webhook(ctx, "checkout.session.completed", session(inv, t.org.id, { paid: true, amount: 32500 }), "acct_someone_else");
    expect(stranger.res.json().outcome).toMatch(/ignored/);
    expect((await t.api.get(`/invoices/${inv.id}`)).json().paymentStatus).toBe("unpaid");
  });

  it("refunds card payments through Stripe and picks up refunds made in the Stripe dashboard", async () => {
    const t = await billingTenant(ctx);
    const inv = await issued(t);
    await webhook(ctx, "checkout.session.completed", session(inv, t.org.id, { paid: true, amount: 32500 }), t.accountId!);
    const paymentId = (await t.api.get(`/invoices/${inv.id}`)).json().payments[0].id;

    const after = (await t.api.post(`/payments/${paymentId}/refund`, { amountCents: 2500, reason: "Tablets returned" })).json();
    // An ordinary refund: the customer no longer owes it, so the invoice stays paid.
    expect(after).toMatchObject({ paymentStatus: "paid", paidCents: 30000, creditedCents: 2500, amountDueCents: 0 });
    const refundRow = await ctx.db.selectFrom("refunds").select(["providerRefundId", "status"]).executeTakeFirstOrThrow();
    // Stripe's own webhook for that refund changes nothing.
    const echo = await webhook(ctx, "refund.updated", { id: refundRow.providerRefundId, amount: 2500, status: "succeeded", payment_intent: "pi_test_manual" }, t.accountId!);
    expect(echo.res.json().outcome).toMatch(/unchanged/);

    // A refund made in the dashboard arrives pending, then succeeds.
    await webhook(ctx, "refund.created", { id: "re_dash_1", amount: 30000, status: "pending", payment_intent: "pi_test_manual" }, t.accountId!);
    expect((await t.api.get(`/invoices/${inv.id}`)).json().paidCents).toBe(30000);
    await webhook(ctx, "refund.updated", { id: "re_dash_1", amount: 30000, status: "succeeded", payment_intent: "pi_test_manual" }, t.accountId!);
    const refunded = (await t.api.get(`/invoices/${inv.id}`)).json();
    expect(refunded).toMatchObject({ paymentStatus: "refunded", paidCents: 0, creditedCents: 32500, amountDueCents: 0 });
    // A dashboard refund counts as an ordinary refund (a credit).
    expect(refunded.payments[0].refunds.map((r: { reason: string; intent: string }) => [r.reason, r.intent])).toEqual([
      ["Tablets returned", "credit"],
      ["Refunded in Stripe", "credit"],
    ]);

    // Nothing left to refund.
    expect((await t.api.post(`/payments/${paymentId}/refund`, { amountCents: 1, reason: "x" })).statusCode).toBe(422);
    // With every payment refunded, the invoice can be voided, and its link stops working.
    expect((await t.api.post(`/invoices/${inv.id}/void`, { reason: "Cancelled job" })).json().status).toBe("void");
    expect((await client(ctx.app).get(`/pay/${inv.token}`)).statusCode).toBe(404);
  });

  it("flags money that arrives on a void invoice for refund", async () => {
    const t = await billingTenant(ctx);
    const inv = await issued(t);
    await t.api.post(`/invoices/${inv.id}/void`, { reason: "Duplicate" });
    await webhook(ctx, "checkout.session.completed", session(inv, t.org.id, { paid: true, amount: 32500 }), t.accountId!);
    expect((await t.api.get(`/invoices/${inv.id}`)).json()).toMatchObject({ status: "void", paymentStatus: "overpaid" });
    const inbox = (await t.api.get("/inbox")).json();
    expect(inbox.items.find((i: { kind: string }) => i.kind === "invoice_overpaid")).toMatchObject({ target: { type: "invoice", id: inv.id } });
  });

  it("does not offer online payment until the Stripe account is ready", async () => {
    const t = await billingTenant(ctx, "Org A", { stripe: false });
    const inv = await issued(t);
    expect((await client(ctx.app).get(`/pay/${inv.token}`)).json().canPayOnline).toBe(false);
    expect((await client(ctx.app).post(`/pay/${inv.token}/checkout`, {})).statusCode).toBe(422);
    expect((await client(ctx.app).get("/pay/not-a-real-token-at-all-nope")).statusCode).toBe(404);
  });
});

describe("access", () => {
  it("keeps invoices inside their organization and away from technicians", async () => {
    const a = await billingTenant(ctx, "Org A");
    const b = await billingTenant(ctx, "Org B");
    const inv = await issued(a);
    expect((await b.api.get(`/invoices/${inv.id}`)).statusCode).toBe(404);
    expect((await b.api.post(`/invoices/${inv.id}/payments`, { amountCents: 100, method: "cash", receivedOn: "2026-03-01" })).statusCode).toBe(404);
    expect((await b.api.post("/invoices", { customerId: a.customer.id, lines: LINES })).statusCode).toBe(404);
    expect((await b.api.post("/invoices", { customerId: b.customer.id, siteId: a.site.id, lines: LINES })).statusCode).toBe(404);
    expect((await b.api.get("/invoices?view=all")).json().items).toHaveLength(0);
    // Org B's Stripe account cannot pay Org A's invoice.
    const cross = await webhook(ctx, "checkout.session.completed", session(inv, a.org.id, { paid: true, amount: 32500 }), b.accountId!);
    expect(cross.res.json().outcome).toBe("ignored: invoice not found");

    const tech = await createUser(ctx.db, a.org.id, "technician");
    expect((await client(ctx.app, await login(ctx.app, tech.email)).get("/invoices")).statusCode).toBe(403);
    const reader = await createUser(ctx.db, a.org.id, "read_only");
    const ro = client(ctx.app, await login(ctx.app, reader.email));
    expect((await ro.get(`/invoices/${inv.id}`)).statusCode).toBe(200);
    expect((await ro.post(`/invoices/${inv.id}/send`, {})).statusCode).toBe(403);
    const office = await createUser(ctx.db, a.org.id, "office");
    expect((await client(ctx.app, await login(ctx.app, office.email)).post("/billing/stripe/connect", {})).statusCode).toBe(403);
  });

  it("lists unpaid invoices with overdue ones first and shows them in the inbox", async () => {
    const t = await billingTenant(ctx);
    const older = await issued(t);
    ctx.now = new Date("2026-04-15T18:00:00Z");
    const newer = await issued(t);
    const list = (await t.api.get("/invoices?view=unpaid")).json();
    expect(list.items.map((i: { id: string; overdue: boolean }) => [i.id, i.overdue])).toEqual([
      [older.id, true],
      [newer.id, false],
    ]);
    expect((await t.api.get("/invoices?view=overdue")).json().items).toHaveLength(1);
    const inbox = (await t.api.get("/inbox")).json();
    expect(inbox.counts).toMatchObject({ unpaidInvoices: 2, unpaidCents: 65000 });
    expect(inbox.items.find((i: { kind: string }) => i.kind === "invoice_overdue")).toMatchObject({ target: { type: "invoice", id: older.id }, dueOn: older.dueOn });
  });
});
