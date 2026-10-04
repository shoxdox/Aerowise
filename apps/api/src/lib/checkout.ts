import type { Database } from "@aerowise/db";
import { amountDue, invoiceSnapshot } from "@aerowise/domain";
import type { PaymentProvider } from "@aerowise/payments";
import { billingEmail, payUrlFor } from "@aerowise/tasks";
import { sql } from "kysely";
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
      "i.pdfStorageKey",
      "o.stripeAccountId",
      "o.stripeChargesEnabled",
    ])
    .where("i.publicToken", "=", token)
    .executeTakeFirst();
  // A void invoice's link stops working.
  if (!inv || inv.status !== "open") throw notFoundLink();
  return inv;
}
export type PayableInvoice = Awaited<ReturnType<typeof invoiceByToken>>;

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
  const at = opts.now;
  return db.transaction().execute(async (trx) => {
    // One checkout at a time per invoice.
    await trx.selectFrom("invoices").select("id").where("id", "=", inv.id).forUpdate().executeTakeFirstOrThrow();
    const open = await trx
      .selectFrom("checkoutSessions")
      .select(["url", "expiresAt"])
      .where("organizationId", "=", inv.organizationId)
      .where("invoiceId", "=", inv.id)
      .where("status", "=", "open")
      .where("amountCents", "=", due)
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
      description: `${s.provider.name} invoice ${s.number}`,
      customerEmail: (await billingEmail(trx, inv.organizationId, inv.customerId)) ?? s.billTo.email,
      successUrl: opts.successUrl ?? `${payPage}?paid=1`,
      cancelUrl: payPage,
      metadata: { organizationId: inv.organizationId, invoiceId: inv.id },
    });
    await trx
      .insertInto("checkoutSessions")
      .values({ organizationId: inv.organizationId, invoiceId: inv.id, providerSessionId: session.sessionId, amountCents: due, url: session.url, expiresAt: session.expiresAt, createdAt: at })
      .execute();
    return { url: session.url };
  });
}
