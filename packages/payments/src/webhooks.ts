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

  await trx.updateTable("checkoutSessions").set({ status: "complete" }).where("organizationId", "=", organizationId).where("providerSessionId", "=", String(session.id)).execute();

  const existing = await trx.selectFrom("payments").selectAll().where("providerPaymentId", "=", paymentIntent).forUpdate().executeTakeFirst();
  if (existing && existing.organizationId !== organizationId) return "ignored: payment belongs to another account";
  if (existing && (FINAL.includes(existing.status) || existing.status === status)) return `unchanged: payment already ${existing.status}`;

  const method = existing?.method ?? methodHint;
  const failureReason = status === "failed" ? "The bank payment did not go through" : null;
  const stamp = { succeededAt: status === "succeeded" ? now : null, failedAt: status === "failed" ? now : null };
  let paymentId: string;
  if (existing) {
    await trx.updateTable("payments").set({ status, failureReason, ...stamp, updatedAt: now }).where("id", "=", existing.id).execute();
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
        providerSessionId: str(session.id),
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
  const existing = await trx.selectFrom("refunds").select(["id", "status"]).where("providerRefundId", "=", refundId).forUpdate().executeTakeFirst();
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
