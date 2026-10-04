import type { Database, DB } from "@aerowise/db";
import { invoiceNumberLabel, PAYMENT_METHOD_LABELS, paymentStatus, type PaymentMethod } from "@aerowise/domain";
import { sql, type Transaction } from "kysely";

export type Executor = Database | Transaction<DB>;

export const dollars = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Appends to the invoice's history. */
export async function invoiceEvent(
  db: Executor,
  e: { organizationId: string; invoiceId: string; eventType: string; summary: string; actorUserId?: string | null; paymentId?: string | null; details?: Record<string, unknown>; at: Date },
) {
  await db
    .insertInto("invoiceEvents")
    .values({
      organizationId: e.organizationId,
      invoiceId: e.invoiceId,
      eventType: e.eventType,
      summary: e.summary,
      actorUserId: e.actorUserId ?? null,
      paymentId: e.paymentId ?? null,
      details: JSON.stringify(e.details ?? {}),
      occurredAt: e.at,
    })
    .execute();
}

/**
 * Recomputes what each payment has had refunded and what the invoice has been paid, from
 * the payments and refunds themselves. Every change to either calls this in the same
 * transaction, so the cached sums can never drift. Money on a void invoice counts as
 * overpaid: it has to go back.
 */
export async function recalcInvoice(trx: Transaction<DB>, organizationId: string, invoiceId: string, now: Date) {
  await sql`
    update payments p set refunded_cents = coalesce((
      select sum(r.amount_cents) from refunds r where r.payment_id = p.id and r.status = 'succeeded'
    ), 0), updated_at = ${now}
    where p.organization_id = ${organizationId} and p.invoice_id = ${invoiceId}
      and p.refunded_cents is distinct from coalesce((select sum(r.amount_cents) from refunds r where r.payment_id = p.id and r.status = 'succeeded'), 0)`.execute(trx);

  const sums = await trx
    .selectFrom("payments")
    .select([
      sql<number>`coalesce(sum(amount_cents) filter (where status = 'succeeded'), 0)::int`.as("succeeded"),
      sql<number>`coalesce(sum(amount_cents) filter (where status = 'pending'), 0)::int`.as("pending"),
      sql<number>`coalesce(sum(refunded_cents), 0)::int`.as("refunded"),
    ])
    .where("organizationId", "=", organizationId)
    .where("invoiceId", "=", invoiceId)
    .executeTakeFirstOrThrow();
  const invoice = await trx.selectFrom("invoices").select(["status", "totalCents", "paidAt"]).where("organizationId", "=", organizationId).where("id", "=", invoiceId).executeTakeFirstOrThrow();

  const paidCents = sums.succeeded - sums.refunded;
  const status = paymentStatus({
    totalCents: invoice.status === "void" ? 0 : invoice.totalCents,
    paidCents,
    pendingCents: sums.pending,
    refundedCents: sums.refunded,
  });
  const fullyPaid = status === "paid" || status === "overpaid";
  await trx
    .updateTable("invoices")
    .set({
      paidCents,
      pendingCents: sums.pending,
      refundedCents: sums.refunded,
      paymentStatus: invoice.status === "void" && status === "paid" ? "unpaid" : status,
      paidAt: fullyPaid && invoice.status !== "void" ? (invoice.paidAt ?? now) : null,
      updatedAt: now,
    })
    .where("organizationId", "=", organizationId)
    .where("id", "=", invoiceId)
    .execute();
  return { paidCents, pendingCents: sums.pending, refundedCents: sums.refunded, paymentStatus: status };
}

/** Puts a cleared payment on the site's compliance timeline, when the invoice is for a site. */
export async function paymentOnTimeline(
  trx: Transaction<DB>,
  p: { organizationId: string; invoiceId: string; amountCents: number; method: PaymentMethod; actorUserId?: string | null; at: Date },
) {
  const inv = await trx.selectFrom("invoices").select(["siteId", "number"]).where("organizationId", "=", p.organizationId).where("id", "=", p.invoiceId).executeTakeFirstOrThrow();
  if (!inv.siteId) return;
  await trx
    .insertInto("complianceEvents")
    .values({
      organizationId: p.organizationId,
      siteId: inv.siteId,
      eventType: "payment_received",
      occurredAt: p.at,
      actorUserId: p.actorUserId ?? null,
      inspectionId: null,
      reportId: null,
      invoiceId: p.invoiceId,
      summary: `Payment received: ${dollars(p.amountCents)} by ${PAYMENT_METHOD_LABELS[p.method].toLowerCase()} for ${invoiceNumberLabel(inv.number)}`,
    })
    .execute();
}
