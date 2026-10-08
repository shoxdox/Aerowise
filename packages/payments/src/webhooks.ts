import type { Database, DB } from "@aerowise/db";
import { invoiceNumberLabel, type PaymentRecordStatus } from "@aerowise/domain";
import type { Transaction } from "kysely";
import { dollars, invoiceEvent, paymentOnTimeline, recalcInvoice } from "./ledger.ts";
import { refundStatusOf, type WebhookEvent } from "./provider.ts";

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown) => (typeof v === "number" ? v : null);
/** Stripe sends an expandable field as an id or as the object. */
const idOf = (v: unknown) => str(v) ?? (v && typeof v === "object" ? str((v as Obj).id) : null);

/** Once a payment has cleared or failed, a later or replayed event cannot move it back. */
const FINAL: readonly PaymentRecordStatus[] = ["succeeded", "failed"];

/**
 * Records a verified Stripe event and applies it, in one transaction. A repeated event id
 * is skipped, and every handler moves records only forward, so replays and events that
 * arrive out of order leave the same result. Returns what happened, for the log.
 */
export async function applyStripeEvent(db: Database, event: WebhookEvent, now: Date): Promise<string> {
  return db.transaction().execute(async (trx) => {
    const org = event.account ? await trx.selectFrom("organizations").select("id").where("stripeAccountId", "=", event.account).executeTakeFirst() : undefined;
    const inserted = await trx
      .insertInto("stripeEvents")
      .values({
        id: event.id,
        type: event.type,
        account: event.account ?? null,
        livemode: event.livemode,
        organizationId: org?.id ?? null,
        payload: JSON.stringify(event),
        outcome: "received",
        receivedAt: now,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!inserted) return "duplicate";
    const outcome = org ? await apply(trx, org.id, event, now) : "ignored: not a connected account we know";
    await trx.updateTable("stripeEvents").set({ outcome }).where("id", "=", event.id).execute();
    return outcome;
  });
}

async function apply(trx: Transaction<DB>, organizationId: string, event: WebhookEvent, now: Date): Promise<string> {
  const o = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
      // Cards clear at checkout; a bank debit completes checkout unpaid and clears days later.
      return o.payment_status === "paid" ? checkoutPayment(trx, organizationId, o, "succeeded", "card", now) : checkoutPayment(trx, organizationId, o, "pending", "ach", now);
    // Only delayed methods (bank debits) send these, and the session reads "paid" by then.
    case "checkout.session.async_payment_succeeded":
      return checkoutPayment(trx, organizationId, o, "succeeded", "ach", now);
    case "checkout.session.async_payment_failed":
      return checkoutPayment(trx, organizationId, o, "failed", "ach", now);
    case "checkout.session.expired": {
      const res = await trx
        .updateTable("checkoutSessions")
        .set({ status: "expired" })
        .where("organizationId", "=", organizationId)
        .where("providerSessionId", "=", String(o.id))
        .where("status", "=", "open")
        .executeTakeFirst();
      return Number(res.numUpdatedRows) ? "checkout expired" : "ignored: checkout not open";
    }
    // A bank payment entered by hand (not through instant verification) can't be taken until
    // the customer confirms two small deposits (or a code) on a Stripe page.
    case "payment_intent.requires_action":
      return bankVerificationNeeded(trx, organizationId, o, now);
    case "payment_intent.processing":
      return bankVerificationDone(trx, organizationId, o, now);
    // A bank payment whose account was never verified, or that otherwise could not go ahead.
    case "payment_intent.payment_failed":
      return pendingPaymentFailed(trx, organizationId, o, now);
    case "refund.created":
    case "refund.updated":
      return refundEvent(trx, organizationId, o, now);
    case "account.updated":
      await trx
        .updateTable("organizations")
        .set({ stripeChargesEnabled: o.charges_enabled === true, stripeDetailsSubmitted: o.details_submitted === true })
        .where("id", "=", organizationId)
        .execute();
      return `account: charges ${o.charges_enabled === true ? "enabled" : "disabled"}`;
    default:
      return "ignored: event type not used";
  }
}

