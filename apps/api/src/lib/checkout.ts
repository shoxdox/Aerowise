import type { Database, DB } from "@aerowise/db";
import { amountDue, invoiceSnapshot, platformFeeCents } from "@aerowise/domain";
import type { PaymentProvider } from "@aerowise/payments";
import { billingEmail, payUrlFor } from "@aerowise/tasks";
import { sql, type Transaction } from "kysely";
import { HttpError, unprocessable } from "./errors.ts";

/** Reuse an open checkout page only if it stays payable for at least this long. */
const REUSE_MIN_REMAINING_MS = 60 * 60 * 1000;

export const notFoundLink = () => new HttpError(404, "not_found", "This payment link is not valid. Contact your service provider for a new one.");

/** An open invoice by its pay-link token, with what checkout needs. */
export async function invoiceByToken(db: Database, token: string) {
  const inv = await db
    .selectFrom("invoices as i")
    .innerJoin("organizations as o", "o.id", "i.organizationId")
    .select([
      "i.id",
      "i.organizationId",
      "i.customerId",
      "i.status",
      "i.paymentStatus",
      "i.snapshot",
      "i.totalCents",
      "i.paidCents",
      "i.pendingCents",
      "i.creditedCents",
      "i.pdfStorageKey",
      "o.stripeAccountId",
      "o.stripeChargesEnabled",
      "o.platformFeeBps",
    ])
    .where("i.publicToken", "=", token)
    .executeTakeFirst();
  // A void invoice's link stops working.
  if (!inv || inv.status !== "open") throw notFoundLink();
  return inv;
}
export type PayableInvoice = Awaited<ReturnType<typeof invoiceByToken>>;

/**
 * Why a deposit invoice no longer takes payment: its estimate was cancelled (or the deposit
 * link voided). Money already paid, and a provider payment that still settles, are kept for
 * the office to refund or keep; only new checkout pages are refused.
 */
export async function depositClosedReason(db: Database | Transaction<DB>, organizationId: string, invoiceId: string): Promise<string | null> {
  const d = await db
    .selectFrom("estimateInvoices as ei")
    .innerJoin("estimates as e", (j) => j.onRef("e.id", "=", "ei.estimateId").onRef("e.organizationId", "=", "ei.organizationId"))
    .select(["e.status", "ei.voidedAt"])
    .where("ei.organizationId", "=", organizationId)
    .where("ei.invoiceId", "=", invoiceId)
    .where("ei.role", "=", "deposit")
    .orderBy("ei.createdAt", "desc")
    .executeTakeFirst();
  if (!d || (d.status !== "cancelled" && d.voidedAt === null)) return null;
  return "This estimate was cancelled, so its deposit is no longer collected.";
}

export const canPayOnline = (provider: PaymentProvider | null, inv: PayableInvoice) => !!provider && !!inv.stripeAccountId && inv.stripeChargesEnabled && amountDue(inv) > 0;

/**
 * Opens a Stripe Checkout page for what is still due on an invoice. An open page for the
 * same amount is reused, so pressing Pay twice does not make two payable pages.
 */
export async function openCheckout(
  db: Database,
  opts: { provider: PaymentProvider | null; appUrl: string; token: string; inv: PayableInvoice; now: Date; successUrl?: string },
): Promise<{ url: string }> {
  const { provider, inv } = opts;
  if (!canPayOnline(provider, inv) || !provider) throw unprocessable(amountDue(inv) === 0 ? "Nothing is due on this invoice" : "Online payment is not available. Contact your service provider.");
  const due = amountDue(inv);
  const fee = platformFeeCents(due, inv.platformFeeBps);
  const at = opts.now;
  return db.transaction().execute(async (trx) => {
    // One checkout at a time per invoice.
    await trx.selectFrom("invoices").select("id").where("id", "=", inv.id).forUpdate().executeTakeFirstOrThrow();
    // Under the invoice's lock, which cancelling the estimate also takes: no new page after it.
    const closed = await depositClosedReason(trx, inv.organizationId, inv.id);
    if (closed) throw new HttpError(409, "payment_closed", `${closed} Contact your service provider.`);
    const open = await trx
      .selectFrom("checkoutSessions")
      .select(["url", "expiresAt"])
      .where("organizationId", "=", inv.organizationId)
      .where("invoiceId", "=", inv.id)
      .where("status", "=", "open")
      .where("amountCents", "=", due)
      // A fee changed in /admin since the page was opened: open a new page at the new fee.
      .where("applicationFeeCents", "=", fee)
      .where("expiresAt", ">", new Date(at.getTime() + REUSE_MIN_REMAINING_MS))
      .orderBy("createdAt", "desc")
      .executeTakeFirst();
    if (open) return { url: open.url };
    const s = invoiceSnapshot.parse(inv.snapshot);
    const n = await trx.selectFrom("checkoutSessions").select(sql<number>`count(*)::int`.as("n")).where("invoiceId", "=", inv.id).executeTakeFirstOrThrow();
    const payPage = payUrlFor(opts.appUrl, opts.token);
    const session = await provider.createCheckout({
      accountId: inv.stripeAccountId!,
      idempotencyKey: `checkout-${inv.id}-${n.n + 1}-${due}`,
      amountCents: due,
      applicationFeeCents: fee,
      description: `${s.provider.name} invoice ${s.number}`,
      customerEmail: (await billingEmail(trx, inv.organizationId, inv.customerId)) ?? s.billTo.email,
      successUrl: opts.successUrl ?? `${payPage}?paid=1`,
      cancelUrl: payPage,
      metadata: { organizationId: inv.organizationId, invoiceId: inv.id },
    });
    await trx
      .insertInto("checkoutSessions")
      .values({ organizationId: inv.organizationId, invoiceId: inv.id, providerSessionId: session.sessionId, amountCents: due, applicationFeeCents: fee, url: session.url, expiresAt: session.expiresAt, createdAt: at })
      .execute();
    return { url: session.url };
  });
}
