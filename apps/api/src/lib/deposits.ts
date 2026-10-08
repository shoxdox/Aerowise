import { createHash, randomUUID } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import { canonicalJson, estimateLabel, invoiceNumberLabel, type DepositView } from "@aerowise/domain";
import { appliedTo, depositBalances, dollars, invoiceEvent, recalcInvoice, reversedOn, settleShortfall, writeEntry } from "@aerowise/payments";
import { sql, type Transaction } from "kysely";
import { HttpError, unprocessable } from "./errors.ts";
import { issueDraft, writeDraftLines } from "./invoices.ts";

// Estimate deposits (SW-5b, service workflows plan §3.6), the API's half: the deposit
// invoice made on acceptance, applying its money to the final invoice and taking it back on
// a void, and the office's refund, keep and shortfall actions. The ledger itself and the
// settling of payments and refunds are in @aerowise/payments (deposits.ts).
//
// Lock order, everywhere: estimate, then work order, then the deposit invoice D, then the
// final invoice F. The webhook path locks D alone.

type Trx = Transaction<DB>;

export const notAvailable = (free: number) =>
  new HttpError(409, "deposit_not_available", free > 0 ? `Only ${dollars(free)} of the deposit is free to use` : "None of the deposit is free to use");

/** Creates and issues the deposit invoice for an accepted estimate: one untaxed line, never emailed by itself. */
export async function createDepositInvoice(
  trx: Trx,
  e: { id: string; organizationId: string; number: number; customerId: string; siteId: string },
  a: { amountCents: number; actorUserId: string | null; at: Date },
) {
  const org = await trx.selectFrom("organizations").select(["invoiceTermsDays"]).where("id", "=", e.organizationId).executeTakeFirstOrThrow();
  const inv = await trx
    .insertInto("invoices")
    .values({
      organizationId: e.organizationId,
      customerId: e.customerId,
      siteId: e.siteId,
      number: null,
      memo: `Deposit for ${estimateLabel(e.number)}. It comes off the final invoice for the work.`,
      termsDays: org.invoiceTermsDays,
      taxRateBps: 0,
      discountCents: 0,
      subtotalCents: 0,
      taxableCents: 0,
      taxCents: 0,
      totalCents: 0,
      issuedOn: null,
      dueOn: null,
      publicToken: null,
      pdfStorageKey: null,
      pdfSha256: null,
      pdfByteSize: null,
      sentAt: null,
      paidAt: null,
      voidedAt: null,
      voidReason: null,
      createdBy: a.actorUserId,
      updatedAt: a.at,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  // H-DEP-1: an untaxed prepayment; tax belongs on the final invoice's work lines.
  await writeDraftLines(trx, e.organizationId, inv.id, [{ description: `Deposit for ${estimateLabel(e.number)}`, quantity: 1, unitPriceCents: a.amountCents, taxable: false }], { discountCents: 0, taxRateBps: 0 }, a.at);
  await trx.insertInto("estimateInvoices").values({ organizationId: e.organizationId, estimateId: e.id, invoiceId: inv.id, role: "deposit", replacesInvoiceId: null, voidedAt: null }).execute();
  const issued = await issueDraft(trx, e.organizationId, inv.id, { send: false, now: a.at });
  await invoiceEvent(trx, { organizationId: e.organizationId, invoiceId: inv.id, eventType: "issued", summary: `Issued as ${issued.label}, the deposit for ${estimateLabel(e.number)}`, actorUserId: a.actorUserId, at: a.at });
  return { invoiceId: inv.id, label: issued.label };
}

/** The active deposit of the estimate a work order came from. */
export async function activeDeposit(ex: Database | Trx, organizationId: string, estimateId: string) {
  return (
    (await ex
      .selectFrom("estimateInvoices")
      .select(["invoiceId", "estimateId"])
      .where("organizationId", "=", organizationId)
      .where("estimateId", "=", estimateId)
      .where("role", "=", "deposit")
      .where("voidedAt", "is", null)
      .executeTakeFirst()) ?? null
  );
}

export type LockedDeposit = { depositInvoiceId: string; estimateId: string };

/**
 * Locks the deposit invoice of the estimate a work order came from, if it has one. The
 * caller has locked the work order and has not yet locked the final invoice.
 */
export async function lockDepositForWorkOrder(trx: Trx, organizationId: string, workOrderId: string): Promise<LockedDeposit | null> {
  const wo = await trx.selectFrom("workOrders").select(["sourceKind", "sourceId"]).where("organizationId", "=", organizationId).where("id", "=", workOrderId).executeTakeFirst();
  if (!wo || wo.sourceKind !== "estimate" || !wo.sourceId) return null;
  const d = await activeDeposit(trx, organizationId, wo.sourceId);
  if (!d) return null;
  await lockDeposit(trx, organizationId, d.invoiceId);
  return { depositInvoiceId: d.invoiceId, estimateId: d.estimateId };
}

export async function lockDeposit(trx: Trx, organizationId: string, depositInvoiceId: string) {
  return trx.selectFrom("invoices").select(["id", "status", "number"]).where("organizationId", "=", organizationId).where("id", "=", depositInvoiceId).forUpdate().executeTakeFirstOrThrow();
}

/**
 * Applies free deposit money to final invoice F as it is issued: `requested`, or all of it
 * up to F's total (I4). Only free money (I2), else 409. Links F as the estimate's final
 * invoice, replacing the last voided one. F is locked by the caller, after D.
 */
export async function applyDepositAtIssue(
  trx: Trx,
  organizationId: string,
  dep: LockedDeposit,
  f: { id: string; subtotalCents: number; discountCents: number; taxCents: number },
  a: { requestedCents?: number; actorUserId: string | null; at: Date },
) {
  const gross = f.subtotalCents - f.discountCents + f.taxCents;
  const b = await depositBalances(trx, organizationId, dep.depositInvoiceId);
  if (a.requestedCents !== undefined && a.requestedCents > gross) throw unprocessable(`At most ${dollars(gross)}, the invoice's total, can be applied`);
  if (a.requestedCents !== undefined && a.requestedCents > Math.max(0, b.free)) throw notAvailable(b.free);
  const amount = a.requestedCents ?? Math.min(Math.max(0, b.free), gross);
  const previous = await trx
    .selectFrom("estimateInvoices")
    .select("invoiceId")
    .where("organizationId", "=", organizationId)
    .where("estimateId", "=", dep.estimateId)
    .where("role", "=", "final")
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst();
  await trx
    .insertInto("estimateInvoices")
    .values({ organizationId, estimateId: dep.estimateId, invoiceId: f.id, role: "final", replacesInvoiceId: previous?.invoiceId ?? null, voidedAt: null })
    .execute()
    .catch((err) => {
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "final_exists", "This estimate already has a final invoice. Void it first.");
      throw err;
    });
  if (amount > 0) {
    await writeEntry(trx, { organizationId, depositInvoiceId: dep.depositInvoiceId, estimateId: dep.estimateId, kind: "applied", amountCents: amount, causeKey: `final:${f.id}`, finalInvoiceId: f.id, actorUserId: a.actorUserId });
    await trx
      .updateTable("invoices")
      .set({ depositAppliedCents: amount, totalCents: gross - amount, updatedAt: a.at })
      .where("organizationId", "=", organizationId)
      .where("id", "=", f.id)
      .execute();
    await invoiceEvent(trx, { organizationId, invoiceId: dep.depositInvoiceId, eventType: "deposit_applied", summary: `${dollars(amount)} applied to the final invoice`, actorUserId: a.actorUserId, details: { finalInvoiceId: f.id }, at: a.at });
  }
  await settleShortfall(trx, organizationId, dep.depositInvoiceId, dep.estimateId, a.actorUserId);
  return amount;
}

/**
 * I5: voiding F takes back everything still applied to it, which releases any shortfall it no
 * longer needs, and ends its link so a replacement can apply again. Refused while a "Refund
 * the job" reversal against F is pending, since its settlement takes from F's applied money.
 */
export async function unapplyAtVoid(trx: Trx, organizationId: string, dep: LockedDeposit, finalInvoiceId: string, a: { actorUserId: string | null; at: Date }) {
  const link = await trx.selectFrom("estimateInvoices").select("id").where("organizationId", "=", organizationId).where("invoiceId", "=", finalInvoiceId).where("role", "=", "final").executeTakeFirst();
  if (!link) return 0;
  const f = await appliedTo(trx, organizationId, dep.depositInvoiceId, finalInvoiceId);
  if (f.pendingReversals > 0) throw new HttpError(409, "refund_pending", "A refund of the deposit applied to this invoice is still pending. Void it once the refund has settled.");
  if (f.applied > 0) {
    await writeEntry(trx, { organizationId, depositInvoiceId: dep.depositInvoiceId, estimateId: dep.estimateId, kind: "unapplied", amountCents: f.applied, causeKey: `void:${finalInvoiceId}`, finalInvoiceId, actorUserId: a.actorUserId });
    await invoiceEvent(trx, { organizationId, invoiceId: dep.depositInvoiceId, eventType: "deposit_unapplied", summary: `${dollars(f.applied)} is free again: the final invoice was voided`, actorUserId: a.actorUserId, details: { finalInvoiceId }, at: a.at });
  }
  await trx.updateTable("estimateInvoices").set({ voidedAt: a.at }).where("id", "=", link.id).execute();
  await settleShortfall(trx, organizationId, dep.depositInvoiceId, dep.estimateId, a.actorUserId);
  return f.applied;
}

interface ReserveArgs {
  organizationId: string;
  /** The invoice whose payments the money goes back from. */
  invoiceId: string;
  amountCents: number;
  reason: string;
  actorUserId: string;
  at: Date;
  /**
   * `deposit_free`: free deposit money (counts in Q). `deposit_applied`: deposit money applied
   * to `finalInvoiceId`, for "Refund the job". null: a final invoice's own payments.
   */
  reservation: "deposit_free" | "deposit_applied" | null;
  finalInvoiceId?: string;
}

/**
 * Step 1 of a refund Aerowise starts: with the invoice locked, reserves the money as pending
 * refund rows (one per payment it comes from, each with its own idempotency key) and books a
 * check or cash refund at once. The caller commits, then asks the provider for each Stripe
 * row (`pushReservedRefund`); nothing moves on the ledger until the provider says it did.
 */
export async function reserveRefunds(trx: Trx, r: ReserveArgs) {
  const pays = await trx
    .selectFrom("payments as p")
    .select([
      "p.id",
      "p.source",
      sql<number>`(p.amount_cents - coalesce((select sum(f.amount_cents) from refunds f where f.payment_id = p.id and f.status <> 'failed'), 0))::int`.as("refundable"),
    ])
    .where("p.organizationId", "=", r.organizationId)
    .where("p.invoiceId", "=", r.invoiceId)
    .where("p.status", "=", "succeeded")
    .orderBy("p.createdAt")
    .orderBy("p.id")
    .execute();
  const rows: { id: string; stripe: boolean; amountCents: number }[] = [];
  let left = r.amountCents;
  for (const p of pays) {
    if (left === 0) break;
    const take = Math.min(left, p.refundable);
    if (take <= 0) continue;
    left -= take;
    const rowId = randomUUID();
    const stripe = p.source === "stripe";
    await trx
      .insertInto("refunds")
      .values({
        id: rowId,
        organizationId: r.organizationId,
        paymentId: p.id,
        amountCents: take,
        // A check or cash refund is handed back by the office and settles at once.
        status: stripe ? "pending" : "succeeded",
        // The customer no longer owes what was given back.
        intent: "credit",
        providerRefundId: null,
        reason: r.reason,
        failureReason: null,
        createdBy: r.actorUserId,
        idempotencyKey: stripe ? `aerowise-refund-${rowId}` : null,
        reservation: r.reservation,
        finalInvoiceId: r.reservation === "deposit_applied" ? (r.finalInvoiceId ?? null) : null,
        createdAt: r.at,
        updatedAt: r.at,
      })
      .execute();
    rows.push({ id: rowId, stripe, amountCents: take });
  }
  if (left > 0) throw unprocessable("The payments do not have that much left to refund");
  await recalcInvoice(trx, r.organizationId, r.invoiceId, r.at);
  const what = r.reservation === "deposit_free" ? " of the deposit" : r.reservation === "deposit_applied" ? " of the deposit, for the job refund" : "";
  for (const row of rows) {
    await invoiceEvent(trx, {
      organizationId: r.organizationId,
      invoiceId: r.invoiceId,
      eventType: row.stripe ? "refund_pending" : "refund_succeeded",
      summary: row.stripe ? `Refund of ${dollars(row.amountCents)}${what} started: ${r.reason}` : `Refunded ${dollars(row.amountCents)}${what}: ${r.reason}`,
      actorUserId: r.actorUserId,
      details: { refundId: row.id },
      at: r.at,
    });
  }
  return rows;
}

/** What is still refundable on an invoice's cleared payments. */
export async function refundableOn(ex: Database | Trx, organizationId: string, invoiceId: string) {
  const r = await ex
    .selectFrom("payments as p")
    .select(sql<number>`coalesce(sum(p.amount_cents - coalesce((select sum(f.amount_cents) from refunds f where f.payment_id = p.id and f.status <> 'failed'), 0)), 0)::int`.as("n"))
    .where("p.organizationId", "=", organizationId)
    .where("p.invoiceId", "=", invoiceId)
    .where("p.status", "=", "succeeded")
    .executeTakeFirstOrThrow();
  return r.n;
}

/**
 * The deposit when its estimate is cancelled (service workflows plan §3.4). Never blocks the
 * cancellation and never moves money. Every open checkout page is closed and no new one opens
 * (`depositClosedReason`). A deposit invoice with nothing paid or clearing is voided; anything
 * received stays on the ledger, and its free part shows in the inbox as "Deposit disposition
 * needed" until the office refunds or keeps it. A payment still clearing, or one the provider
 * completes late, lands there too. Returns the checkout sessions the provider should close.
 */
export async function settleDepositAtCancel(trx: Trx, organizationId: string, dep: LockedDeposit, a: { actorUserId: string; reason: string; at: Date }) {
  const d = await trx.selectFrom("invoices").select(["status", "paidCents", "pendingCents"]).where("organizationId", "=", organizationId).where("id", "=", dep.depositInvoiceId).executeTakeFirstOrThrow();
  if (d.status === "void") return { voided: false, held: 0, openSessions: [] as { providerSessionId: string }[] };
  const openSessions = await trx
    .updateTable("checkoutSessions")
    .set({ status: "expired" })
    .where("organizationId", "=", organizationId)
    .where("invoiceId", "=", dep.depositInvoiceId)
    .where("status", "=", "open")
    .returning("providerSessionId")
    .execute();
  const b = await depositBalances(trx, organizationId, dep.depositInvoiceId);
  if (d.status === "open" && d.paidCents === 0 && d.pendingCents === 0 && b.received === 0) {
    await trx.updateTable("estimateInvoices").set({ voidedAt: a.at }).where("organizationId", "=", organizationId).where("invoiceId", "=", dep.depositInvoiceId).where("voidedAt", "is", null).execute();
    await trx.updateTable("invoices").set({ status: "void", voidedAt: a.at, voidReason: a.reason, updatedAt: a.at }).where("organizationId", "=", organizationId).where("id", "=", dep.depositInvoiceId).execute();
    await recalcInvoice(trx, organizationId, dep.depositInvoiceId, a.at);
    await invoiceEvent(trx, { organizationId, invoiceId: dep.depositInvoiceId, eventType: "voided", summary: `Voided: ${a.reason}`, actorUserId: a.actorUserId, at: a.at });
    return { voided: true, held: 0, openSessions };
  }
  await invoiceEvent(trx, { organizationId, invoiceId: dep.depositInvoiceId, eventType: "deposit_closed", summary: `No longer collected: ${a.reason}`, actorUserId: a.actorUserId, at: a.at });
  return { voided: false, held: Math.max(0, b.free), openSessions };
}

/** The estimate's deposit, for the office. */
export async function depositViewFor(db: Database, organizationId: string, estimateId: string, requestedCents: number | null): Promise<DepositView | null> {
  const links = await db
    .selectFrom("estimateInvoices as ei")
    .innerJoin("invoices as i", (k) => k.onRef("i.id", "=", "ei.invoiceId").onRef("i.organizationId", "=", "ei.organizationId"))
    .select(["ei.invoiceId", "ei.role", "ei.voidedAt", "i.number", "i.status", "i.paymentStatus", "i.totalCents"])
    .where("ei.organizationId", "=", organizationId)
    .where("ei.estimateId", "=", estimateId)
    .orderBy("ei.createdAt")
    .execute();
  const d = [...links].reverse().find((l) => l.role === "deposit");
  if (!d) return null;
  const [b, resolved, ledger, refunds, refundable] = await Promise.all([
    depositBalances(db, organizationId, d.invoiceId),
    db
      .selectFrom("depositShortfallResolutions")
      .select(sql<number>`coalesce(sum(amount_cents), 0)::int`.as("n"))
      .where("organizationId", "=", organizationId)
      .where("depositInvoiceId", "=", d.invoiceId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("depositLedger as l")
      .leftJoin("users as u", "u.id", "l.actorUserId")
      .select(["l.id", "l.kind", "l.amountCents", "l.reason", "l.createdAt", "u.name"])
      .where("l.organizationId", "=", organizationId)
      .where("l.depositInvoiceId", "=", d.invoiceId)
      .orderBy("l.seq")
      .execute(),
    db
      .selectFrom("refunds as f")
      .innerJoin("payments as p", "p.id", "f.paymentId")
      .select(["f.id", "f.amountCents", "f.status", "f.reservation", "f.failureReason", "f.reason", "f.createdAt"])
      .where("p.organizationId", "=", organizationId)
      .where("p.invoiceId", "=", d.invoiceId)
      .orderBy("f.createdAt")
      .execute(),
    refundableOn(db, organizationId, d.invoiceId),
  ]);
  const finals = await Promise.all(
    links
      .filter((l) => l.role === "final")
      .map(async (l) => {
        const a = await appliedTo(db, organizationId, d.invoiceId, l.invoiceId);
        return { id: l.invoiceId, number: l.number === null ? null : invoiceNumberLabel(l.number), status: l.status, appliedCents: a.applied, reversedCents: await reversedOn(db, organizationId, l.invoiceId), active: l.voidedAt === null };
      }),
  );
  return {
    requestedCents: requestedCents ?? d.totalCents,
    invoice: { id: d.invoiceId, number: d.number === null ? null : invoiceNumberLabel(d.number), status: d.status, paymentStatus: d.paymentStatus, totalCents: d.totalCents, voided: d.voidedAt !== null },
    balances: { ...b, shortfallOutstanding: Math.max(0, b.shortfall - resolved.n), overResolved: Math.max(0, resolved.n - b.shortfall) },
    finals,
    ledger: ledger.map((l) => ({ id: l.id, kind: l.kind, amountCents: l.amountCents, reason: l.reason, actorName: l.name, createdAt: l.createdAt.toISOString() })),
    refunds: refunds.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() })),
    refundableCents: refundable,
  };
}