async function checkoutPayment(trx: Transaction<DB>, organizationId: string, session: Obj, status: PaymentRecordStatus, methodHint: "card" | "ach", now: Date): Promise<string> {
  const metadata = (session.metadata ?? {}) as Obj;
  const invoiceId = str(metadata.invoiceId);
  const paymentIntent = idOf(session.payment_intent);
  const amount = num(session.amount_total);
  if (!invoiceId || !paymentIntent || !amount) return "ignored: not an invoice payment";
  // The metadata is ours, but the account decides whose invoice it can be.
  const invoice = await trx
    .selectFrom("invoices")
    .select(["id", "number"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", invoiceId)
    .forUpdate()
    .executeTakeFirst();
  if (!invoice) return "ignored: invoice not found";

  const sessionId = str(session.id);
  if (sessionId) await trx.updateTable("checkoutSessions").set({ status: "complete" }).where("organizationId", "=", organizationId).where("providerSessionId", "=", sessionId).execute();

  const existing = await trx.selectFrom("payments").selectAll().where("providerPaymentId", "=", paymentIntent).forUpdate().executeTakeFirst();
  if (existing && existing.organizationId !== organizationId) return "ignored: payment belongs to another account";
  if (existing && (FINAL.includes(existing.status) || existing.status === status)) return `unchanged: payment already ${existing.status}`;

  const method = existing?.method ?? methodHint;
  const failureReason = status === "failed" ? "The bank payment did not go through" : null;
  const stamp = { succeededAt: status === "succeeded" ? now : null, failedAt: status === "failed" ? now : null };
  let paymentId: string;
  if (existing) {
    // A payment that cleared or failed has nothing left to verify.
    await trx.updateTable("payments").set({ status, failureReason, ...stamp, bankVerificationUrl: null, updatedAt: now }).where("id", "=", existing.id).execute();
    paymentId = existing.id;
  } else {
    const row = await trx
      .insertInto("payments")
      .values({
        organizationId,
        invoiceId,
        amountCents: amount,
        method,
        source: "stripe",
        status,
        providerPaymentId: paymentIntent,
        providerSessionId: sessionId,
        receivedOn: null,
        reference: null,
        note: null,
        failureReason,
        recordedBy: null,
        ...stamp,
        createdAt: now,
        updatedAt: now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    paymentId = row.id;
  }
  await recalcInvoice(trx, organizationId, invoiceId, now);

  const label = invoiceNumberLabel(invoice.number);
  const how = method === "card" ? "card" : "bank (ACH)";
  const summary =
    status === "succeeded" ? `Paid ${dollars(amount)} online by ${how}` : status === "pending" ? `Bank payment of ${dollars(amount)} started; it takes a few days to clear` : `Bank payment of ${dollars(amount)} failed`;
  await invoiceEvent(trx, { organizationId, invoiceId, eventType: `payment_${status}`, summary, paymentId, at: now });
  if (status === "succeeded") await paymentOnTimeline(trx, { organizationId, invoiceId, amountCents: amount, method, at: now });
  return `payment ${status} on ${label}`;
}

async function refundEvent(trx: Transaction<DB>, organizationId: string, r: Obj, now: Date): Promise<string> {
  const refundId = str(r.id);
  const paymentIntent = idOf(r.payment_intent);
  const amount = num(r.amount);
  if (!refundId || !paymentIntent || !amount) return "ignored: refund without a payment";
  const payment = await trx.selectFrom("payments").select(["id", "invoiceId"]).where("organizationId", "=", organizationId).where("providerPaymentId", "=", paymentIntent).executeTakeFirst();
  if (!payment) return "ignored: refund for a payment we do not have";
  // Lock the invoice first, the same order every payment change takes.
  await trx.selectFrom("invoices").select("id").where("id", "=", payment.invoiceId).forUpdate().executeTakeFirstOrThrow();

  const status = refundStatusOf(str(r.status));
  let existing = await trx.selectFrom("refunds").select(["id", "status"]).where("providerRefundId", "=", refundId).forUpdate().executeTakeFirst();
  // A refund Aerowise reserved before asking Stripe carries the reservation's id. Its webhook
  // can arrive before the route stores Stripe's id; it settles that reservation and is never
  // booked again as a refund made in the dashboard. The metadata is ours but only trusted
  // when the company, payment and amount all agree with the reservation.
  const reservedId = str(((r.metadata ?? {}) as Obj).refundId);
  if (!existing && reservedId && /^[0-9a-f-]{36}$/i.test(reservedId)) {
    const reserved = await trx
      .selectFrom("refunds")
      .select(["id", "status", "paymentId", "amountCents", "providerRefundId"])
      .where("organizationId", "=", organizationId)
      .where("id", "=", reservedId)
      .forUpdate()
      .executeTakeFirst();
    if (reserved) {
      if (reserved.paymentId !== payment.id || reserved.amountCents !== amount || (reserved.providerRefundId !== null && reserved.providerRefundId !== refundId)) {
        return "ignored: refund does not match the reservation it names";
      }
      await trx.updateTable("refunds").set({ providerRefundId: refundId, updatedAt: now }).where("id", "=", reserved.id).execute();
      existing = { id: reserved.id, status: reserved.status };
    }
  }
  if (existing && (existing.status !== "pending" || existing.status === status)) return `unchanged: refund already ${existing.status}`;
  if (existing) {
    await trx.updateTable("refunds").set({ status, failureReason: str(r.failure_reason), updatedAt: now }).where("id", "=", existing.id).execute();
  } else {
    // Made in the Stripe dashboard rather than in Aerowise.
    await trx
      .insertInto("refunds")
      .values({
        organizationId,
        paymentId: payment.id,
        amountCents: amount,
        status,
        providerRefundId: refundId,
        reason: "Refunded in Stripe",
        failureReason: str(r.failure_reason),
        createdBy: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
  }
  await recalcInvoice(trx, organizationId, payment.invoiceId, now);
  if (status !== "pending") {
    await invoiceEvent(trx, {
      organizationId,
      invoiceId: payment.invoiceId,
      eventType: `refund_${status}`,
      summary: status === "succeeded" ? `Refund of ${dollars(amount)} went through` : `Refund of ${dollars(amount)} failed`,
      paymentId: payment.id,
      at: now,
    });
  }
  return `refund ${status}`;
}

/** Stripe's hosted microdeposit page for this PaymentIntent, if that is what it waits on. */
function verificationUrlOf(pi: Obj): string | null {
  const next = (pi.next_action ?? null) as Obj | null;
  if (!next || next.type !== "verify_with_microdeposits") return null;
  const url = str(((next.verify_with_microdeposits ?? {}) as Obj).hosted_verification_url);
  if (!url) return null;
  // Only ever send the customer to Stripe.
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "stripe.com" || u.hostname.endsWith(".stripe.com")) ? url : null;
  } catch {
    return null;
  }
}

/** The PaymentIntent seen as the checkout session that made it, for checkoutPayment. */
const asSession = (pi: Obj): Obj => ({ id: null, metadata: pi.metadata, payment_intent: pi.id, amount_total: pi.amount });

async function bankVerificationNeeded(trx: Transaction<DB>, organizationId: string, pi: Obj, now: Date): Promise<string> {
  const url = verificationUrlOf(pi);
  const piId = str(pi.id);
  if (!url || !piId) return "ignored: not a bank account verification";
  let payment = await trx.selectFrom("payments").select(["id", "status", "invoiceId", "bankVerificationUrl"]).where("organizationId", "=", organizationId).where("providerPaymentId", "=", piId).executeTakeFirst();
  if (!payment) {
    // Ahead of checkout.session.completed: record the bank payment now, as that event would.
    const outcome = await checkoutPayment(trx, organizationId, asSession(pi), "pending", "ach", now);
    if (!outcome.startsWith("payment pending")) return outcome;
    payment = await trx.selectFrom("payments").select(["id", "status", "invoiceId", "bankVerificationUrl"]).where("organizationId", "=", organizationId).where("providerPaymentId", "=", piId).executeTakeFirstOrThrow();
  }
  if (payment.status !== "pending") return `unchanged: payment already ${payment.status}`;
  if (payment.bankVerificationUrl === url) return "unchanged: already waiting on bank verification";
  await trx.updateTable("payments").set({ bankVerificationUrl: url, updatedAt: now }).where("id", "=", payment.id).execute();
  await invoiceEvent(trx, {
    organizationId,
    invoiceId: payment.invoiceId,
    eventType: "payment_needs_verification",
    summary: "Bank payment waiting for the customer to verify their bank account",
    paymentId: payment.id,
    at: now,
  });
  return "payment waiting on bank verification";
}

async function bankVerificationDone(trx: Transaction<DB>, organizationId: string, pi: Obj, now: Date): Promise<string> {
  const piId = str(pi.id);
  if (!piId) return "ignored: no payment";
  const res = await trx
    .updateTable("payments")
    .set({ bankVerificationUrl: null, updatedAt: now })
    .where("organizationId", "=", organizationId)
    .where("providerPaymentId", "=", piId)
    .where("bankVerificationUrl", "is not", null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) ? "bank account verified; payment clearing" : "unchanged: nothing waiting on verification";
}

async function pendingPaymentFailed(trx: Transaction<DB>, organizationId: string, pi: Obj, now: Date): Promise<string> {
  const piId = str(pi.id);
  if (!piId) return "ignored: no payment";
  // A card declined at checkout never became a payment; only a bank payment we recorded can fail here.
  const existing = await trx.selectFrom("payments").select(["status"]).where("organizationId", "=", organizationId).where("providerPaymentId", "=", piId).executeTakeFirst();
  if (!existing) return "ignored: no payment recorded";
  if (existing.status !== "pending") return `unchanged: payment already ${existing.status}`;
  return checkoutPayment(trx, organizationId, asSession(pi), "failed", "ach", now);
}

