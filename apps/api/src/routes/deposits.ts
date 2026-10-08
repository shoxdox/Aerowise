import type { Database, DB } from "@aerowise/db";
import { depositRefundInput, depositRetainInput, depositShortfallInput, depositView, id, refundJobInput, type Feature } from "@aerowise/domain";
import { appliedTo, depositBalances, depositLink, dollars, invoiceEvent, pushReservedRefund, settleShortfall, writeEntry } from "@aerowise/payments";
import { queueQuickBooksSync } from "@aerowise/tasks";
import type { FastifyBaseLogger } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { claimDepositRequest, depositViewFor, lockDeposit, lockDepositForWorkOrder, notAvailable, recordDepositRequest, refundableOn, reserveRefunds, type DepositAction } from "../lib/deposits.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import type { PaymentsConfig } from "../lib/invoices.ts";
import { lockInvoiceWorkOrder } from "../lib/work-orders.ts";

// The office's deposit actions (SW-5b, service workflows plan §3.6): refund free deposit
// money, keep it under the estimate's terms (and undo that), record how a shortfall was dealt
// with, and "Refund the job" on a final invoice. Every one locks the deposit invoice D first;
// a refund is reserved and committed before the provider is asked, and booked only when the
// provider says the money moved.

type Trx = Transaction<DB>;
const params = z.object({ id });
const response = { 200: z.object({ deposit: depositView }) };

