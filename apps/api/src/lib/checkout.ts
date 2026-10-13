import type { Database, DB } from "@aerowise/db";
import { amountDue, invoiceSnapshot, platformFeeCents } from "@aerowise/domain";
import type { PaymentProvider } from "@aerowise/payments";
import { billingEmail, linkTokenId, payUrlFor } from "@aerowise/tasks";
import { sql, type Transaction } from "kysely";
import type { FastifyBaseLogger } from "fastify";
import { HttpError, unprocessable } from "./errors.ts";

/** Reuse an open checkout page only if it stays payable for at least this long. */
const REUSE_MIN_REMAINING_MS = 60 * 60 * 1000;

export const notFoundLink = () => new HttpError(404, "not_found", "This payment link is not valid. Contact your service provider for a new one.");

/** An invoice and its company, with what checkout needs. */
const payable = (ex: Database | Transaction<DB>) =>
  ex
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
    ]);

/** An open invoice by id, with what checkout needs. */
export async function openInvoiceById(db: Database, invoiceId: string) {
  const inv = await payable(db).where("i.id", "=", invoiceId).executeTakeFirst();
  // A void invoice's link stops working.
  if (!inv || inv.status !== "open") throw notFoundLink();
  return inv;
}
/** An open invoice by its signed pay-link token (`links.ts`); a token that does not verify is not found. */
export async function invoiceByToken(db: Database, token: string) {
  const id = linkTokenId("pay", token);
  if (!id) throw notFoundLink();
  const inv = await payable(db).where("i.id", "=", id).executeTakeFirst();
  if (!inv) throw notFoundLink();
  if (inv.status !== "open") throw new HttpError(410, "revoked", "This payment link was turned off. Contact your provider before making another payment.");
  return inv;
}
export type PayableInvoice = Awaited<ReturnType<typeof openInvoiceById>>;

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
  opts: { provider: PaymentProvider | null; appUrl: string; inv: PayableInvoice; now: Date; successUrl?: string },
): Promise<{ url: string }> {
  const { provider } = opts;
  const at = opts.now;
  return db.transaction().execute(async (trx) => {
    // One checkout at a time per invoice. Everything is read again under the lock: the caller's
    // copy was read before it, and a payment, void or cancellation may have landed in between
    // (each takes this lock), so what is due and whether it can be paid come from now.
    await trx.selectFrom("invoices").select("id").where("id", "=", opts.inv.id).forUpdate().executeTakeFirstOrThrow();
    const inv = await payable(trx).where("i.id", "=", opts.inv.id).where("i.organizationId", "=", opts.inv.organizationId).executeTakeFirst();
    if (!inv || inv.status !== "open") throw notFoundLink();
    if (!canPayOnline(provider, inv) || !provider) throw unprocessable(amountDue(inv) === 0 ? "Nothing is due on this invoice" : "Online payment is not available. Contact your service provider.");
    const due = amountDue(inv);
    const fee = platformFeeCents(due, inv.platformFeeBps);
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
    const payPage = payUrlFor(opts.appUrl, inv.id);
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

/**
 * Marks an invoice's open checkout pages expired, under the invoice lock the caller holds.
 * Called by anything that lowers what is due (a payment recorded by the office, a void), so a
 * page the customer left open cannot charge an amount that is no longer owed. Returns the
 * provider's session ids for `expireAtProvider`, once the transaction has committed.
 */
export async function closeOpenCheckouts(trx: Transaction<DB>, organizationId: string, invoiceId: string) {
  return trx
    .updateTable("checkoutSessions")
    .set({ status: "expired" })
    .where("organizationId", "=", organizationId)
    .where("invoiceId", "=", invoiceId)
    .where("status", "=", "open")
    .returning("providerSessionId")
    .execute();
}

/**
 * Closes those pages at the provider too. A failure is logged, not thrown: the local record
 * already refuses the page, and a payment that still comes in shows as money to refund.
 */
export async function expireAtProvider(db: Database, provider: PaymentProvider | null, log: FastifyBaseLogger, organizationId: string, sessions: { providerSessionId: string }[]) {
  if (!provider || sessions.length === 0) return;
  const org = await db.selectFrom("organizations").select("stripeAccountId").where("id", "=", organizationId).executeTakeFirstOrThrow();
  if (!org.stripeAccountId) return;
  for (const s of sessions) {
    await provider.expireCheckout({ organizationId, accountId: org.stripeAccountId, sessionId: s.providerSessionId }).catch((err: Error) => log.warn({ err }, "could not expire checkout"));
  }
}
