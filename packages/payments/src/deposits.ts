import type { Database, DB, DepositLedgerKind } from "@aerowise/db";
import { sql, type Transaction } from "kysely";
import { dollars, invoiceEvent, recalcInvoice, type Executor } from "./ledger.ts";
import type { PaymentProvider } from "./provider.ts";

// The deposit ledger (service workflows plan §3.6). One append-only ledger per deposit
// invoice D. Every change runs with D's invoice row locked (`SELECT … FOR UPDATE`), which the
// webhook path takes too, and a deferred trigger re-checks the balances at commit.

type Trx = Transaction<DB>;

/** D's balances, in cents. `free` is money that can really be applied, kept or returned. */
export interface DepositBalances {
  /** R: cleared payments on D. */
  received: number;
  /** X: settled refunds of D's money, external ones and deposit reversals included. */
  returned: number;
  /** A: applied to final invoices, less unapplied and reversed. */
  applied: number;
  /** T: kept under the estimate's terms, less reversals. */
  retained: number;
  /** Q: refunds of free deposit money started in Aerowise and not settled yet. */
  reserved: number;
  /** S: the current deficit. */
  shortfall: number;
  /** U = R − X − Q − A − T + S. */
  free: number;
}

/** The deposit invoice's estimate, when the invoice is one. */
export async function depositLink(ex: Executor, organizationId: string, invoiceId: string) {
  return (
    (await ex
      .selectFrom("estimateInvoices")
      .select(["estimateId", "voidedAt"])
      .where("organizationId", "=", organizationId)
      .where("invoiceId", "=", invoiceId)
      .where("role", "=", "deposit")
      .executeTakeFirst()) ?? null
  );
}

export async function depositBalances(ex: Executor, organizationId: string, depositInvoiceId: string): Promise<DepositBalances> {
  const l = await ex
    .selectFrom("depositLedger")
    .select([
      sql<number>`coalesce(sum(amount_cents) filter (where kind = 'received'), 0)::int`.as("r"),
      sql<number>`coalesce(sum(amount_cents) filter (where kind in ('refunded', 'refunded_external', 'deposit_reversal')), 0)::int`.as("x"),
      sql<number>`coalesce(sum(case kind when 'applied' then amount_cents when 'unapplied' then -amount_cents when 'deposit_reversal' then -amount_cents else 0 end), 0)::int`.as("a"),
      sql<number>`coalesce(sum(case kind when 'retained' then amount_cents when 'retain_reversed' then -amount_cents else 0 end), 0)::int`.as("t"),
      sql<number>`coalesce(sum(case kind when 'shortfall' then amount_cents when 'shortfall_released' then -amount_cents else 0 end), 0)::int`.as("s"),
    ])
    .where("organizationId", "=", organizationId)
    .where("depositInvoiceId", "=", depositInvoiceId)
    .executeTakeFirstOrThrow();
  const q = await ex
    .selectFrom("refunds as f")
    .innerJoin("payments as p", "p.id", "f.paymentId")
    .select(sql<number>`coalesce(sum(f.amount_cents), 0)::int`.as("q"))
    .where("p.organizationId", "=", organizationId)
    .where("p.invoiceId", "=", depositInvoiceId)
    .where("f.status", "=", "pending")
    .where("f.reservation", "=", "deposit_free")
    .executeTakeFirstOrThrow();
  return { received: l.r, returned: l.x, applied: l.a, retained: l.t, reserved: q.q, shortfall: l.s, free: l.r - l.x - q.q - l.a - l.t + l.s };
}

/** What is applied to one final invoice now, and what of it has a reversal pending. */
export async function appliedTo(ex: Executor, organizationId: string, depositInvoiceId: string, finalInvoiceId: string) {
  const a = await ex
    .selectFrom("depositLedger")
    .select(sql<number>`coalesce(sum(case kind when 'applied' then amount_cents else -amount_cents end), 0)::int`.as("a"))
    .where("organizationId", "=", organizationId)
    .where("depositInvoiceId", "=", depositInvoiceId)
    .where("finalInvoiceId", "=", finalInvoiceId)
    .where("kind", "in", ["applied", "unapplied", "deposit_reversal"])
    .executeTakeFirstOrThrow();
  const pending = await ex
    .selectFrom("refunds")
    .select(sql<number>`coalesce(sum(amount_cents), 0)::int`.as("p"))
    .where("organizationId", "=", organizationId)
    .where("finalInvoiceId", "=", finalInvoiceId)
    .where("reservation", "=", "deposit_applied")
    .where("status", "=", "pending")
    .executeTakeFirstOrThrow();
  return { applied: a.a, pendingReversals: pending.p };
}