export type DepositAction = "refund" | "retain" | "retain_reverse" | "shortfall" | "refund_job";

/**
 * Claims the office's request id for one deposit action, under the deposit's lock. The first
 * call gets `null` and goes ahead; the same id again with the same action, invoice and body
 * gets the first call's result, so a retry or a double click moves no more money. The same id
 * with anything different is refused. Two calls at once take turns on the row's key: the second
 * waits for the first to commit, then finds its row (or, if it rolled back, goes ahead itself).
 */
export async function claimDepositRequest(
  trx: Trx,
  r: { organizationId: string; requestId: string; action: DepositAction; invoiceId: string; body: Record<string, unknown>; actorUserId: string },
): Promise<{ refundIds: string[] } | null> {
  const { requestId, ...rest } = r.body;
  void requestId;
  const bodySha256 = createHash("sha256").update(canonicalJson(rest)).digest("hex");
  const claimed = await trx
    .insertInto("depositRequests")
    .values({ organizationId: r.organizationId, requestId: r.requestId, action: r.action, invoiceId: r.invoiceId, bodySha256, createdBy: r.actorUserId })
    .onConflict((oc) => oc.columns(["organizationId", "requestId"]).doNothing())
    .returning("requestId")
    .executeTakeFirst();
  if (claimed) return null;
  const prior = await trx
    .selectFrom("depositRequests")
    .select(["action", "invoiceId", "bodySha256", "result"])
    .where("organizationId", "=", r.organizationId)
    .where("requestId", "=", r.requestId)
    .executeTakeFirstOrThrow();
  if (prior.action !== r.action || prior.invoiceId !== r.invoiceId || prior.bodySha256 !== bodySha256)
    throw new HttpError(409, "request_reused", "This request was already sent with different details. Start the action again to make a new one.");
  const result = prior.result as { refundIds?: string[] } | null;
  return { refundIds: result?.refundIds ?? [] };
}

/** What the claimed action did, written in its transaction so a retry can return it. */
export async function recordDepositRequest(trx: Trx, organizationId: string, requestId: string, result: { refundIds: string[] }) {
  await trx.updateTable("depositRequests").set({ result: JSON.stringify(result) }).where("organizationId", "=", organizationId).where("requestId", "=", requestId).execute();
}