export const depositRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; payments: PaymentsConfig; features: ReadonlySet<Feature> }> = async (app, { db, now, payments }) => {
  /** D, locked, with its estimate. A final or ordinary invoice is "not found" here. */
  async function lockedDeposit(trx: Trx, organizationId: string, invoiceId: string) {
    const link = await depositLink(trx, organizationId, invoiceId);
    if (!link) throw notFound("Deposit");
    await lockDeposit(trx, organizationId, invoiceId);
    return { depositInvoiceId: invoiceId, estimateId: link.estimateId };
  }

  async function view(organizationId: string, estimateId: string) {
    const e = await db.selectFrom("estimates").select("acceptedSelection").where("organizationId", "=", organizationId).where("id", "=", estimateId).executeTakeFirstOrThrow();
    const requested = (e.acceptedSelection as { depositCents?: number } | null)?.depositCents ?? null;
    const deposit = await depositViewFor(db, organizationId, estimateId, requested);
    return { deposit: deposit! };
  }

  /** The request id first, under D's lock: a repeat returns the first result before anything is checked again. */
  const claim = (trx: Trx, organizationId: string, userId: string, action: DepositAction, invoiceId: string, body: { requestId: string } & Record<string, unknown>) =>
    claimDepositRequest(trx, { organizationId, requestId: body.requestId, action, invoiceId, body, actorUserId: userId });

  /** Online refunds need the company's Stripe account; check and cash refunds do not. */
  async function needsProvider(trx: Trx, organizationId: string, invoiceId: string) {
    const stripe = await trx.selectFrom("payments").select("id").where("organizationId", "=", organizationId).where("invoiceId", "=", invoiceId).where("source", "=", "stripe").where("status", "=", "succeeded").executeTakeFirst();
    if (!stripe) return;
    const org = await trx.selectFrom("organizations").select("stripeAccountId").where("id", "=", organizationId).executeTakeFirstOrThrow();
    if (!payments.provider || !org.stripeAccountId) throw unprocessable("Online payments are not set up, so this deposit cannot be refunded from here");
  }

  /** Step 2, after the reservation committed. A failure here leaves it pending for the reconcile task. */
  async function push(log: FastifyBaseLogger, organizationId: string, rows: { id: string; stripe: boolean }[]) {
    if (!payments.provider) return;
    for (const r of rows.filter((x) => x.stripe)) {
      await pushReservedRefund(db, payments.provider, organizationId, r.id, now).catch((err: Error) => log.warn({ err, refundId: r.id }, "refund request did not finish; the reconcile task asks again"));
    }
  }

  app.post(
    "/invoices/:id/deposit/refund",
    {
      config: { permission: "billing:manage" },
      schema: {
        tags: ["deposits"],
        summary: "Refund free deposit money to the customer",
        description: "Only money that is free (not applied, kept or already being refunded): 409 `deposit_not_available` otherwise. A card or bank refund stays pending until Stripe says it went through.",
        params,
        body: depositRefundInput,
        response,
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const b = req.body;
      const r = await db.transaction().execute(async (trx) => {
        const at = now();
        const dep = await lockedDeposit(trx, organizationId, req.params.id);
        const prior = await claim(trx, organizationId, userId, "refund", dep.depositInvoiceId, b);
        // A repeat asks the provider again for its refunds (same idempotency keys), in case the first answer was lost.
        if (prior) return { dep, rows: prior.refundIds.map((id) => ({ id, stripe: true })) };
        const bal = await depositBalances(trx, organizationId, dep.depositInvoiceId);
        if (b.amountCents > Math.max(0, bal.free)) throw notAvailable(bal.free);
        await needsProvider(trx, organizationId, dep.depositInvoiceId);
        const rows = await reserveRefunds(trx, { organizationId, invoiceId: dep.depositInvoiceId, amountCents: b.amountCents, reason: b.reason, actorUserId: userId, at, reservation: "deposit_free" });
        await audit(trx, req, { action: "deposit.refunded", entityType: "invoice", entityId: dep.depositInvoiceId, changes: { ...b, refundIds: rows.map((x) => x.id) } });
        await recordDepositRequest(trx, organizationId, b.requestId, { refundIds: rows.map((x) => x.id) });
        if (rows.some((x) => !x.stripe)) await queueQuickBooksSync(trx, organizationId, at);
        return { dep, rows };
      });
      await push(req.log, organizationId, r.rows);
      return view(organizationId, r.dep.estimateId);
    },
  );

  app.post(
    "/invoices/:id/deposit/retain",
    {
      config: { permission: "billing:manage" },
      schema: { tags: ["deposits"], summary: "Keep free deposit money under the estimate's terms", description: "Only free money; 409 `deposit_not_available` otherwise.", params, body: depositRetainInput, response },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const b = req.body;
      const dep = await db.transaction().execute(async (trx) => {
        const at = now();
        const dep = await lockedDeposit(trx, organizationId, req.params.id);
        if (await claim(trx, organizationId, userId, "retain", dep.depositInvoiceId, b)) return dep;
        const bal = await depositBalances(trx, organizationId, dep.depositInvoiceId);
        if (b.amountCents > Math.max(0, bal.free)) throw notAvailable(bal.free);
        await writeEntry(trx, { ...dep, organizationId, kind: "retained", amountCents: b.amountCents, causeKey: `retain:${b.requestId}`, actorUserId: userId, reason: b.reason });
        await settleShortfall(trx, organizationId, dep.depositInvoiceId, dep.estimateId, userId);
        await invoiceEvent(trx, { organizationId, invoiceId: dep.depositInvoiceId, eventType: "deposit_retained", summary: `Kept ${dollars(b.amountCents)} of the deposit: ${b.reason}`, actorUserId: userId, at });
        await audit(trx, req, { action: "deposit.retained", entityType: "invoice", entityId: dep.depositInvoiceId, changes: b });
        return dep;
      });
      return view(organizationId, dep.estimateId);
    },
  );

  app.post(
    "/invoices/:id/deposit/retain-reverse",
    {
      config: { permission: "billing:manage" },
      schema: { tags: ["deposits"], summary: "Put kept deposit money back, so it can be refunded or applied", params, body: depositRetainInput, response },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const b = req.body;
      const dep = await db.transaction().execute(async (trx) => {
        const at = now();
        const dep = await lockedDeposit(trx, organizationId, req.params.id);
        if (await claim(trx, organizationId, userId, "retain_reverse", dep.depositInvoiceId, b)) return dep;
        const bal = await depositBalances(trx, organizationId, dep.depositInvoiceId);
        if (b.amountCents > bal.retained) throw new HttpError(409, "deposit_not_retained", `Only ${dollars(bal.retained)} of the deposit is kept`);
        await writeEntry(trx, { ...dep, organizationId, kind: "retain_reversed", amountCents: b.amountCents, causeKey: `retain_reversed:${b.requestId}`, actorUserId: userId, reason: b.reason });
        await settleShortfall(trx, organizationId, dep.depositInvoiceId, dep.estimateId, userId);
        await invoiceEvent(trx, { organizationId, invoiceId: dep.depositInvoiceId, eventType: "deposit_retain_reversed", summary: `${dollars(b.amountCents)} of the kept deposit put back: ${b.reason}`, actorUserId: userId, at });
        await audit(trx, req, { action: "deposit.retain_reversed", entityType: "invoice", entityId: dep.depositInvoiceId, changes: b });
        return dep;
      });
      return view(organizationId, dep.estimateId);
    },
  );

  app.post(
    "/invoices/:id/deposit/shortfall",
    {
      config: { permission: "billing:manage" },
      schema: {
        tags: ["deposits"],
        summary: "Record how a deposit shortfall was dealt with: a supplemental invoice or a write-off",
        description: "Never changes the ledger's balances; at most the shortfall still outstanding.",
        params,
        body: depositShortfallInput,
        response,
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const b = req.body;
      const dep = await db.transaction().execute(async (trx) => {
        const dep = await lockedDeposit(trx, organizationId, req.params.id);
        if (await claim(trx, organizationId, userId, "shortfall", dep.depositInvoiceId, b)) return dep;
        const bal = await depositBalances(trx, organizationId, dep.depositInvoiceId);
        const resolved = await trx
          .selectFrom("depositShortfallResolutions")
          .select(sql<number>`coalesce(sum(amount_cents), 0)::int`.as("n"))
          .where("depositInvoiceId", "=", dep.depositInvoiceId)
          .executeTakeFirstOrThrow();
        const outstanding = Math.max(0, bal.shortfall - resolved.n);
        if (b.amountCents > outstanding) throw new HttpError(409, "no_shortfall", outstanding ? `Only ${dollars(outstanding)} of the shortfall is outstanding` : "There is no shortfall to resolve");
        let invoiceId: string | null = null;
        if (b.kind === "supplemental_invoice") {
          const d = await trx.selectFrom("invoices").select("customerId").where("id", "=", dep.depositInvoiceId).executeTakeFirstOrThrow();
          const inv = await trx.selectFrom("invoices").select(["id", "customerId"]).where("organizationId", "=", organizationId).where("id", "=", b.invoiceId).executeTakeFirst();
          if (!inv) throw notFound("Invoice");
          if (inv.customerId !== d.customerId) throw unprocessable("The supplemental invoice is for a different customer");
          invoiceId = inv.id;
        }
        await trx.insertInto("depositShortfallResolutions").values({ organizationId, depositInvoiceId: dep.depositInvoiceId, amountCents: b.amountCents, kind: b.kind, invoiceId, reason: b.reason, createdBy: userId }).execute();
        await invoiceEvent(trx, {
          organizationId,
          invoiceId: dep.depositInvoiceId,
          eventType: "deposit_shortfall_resolved",
          summary: `${dollars(b.amountCents)} of the shortfall ${b.kind === "write_off" ? "written off" : "billed on a supplemental invoice"}: ${b.reason}`,
          actorUserId: userId,
          at: now(),
        });
        await audit(trx, req, { action: "deposit.shortfall_resolved", entityType: "invoice", entityId: dep.depositInvoiceId, changes: b });
        return dep;
      });
      return view(organizationId, dep.estimateId);
    },
  );

  app.post(
    "/invoices/:id/refund-job",
    {
      config: { permission: "billing:manage" },
      schema: {
        tags: ["deposits"],
        summary: "Refund the job: the final invoice's own payments first, then the deposit money applied to it",
        description:
          "The deposit part is a refund of the deposit's payment, reserved against what is applied to this invoice (409 `deposit_not_available` beyond it). Only when it succeeds is the reversal booked, as a credit on this invoice, so it is never owed again.",
        params,
        body: refundJobInput,
        response,
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const b = req.body;
      const r = await db.transaction().execute(async (trx) => {
        const at = now();
        // Work order, deposit, then the final invoice.
        const wo = await lockInvoiceWorkOrder(trx, organizationId, req.params.id);
        const dep = wo ? await lockDepositForWorkOrder(trx, organizationId, wo.id) : null;
        const f = await trx.selectFrom("invoices").select(["id", "status"]).where("organizationId", "=", organizationId).where("id", "=", req.params.id).forUpdate().executeTakeFirst();
        if (!f) throw notFound("Invoice");
        const prior = await claim(trx, organizationId, userId, "refund_job", f.id, b);
        if (prior && dep) return { dep, rows: prior.refundIds.map((id) => ({ id, stripe: true })) };
        const link = dep
          ? await trx.selectFrom("estimateInvoices").select("id").where("invoiceId", "=", f.id).where("role", "=", "final").where("voidedAt", "is", null).executeTakeFirst()
          : undefined;
        if (!dep || !link || f.status !== "open") throw new HttpError(409, "not_final_invoice", "Only an issued final invoice for an estimate with a deposit is refunded this way");
        const direct = Math.min(b.amountCents, await refundableOn(trx, organizationId, f.id));
        const fromDeposit = b.amountCents - direct;
        if (fromDeposit > 0) {
          const a = await appliedTo(trx, organizationId, dep.depositInvoiceId, f.id);
          const available = a.applied - a.pendingReversals;
          if (fromDeposit > available) throw notAvailable(available);
          await needsProvider(trx, organizationId, dep.depositInvoiceId);
        }
        if (direct > 0) await needsProvider(trx, organizationId, f.id);
        const rows = [
          ...(direct > 0 ? await reserveRefunds(trx, { organizationId, invoiceId: f.id, amountCents: direct, reason: b.reason, actorUserId: userId, at, reservation: null }) : []),
          ...(fromDeposit > 0
            ? await reserveRefunds(trx, { organizationId, invoiceId: dep.depositInvoiceId, amountCents: fromDeposit, reason: b.reason, actorUserId: userId, at, reservation: "deposit_applied", finalInvoiceId: f.id })
            : []),
        ];
        await invoiceEvent(trx, {
          organizationId,
          invoiceId: f.id,
          eventType: "job_refund_started",
          summary: `Refund of the job, ${dollars(b.amountCents)}: ${dollars(direct)} from this invoice's payments, ${dollars(fromDeposit)} from the deposit. ${b.reason}`,
          actorUserId: userId,
          details: { refundIds: rows.map((x) => x.id) },
          at,
        });
        await audit(trx, req, { action: "invoice.job_refunded", entityType: "invoice", entityId: f.id, changes: { ...b, direct, fromDeposit, refundIds: rows.map((x) => x.id) } });
        await recordDepositRequest(trx, organizationId, b.requestId, { refundIds: rows.map((x) => x.id) });
        if (rows.some((x) => !x.stripe)) await queueQuickBooksSync(trx, organizationId, at);
        return { dep, rows };
      });
      await push(req.log, organizationId, r.rows);
      return view(organizationId, r.dep.estimateId);
    },
  );
};