export interface LedgerEntry {
  organizationId: string;
  depositInvoiceId: string;
  estimateId: string;
  kind: DepositLedgerKind;
  amountCents: number;
  causeKey: string;
  paymentId?: string | null;
  refundId?: string | null;
  finalInvoiceId?: string | null;
  actorUserId?: string | null;
  reason?: string | null;
}

/** Writes an entry once: a replay of the same event finds it by (D, cause, kind) and writes nothing. */
export async function writeEntry(trx: Trx, e: LedgerEntry): Promise<boolean> {
  if (e.amountCents <= 0) return false;
  const row = await trx
    .insertInto("depositLedger")
    .values({
      organizationId: e.organizationId,
      depositInvoiceId: e.depositInvoiceId,
      estimateId: e.estimateId,
      kind: e.kind,
      amountCents: e.amountCents,
      causeKey: e.causeKey,
      paymentId: e.paymentId ?? null,
      refundId: e.refundId ?? null,
      finalInvoiceId: e.finalInvoiceId ?? null,
      actorUserId: e.actorUserId ?? null,
      reason: e.reason ?? null,
    })
    .onConflict((oc) => oc.columns(["depositInvoiceId", "causeKey", "kind"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  return !!row;
}

/**
 * Brings S to the current deficit, max(0, X + Q + A + T − R), by writing the difference.
 * Never a running total: a deficit that goes away is released in the same transaction.
 */
export async function settleShortfall(trx: Trx, organizationId: string, depositInvoiceId: string, estimateId: string, actorUserId: string | null = null) {
  const b = await depositBalances(trx, organizationId, depositInvoiceId);
  const need = Math.max(0, b.returned + b.reserved + b.applied + b.retained - b.received);
  const diff = need - b.shortfall;
  if (diff === 0) return b;
  // One adjustment per change in the deficit, numbered under D's lock.
  const n = await trx
    .selectFrom("depositLedger")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("depositInvoiceId", "=", depositInvoiceId)
    .where("kind", "in", ["shortfall", "shortfall_released"])
    .executeTakeFirstOrThrow();
  await writeEntry(trx, {
    organizationId,
    depositInvoiceId,
    estimateId,
    kind: diff > 0 ? "shortfall" : "shortfall_released",
    amountCents: Math.abs(diff),
    causeKey: `adjust:${n.n + 1}`,
    actorUserId,
  });
  return depositBalances(trx, organizationId, depositInvoiceId);
}

/**
 * Books what has happened to D's money since the ledger last looked: each cleared payment
 * and each settled refund, once. Called by `recalcInvoice` with D locked, so every path that
 * moves a payment or a refund (webhooks, manual payments, the refund routes) keeps it in step.
 * An invoice that is not a deposit is left alone.
 */
export async function reconcileDeposit(trx: Trx, organizationId: string, invoiceId: string, now: Date) {
  const link = await depositLink(trx, organizationId, invoiceId);
  if (!link) return null;
  const base = { organizationId, depositInvoiceId: invoiceId, estimateId: link.estimateId };
  const paid = await trx.selectFrom("payments").select(["id", "amountCents"]).where("organizationId", "=", organizationId).where("invoiceId", "=", invoiceId).where("status", "=", "succeeded").execute();
  for (const p of paid) await writeEntry(trx, { ...base, kind: "received", amountCents: p.amountCents, causeKey: `payment:${p.id}`, paymentId: p.id });
  const settled = await trx
    .selectFrom("refunds as f")
    .innerJoin("payments as p", "p.id", "f.paymentId")
    .select(["f.id", "f.paymentId", "f.amountCents", "f.reservation", "f.finalInvoiceId", "f.createdBy", "f.reason"])
    .where("p.organizationId", "=", organizationId)
    .where("p.invoiceId", "=", invoiceId)
    .where("f.status", "=", "succeeded")
    .execute();
  for (const f of settled) {
    const kind: DepositLedgerKind = f.reservation === "deposit_applied" ? "deposit_reversal" : f.reservation === "deposit_free" ? "refunded" : "refunded_external";
    const wrote = await writeEntry(trx, {
      ...base,
      kind,
      amountCents: f.amountCents,
      causeKey: `refund:${f.id}`,
      paymentId: f.paymentId,
      refundId: f.id,
      finalInvoiceId: f.finalInvoiceId,
      actorUserId: f.createdBy,
    });
    if (wrote && kind === "deposit_reversal" && f.finalInvoiceId) {
      await invoiceEvent(trx, {
        organizationId,
        invoiceId: f.finalInvoiceId,
        eventType: "deposit_reversed",
        summary: `${dollars(f.amountCents)} of the deposit applied here was returned to the customer`,
        paymentId: null,
        details: { refundId: f.id, depositInvoiceId: invoiceId },
        at: now,
      });
    }
  }
  return settleShortfall(trx, organizationId, invoiceId, link.estimateId);
}

/**
 * Deposit money returned for the work on a final invoice ("Refund the job"). It is the
 * credit on F: F's own columns stay as issued, so its PDF and amount due never change.
 */
export async function reversedOn(ex: Executor, organizationId: string, finalInvoiceId: string) {
  const r = await ex
    .selectFrom("depositLedger")
    .select(sql<number>`coalesce(sum(amount_cents), 0)::int`.as("r"))
    .where("organizationId", "=", organizationId)
    .where("finalInvoiceId", "=", finalInvoiceId)
    .where("kind", "=", "deposit_reversal")
    .executeTakeFirstOrThrow();
  return r.r;
}

/**
 * Asks the provider for a refund Aerowise has already reserved, with the key it was reserved
 * under, and stores the answer. Runs after the reservation committed: a retry (the route
 * again, or the reconcile task after a lost answer) gets the same refund back. A webhook
 * that got there first has already settled it; then this only checks the ids agree.
 */
export async function pushReservedRefund(db: Database, provider: PaymentProvider, organizationId: string, refundId: string, now: () => Date): Promise<"sent" | "settled" | "skipped"> {
  const row = await db
    .selectFrom("refunds as f")
    .innerJoin("payments as p", "p.id", "f.paymentId")
    .innerJoin("organizations as o", "o.id", "p.organizationId")
    .select(["f.id", "f.status", "f.amountCents", "f.idempotencyKey", "f.providerRefundId", "p.invoiceId", "p.id as paymentId", "p.providerPaymentId", "p.source", "o.stripeAccountId"])
    .where("f.organizationId", "=", organizationId)
    .where("f.id", "=", refundId)
    .executeTakeFirst();
  if (!row || row.status !== "pending" || row.providerRefundId || !row.idempotencyKey || row.source !== "stripe" || !row.providerPaymentId || !row.stripeAccountId) return "skipped";
  const r = await provider.createRefund({
    organizationId,
    accountId: row.stripeAccountId,
    idempotencyKey: row.idempotencyKey,
    paymentIntentId: row.providerPaymentId,
    amountCents: row.amountCents,
    metadata: { organizationId, invoiceId: row.invoiceId, paymentId: row.paymentId, refundId: row.id },
  });
  return db.transaction().execute(async (trx) => {
    const at = now();
    await trx.selectFrom("invoices").select("id").where("id", "=", row.invoiceId).forUpdate().executeTakeFirstOrThrow();
    const cur = await trx.selectFrom("refunds").select(["status", "providerRefundId"]).where("id", "=", row.id).forUpdate().executeTakeFirstOrThrow();
    if (cur.providerRefundId) return "settled";
    // A final status never changes again; a pending one takes the provider's answer.
    await trx
      .updateTable("refunds")
      .set({ providerRefundId: r.refundId, ...(cur.status === "pending" ? { status: r.status, failureReason: r.failureReason } : {}), updatedAt: at })
      .where("id", "=", row.id)
      .execute();
    await recalcInvoice(trx, organizationId, row.invoiceId, at);
    if (cur.status === "pending" && r.status !== "pending") {
      await invoiceEvent(trx, {
        organizationId,
        invoiceId: row.invoiceId,
        eventType: `refund_${r.status}`,
        summary: r.status === "succeeded" ? `Refund of ${dollars(row.amountCents)} went through` : `Refund of ${dollars(row.amountCents)} failed: ${r.failureReason ?? "declined"}`,
        paymentId: row.paymentId,
        at,
      });
    }
    return "sent";
  });
}

/** Reserved refunds that never reached the provider (the process stopped, or its answer was lost). */
export async function unsentRefunds(db: Database, olderThan: Date) {
  return db
    .selectFrom("refunds")
    .select(["id", "organizationId"])
    .where("status", "=", "pending")
    .where("providerRefundId", "is", null)
    .where("idempotencyKey", "is not", null)
    .where("createdAt", "<", olderThan)
    .orderBy("createdAt")
    .limit(100)
    .execute();
}
