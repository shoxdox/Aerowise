import type { Database, DB } from "@aerowise/db";
import {
  amountDue,
  contractInstallments,
  id,
  invoiceDetail as invoiceDetailSchema,
  invoiceInput,
  invoiceIssueInput,
  invoiceListItem,
  invoiceNumberLabel,
  invoicePatch,
  invoiceVoidInput,
  manualPaymentInput,
  PAYMENT_METHOD_LABELS,
  refundInput,
  type Feature,
  type InvoiceLineInput,
  parseSnapshotOptions,
} from "@aerowise/domain";
import { depositLink, dollars, invoiceEvent, paymentOnTimeline, recalcInvoice } from "@aerowise/payments";
import { billingEmail, queueQuickBooksSync } from "@aerowise/tasks";
import type { ObjectStore } from "@aerowise/storage";
import { activatePaidRenewals } from "@aerowise/renewals";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import {
  applyView,
  checkDraftRefs,
  invoiceBase,
  invoiceDetail,
  isFractional,
  issueDraft,
  overdueFirst,
  queueSend,
  shownQuantity,
  toListItem,
  writeDraftLines,
  type PaymentsConfig,
} from "../lib/invoices.ts";
import { afterCoveredInvoiceVoided, consumeCoverage } from "../lib/coverage.ts";
import { lockDepositForWorkOrder, unapplyAtVoid } from "../lib/deposits.ts";
import { afterWorkOrderInvoiceEnded, lockInvoiceWorkOrder } from "../lib/work-orders.ts";
import { dateInZone, organizationToday } from "../lib/today.ts";
import { readForDownload } from "../lib/demo.ts";

const params = z.object({ id });
const VIEWS = ["unpaid", "overdue", "draft", "paid", "void", "all"] as const;
const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

/**
 * Lines for the authority filing fees on a site's sent filings that no invoice (other than a
 * void one) bills yet, for a company that bills them to the homeowner (Justin, 2026-10-05).
 * Late fees are the company's own and are never passed on.
 */
async function filingFeeLines(trx: Transaction<DB>, organizationId: string, siteId: string, timezone: string) {
  const fees = await trx
    .selectFrom("filings as f")
    .select(["f.id", "f.kind", "f.filingFeeCents", "f.sentAt"])
    .select((eb) => eb.selectFrom("jurisdictions as j").select("j.authorityName").whereRef("j.id", "=", "f.jurisdictionId").as("authorityName"))
    .where("f.organizationId", "=", organizationId)
    .where("f.siteId", "=", siteId)
    .where("f.filingFeeCents", ">", 0)
    .where("f.sentAt", "is not", null)
    .where((w) =>
      w.not(
        w.exists(
          w
            .selectFrom("invoiceLines as l")
            .innerJoin("invoices as i", "i.id", "l.invoiceId")
            .select("l.id")
            .whereRef("l.organizationId", "=", "f.organizationId")
            .whereRef("l.filingId", "=", "f.id")
            .where("i.status", "<>", "void"),
        ),
      ),
    )
    .orderBy("f.sentAt")
    // Two invoices made at once for the same site take turns, so a fee is billed once.
    .forUpdate()
    .execute();
  return fees.map((f) => ({
    description: `${f.authorityName ?? "Authority"} filing fee: ${f.kind === "contract" ? "maintenance contract" : "inspection report"} filed ${day(dateInZone(f.sentAt!, timezone))}`,
    quantity: 1,
    unitPriceCents: f.filingFeeCents!,
    taxable: false,
    filingId: f.id,
  }));
}

export const invoiceRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; store: ObjectStore; payments: PaymentsConfig; features: ReadonlySet<Feature> }> = async (
  app,
  { db, now, store, payments, features },
) => {
  /**
   * Fractional quantities come with service items (SW-3). With them off, no new fraction is
   * taken, but a draft's line keeps the fraction it already has (sent back with its id and the
   * same quantity), so a draft made while they were on can still be edited and saved.
   * `existing` is the locked draft's lines.
   */
  const checkQuantities = (lines: InvoiceLineInput[] | undefined, existing: { id: string; quantityMilli: number | null }[] = []) => {
    if (features.has("service_items") || !lines) return;
    const kept = new Map(existing.filter((l) => l.quantityMilli !== null).map((l) => [l.id, l.quantityMilli]));
    for (const l of lines) {
      if (!isFractional(l.quantity)) continue;
      if (l.id && kept.get(l.id) === Math.round(l.quantity! * 1000)) continue;
      throw new HttpError(409, "feature_off", "Fractional quantities are not switched on for this deployment; use whole numbers");
    }
  };

  const detail = async (organizationId: string, invoiceId: string) =>
    invoiceDetail(db, organizationId, invoiceId, await organizationToday(db, organizationId, now()), payments.appUrl);

  /** Locks a draft for editing; anything else is refused. */
  async function lockDraft(trx: Parameters<Parameters<ReturnType<Database["transaction"]>["execute"]>[0]>[0], organizationId: string, invoiceId: string) {
    const inv = await trx.selectFrom("invoices").selectAll().where("organizationId", "=", organizationId).where("id", "=", invoiceId).forUpdate().executeTakeFirst();
    if (!inv) throw notFound("Invoice");
    if (inv.status !== "draft") throw unprocessable("Only drafts can be changed. Void an issued invoice and issue a new one instead.");
    return inv;
  }

  app.get(
    "/invoices",
    {
      config: { permission: "invoices:read" },
      schema: {
        tags: ["invoices"],
        summary: "Invoices, drafts and the most overdue first",
        description: "`unpaid`: issued and not fully paid (including bank payments still clearing). `overdue`: unpaid past the due date. `paid`: fully paid, overpaid or refunded.",
        querystring: z.object({
          view: z.enum(VIEWS).default("unpaid"),
          customerId: id.optional(),
          siteId: id.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: { 200: z.object({ items: z.array(invoiceListItem), today: z.iso.date() }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const today = await organizationToday(db, organizationId, now());
      let q = applyView(invoiceBase(db, organizationId), req.query.view, today);
      if (req.query.customerId) q = q.where("i.customerId", "=", req.query.customerId);
      if (req.query.siteId) q = q.where("i.siteId", "=", req.query.siteId);
      const rows = await q.orderBy(overdueFirst).limit(req.query.limit).execute();
      return { items: rows.map((r) => toListItem(r, today)), today };
    },
  );

  app.post(
    "/invoices",
    {
      config: { permission: "invoices:write" },
      schema: { tags: ["invoices"], summary: "Start a draft invoice", body: invoiceInput, response: { 201: invoiceDetailSchema } },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const b = req.body;
      checkQuantities(b.lines);
      await checkDraftRefs(db, organizationId, b.customerId, b.siteId, b.lines);
      const org = await db.selectFrom("organizations").select(["invoiceTermsDays", "defaultTaxRateBps"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
      const invoiceId = await db.transaction().execute(async (trx) => {
        const at = now();
        const inv = await trx
          .insertInto("invoices")
          .values({
            organizationId,
            customerId: b.customerId,
            siteId: b.siteId ?? null,
            number: null,
            memo: b.memo ?? null,
            termsDays: b.termsDays ?? org.invoiceTermsDays,
            taxRateBps: b.taxRateBps ?? org.defaultTaxRateBps,
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
            createdBy: userId,
            updatedAt: at,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await writeDraftLines(trx, organizationId, inv.id, b.lines, { discountCents: b.discountCents ?? 0, taxRateBps: b.taxRateBps ?? org.defaultTaxRateBps }, at);
        await invoiceEvent(trx, { organizationId, invoiceId: inv.id, eventType: "created", summary: "Draft created", actorUserId: userId, at });
        await audit(trx, req, { action: "invoice.created", entityType: "invoice", entityId: inv.id, changes: { customerId: b.customerId, lines: b.lines.length } });
        return inv.id;
      });
      return reply.status(201).send(await detail(organizationId, invoiceId));
    },
  );

  app.post(
    "/contracts/:id/invoice",
    {
      config: { permission: "invoices:write" },
      schema: {
        tags: ["invoices"],
        summary: "Start a draft invoice for a contract's next unbilled installment",
        description: "The installments follow the contract's billing frequency. An installment already on an invoice that is not void is never billed again.",
        params,
        body: z.object({ installment: z.number().int().min(1).optional() }),
        response: { 201: invoiceDetailSchema },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const org = await db
        .selectFrom("organizations")
        .select(["invoiceTermsDays", "defaultTaxRateBps", "billFilingFees", "timezone"])
        .where("id", "=", organizationId)
        .executeTakeFirstOrThrow();
      const invoiceId = await db.transaction().execute(async (trx) => {
        const at = now();
        // Locking the contract makes two people billing it at once take turns.
        const c = await trx
          .selectFrom("contracts as k")
          .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "k.siteId").onRef("s.organizationId", "=", "k.organizationId"))
          .select(["k.id", "k.siteId", "k.status", "k.planName", "k.startOn", "k.endOn", "k.termMonths", "k.priceCents", "k.billingFrequency", "k.agreementSnapshot", "s.customerId", "s.addressLine1"])
          .where("k.organizationId", "=", organizationId)
          .where("k.id", "=", req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!c) throw notFound("Contract");
        if (c.status === "cancelled") throw unprocessable("This contract is cancelled");
        const billed = await trx
          .selectFrom("invoiceLines as l")
          .innerJoin("invoices as i", "i.id", "l.invoiceId")
          .select("l.installment")
          .where("l.organizationId", "=", organizationId)
          .where("l.contractId", "=", c.id)
          .where("i.status", "<>", "void")
          .execute();
        const taken = new Set(billed.map((b) => b.installment));
        const parts = contractInstallments(c);
        const part = req.body.installment ? parts.find((p) => p.installment === req.body.installment) : parts.find((p) => !taken.has(p.installment));
        if (!part) throw unprocessable(req.body.installment ? "The contract has no such installment" : "Every installment of this contract is already on an invoice");
        if (taken.has(part.installment)) throw unprocessable(`Installment ${part.installment} is already on an invoice`);

        const inv = await trx
          .insertInto("invoices")
          .values({
            organizationId,
            customerId: c.customerId,
            siteId: c.siteId,
            number: null,
            memo: null,
            termsDays: org.invoiceTermsDays,
            taxRateBps: org.defaultTaxRateBps,
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
            createdBy: userId,
            updatedAt: at,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        const which = part.count > 1 ? ` (payment ${part.installment} of ${part.count})` : "";
        await writeDraftLines(
          trx,
          organizationId,
          inv.id,
          [
            {
              description: `${c.planName}, ${c.addressLine1}: ${day(part.periodStart)} to ${day(part.periodEnd)}${which}`,
              quantity: 1,
              unitPriceCents: part.amountCents,
              taxable: false,
              contractId: c.id,
              installment: part.installment,
              periodStart: part.periodStart,
              periodEnd: part.periodEnd,
            },
            // Plan options the office took with the contract (SW-8), once, with the first payment.
            ...(part.installment === 1
              ? parseSnapshotOptions(c.agreementSnapshot).map((o) => ({
                  description: `${c.planName} option: ${o.name}`,
                  quantity: 1,
                  unitPriceCents: o.priceCents,
                  taxable: o.taxable,
                  contractId: c.id,
                  installment: part.installment,
                  periodStart: part.periodStart,
                  periodEnd: part.periodEnd,
                }))
              : []),
            ...(org.billFilingFees ? await filingFeeLines(trx, organizationId, c.siteId, org.timezone) : []),
          ],
          { discountCents: 0, taxRateBps: org.defaultTaxRateBps },
          at,
        );
        await invoiceEvent(trx, { organizationId, invoiceId: inv.id, eventType: "created", summary: `Draft created for the contract${which}`, actorUserId: userId, at });
        await audit(trx, req, { action: "invoice.created", entityType: "invoice", entityId: inv.id, changes: { contractId: c.id, installment: part.installment } });
        return inv.id;
      });
      return reply.status(201).send(await detail(organizationId, invoiceId));
    },
  );

  app.get(
    "/invoices/:id",
    {
      config: { permission: "invoices:read" },
      schema: { tags: ["invoices"], summary: "An invoice with its lines, payments, refunds and history", params, response: { 200: invoiceDetailSchema } },
    },
    async (req) => detail(req.requireAuth().organizationId, req.params.id),
  );

  app.patch(
    "/invoices/:id",
    {
      config: { permission: "invoices:write" },
      schema: { tags: ["invoices"], summary: "Change a draft", description: "Lines, when given, replace every line.", params, body: invoicePatch, response: { 200: invoiceDetailSchema } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const at = now();
        const inv = await lockDraft(trx, organizationId, req.params.id);
        const b = req.body;
        checkQuantities(
          b.lines,
          await trx.selectFrom("invoiceLines").select(["id", "quantityMilli"]).where("organizationId", "=", organizationId).where("invoiceId", "=", inv.id).execute(),
        );
        const siteId = b.siteId === undefined ? inv.siteId : b.siteId;
        if (b.siteId !== undefined || b.lines) await checkDraftRefs(trx, organizationId, inv.customerId, siteId, b.lines ?? []);
        await trx
          .updateTable("invoices")
          .set({ siteId, memo: b.memo === undefined ? inv.memo : b.memo, termsDays: b.termsDays ?? inv.termsDays, updatedAt: at })
          .where("id", "=", inv.id)
          .execute();
        const lines =
          b.lines ??
          (await trx.selectFrom("invoiceLines").selectAll().where("organizationId", "=", organizationId).where("invoiceId", "=", inv.id).orderBy("position").execute()).map((l) => ({
            ...l,
            quantity: shownQuantity(l),
          }));
        await writeDraftLines(trx, organizationId, inv.id, lines, { discountCents: b.discountCents ?? inv.discountCents, taxRateBps: b.taxRateBps ?? inv.taxRateBps }, at);
        await audit(trx, req, { action: "invoice.updated", entityType: "invoice", entityId: inv.id, changes: { ...b, lines: b.lines?.length } });
      });
      return detail(organizationId, req.params.id);
    },
  );

  app.post(
    "/invoices/:id/discard",
    {
      config: { permission: "invoices:write" },
      schema: { tags: ["invoices"], summary: "Delete a draft", params, body: z.object({}).optional(), response: { 204: z.null() } },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const wo = await lockInvoiceWorkOrder(trx, organizationId, req.params.id);
        const inv = await lockDraft(trx, organizationId, req.params.id);
        await trx.deleteFrom("invoices").where("id", "=", inv.id).execute();
        if (wo) await afterWorkOrderInvoiceEnded(trx, req, wo, { organizationId, summary: "Draft invoice discarded", at: now() });
        await audit(trx, req, { action: "invoice.discarded", entityType: "invoice", entityId: inv.id });
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    "/invoices/:id/issue",
    {
      config: { permission: "invoices:write" },
      schema: {
        tags: ["invoices"],
        summary: "Issue a draft: number it, freeze it, and email it to the customer",
        description: "After this the invoice cannot change; void it and issue a new one instead. The PDF and email are made by the worker.",
        params,
        body: invoiceIssueInput,
        response: { 200: invoiceDetailSchema },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const at = now();
        // The work order first, then its estimate's deposit, then the invoice.
        const wo = await lockInvoiceWorkOrder(trx, organizationId, req.params.id);
        const dep = wo ? await lockDepositForWorkOrder(trx, organizationId, wo.id) : null;
        if (req.body.depositCents !== undefined && !dep) throw unprocessable("This invoice has no deposit to apply");
        const issued = await issueDraft(trx, organizationId, req.params.id, {
          send: req.body.send,
          now: at,
          deposit: dep ? { lock: dep, requestedCents: req.body.depositCents, actorUserId: userId } : undefined,
        });
        // Billing the work spends the plan coverage it was priced under (SW-8).
        if (wo) await consumeCoverage(trx, req, organizationId, wo.id, req.params.id, at);
        await invoiceEvent(trx, {
          organizationId,
          invoiceId: req.params.id,
          eventType: "issued",
          summary: `Issued as ${issued.label}${req.body.send ? `; emailing to ${issued.billTo}` : ""}`,
          actorUserId: userId,
          at,
        });
        await audit(trx, req, { action: "invoice.issued", entityType: "invoice", entityId: req.params.id, changes: { number: issued.number, send: req.body.send } });
        await queueQuickBooksSync(trx, organizationId, at);
      });
      return detail(organizationId, req.params.id);
    },
  );

  app.post(
    "/invoices/:id/send",
    {
      config: { permission: "invoices:write" },
      schema: { tags: ["invoices"], summary: "Email an open invoice to the customer again", params, body: z.object({}).optional(), response: { 200: invoiceDetailSchema } },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const at = now();
        const inv = await trx
          .selectFrom("invoices")
          .select(["id", "status", "customerId", "sendCount"])
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!inv) throw notFound("Invoice");
        if (inv.status !== "open") throw unprocessable(inv.status === "draft" ? "Issue the invoice first" : "A void invoice cannot be sent");
        const to = await billingEmail(trx, organizationId, inv.customerId);
        if (!to) throw unprocessable("The customer has no email address on file. Add a billing contact with an email.");
        const sendNo = inv.sendCount + 1;
        await trx.updateTable("invoices").set({ sendCount: sendNo, updatedAt: at }).where("id", "=", inv.id).execute();
        await queueSend(trx, organizationId, inv.id, sendNo, at);
        await invoiceEvent(trx, { organizationId, invoiceId: inv.id, eventType: "send_requested", summary: `Emailing again to ${to}`, actorUserId: userId, at });
        await audit(trx, req, { action: "invoice.sent", entityType: "invoice", entityId: inv.id, changes: { sendNo } });
      });
      return detail(organizationId, req.params.id);
    },
  );

  app.post(
    "/invoices/:id/void",
    {
      config: { permission: "invoices:write" },
      schema: {
        tags: ["invoices"],
        summary: "Void an issued invoice",
        description: "Only an invoice with nothing paid or clearing; refund payments first. The pay link stops working.",
        params,
        body: invoiceVoidInput,
        response: { 200: invoiceDetailSchema },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const openSessions = await db.transaction().execute(async (trx) => {
        const at = now();
        // The work order it was made from first, then the invoice, as every change to the pair.
        const wo = await lockInvoiceWorkOrder(trx, organizationId, req.params.id);
        const dep = wo ? await lockDepositForWorkOrder(trx, organizationId, wo.id) : null;
        const inv = await trx
          .selectFrom("invoices")
          .select(["id", "number", "status", "paidCents", "pendingCents"])
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!inv) throw notFound("Invoice");
        if (inv.status !== "open") throw unprocessable(inv.status === "draft" ? "Discard a draft instead of voiding it" : "This invoice is already void");
        if (inv.paidCents > 0 || inv.pendingCents > 0) throw unprocessable("This invoice has payments. Refund them before voiding it.");
        // A deposit invoice with nothing paid: the estimate no longer asks for it.
        await trx.updateTable("estimateInvoices").set({ voidedAt: at }).where("organizationId", "=", organizationId).where("invoiceId", "=", inv.id).where("role", "=", "deposit").where("voidedAt", "is", null).execute();
        // A final invoice gives back the deposit money applied to it (I5).
        if (dep) await unapplyAtVoid(trx, organizationId, dep, inv.id, { actorUserId: userId, at });
        await trx.updateTable("invoices").set({ status: "void", voidedAt: at, voidReason: req.body.reason, updatedAt: at }).where("id", "=", inv.id).execute();
        await recalcInvoice(trx, organizationId, inv.id, at);
        await invoiceEvent(trx, { organizationId, invoiceId: inv.id, eventType: "voided", summary: `Voided: ${req.body.reason}`, actorUserId: userId, at });
        if (wo) await afterWorkOrderInvoiceEnded(trx, req, wo, { organizationId, summary: `Invoice ${invoiceNumberLabel(inv.number)} voided: ${req.body.reason}`, at });
        if (wo) await afterCoveredInvoiceVoided(trx, req, organizationId, wo, inv.id, at);
        await audit(trx, req, { action: "invoice.voided", entityType: "invoice", entityId: inv.id, changes: { reason: req.body.reason } });
        await queueQuickBooksSync(trx, organizationId, at);
        return trx
          .updateTable("checkoutSessions")
          .set({ status: "expired" })
          .where("organizationId", "=", organizationId)
          .where("invoiceId", "=", inv.id)
          .where("status", "=", "open")
          .returning("providerSessionId")
          .execute();
      });
      // Close any payable page the customer still has open. If this fails, a payment that
      // still comes in shows as money to refund on a void invoice.
      const org = await db.selectFrom("organizations").select("stripeAccountId").where("id", "=", organizationId).executeTakeFirstOrThrow();
      if (payments.provider && org.stripeAccountId) {
        for (const s of openSessions) {
          await payments.provider.expireCheckout({ organizationId, accountId: org.stripeAccountId, sessionId: s.providerSessionId }).catch((err: Error) => req.log.warn({ err }, "could not expire checkout"));
        }
      }
      return detail(organizationId, req.params.id);
    },
  );

  app.get(
    "/invoices/:id/pdf",
    {
      config: { permission: "invoices:read" },
      schema: { tags: ["invoices"], summary: "The issued invoice as a PDF", params },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const inv = await db.selectFrom("invoices").select(["number", "pdfStorageKey"]).where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
      if (!inv) throw notFound("Invoice");
      const data = inv.pdfStorageKey ? await readForDownload(db, store, inv.pdfStorageKey) : null;
      if (!data) throw new HttpError(404, "not_ready", "The PDF is still being prepared");
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `inline; filename="${invoiceNumberLabel(inv.number)}.pdf"`)
        .send(data);
    },
  );

  app.post(
    "/invoices/:id/payments",
    {
      config: { permission: "invoices:write" },
      schema: {
        tags: ["invoices"],
        summary: "Record a check, cash or other payment received in person",
        description: "Up to what is still due. Card and bank payments arrive from Stripe on their own.",
        params,
        body: manualPaymentInput,
        response: { 200: invoiceDetailSchema },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const at = now();
        const inv = await trx
          .selectFrom("invoices")
          .select(["id", "status", "totalCents", "paidCents", "pendingCents", "creditedCents"])
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!inv) throw notFound("Invoice");
        if (inv.status !== "open") throw unprocessable(inv.status === "draft" ? "Issue the invoice before recording payments" : "This invoice is void");
        const due = amountDue(inv);
        if (req.body.amountCents > due) throw unprocessable(`That is more than the ${dollars(due)} still due`);
        const p = await trx
          .insertInto("payments")
          .values({
            organizationId,
            invoiceId: inv.id,
            amountCents: req.body.amountCents,
            method: req.body.method,
            source: "manual",
            status: "succeeded",
            providerPaymentId: null,
            providerSessionId: null,
            receivedOn: req.body.receivedOn,
            reference: req.body.reference ?? null,
            note: req.body.note ?? null,
            failureReason: null,
            recordedBy: userId,
            succeededAt: at,
            failedAt: null,
            createdAt: at,
            updatedAt: at,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await recalcInvoice(trx, organizationId, inv.id, at);
        const what = `${dollars(req.body.amountCents)} by ${PAYMENT_METHOD_LABELS[req.body.method].toLowerCase()}${req.body.reference ? ` (${req.body.reference})` : ""}`;
        await invoiceEvent(trx, { organizationId, invoiceId: inv.id, eventType: "payment_succeeded", summary: `Payment recorded: ${what}`, actorUserId: userId, paymentId: p.id, at });
        await paymentOnTimeline(trx, { organizationId, invoiceId: inv.id, amountCents: req.body.amountCents, method: req.body.method, actorUserId: userId, at });
        await audit(trx, req, { action: "payment.recorded", entityType: "invoice", entityId: inv.id, changes: { paymentId: p.id, ...req.body } });
        await queueQuickBooksSync(trx, organizationId, at);
      });
      // A renewal waiting on this payment becomes the next contract.
      await activatePaidRenewals(db, { organizationId, invoiceId: req.params.id }, now());
      return detail(organizationId, req.params.id);
    },
  );

  app.post(
    "/payments/:id/refund",
    {
      config: { permission: "billing:manage" },
      schema: {
        tags: ["invoices"],
        summary: "Refund all or part of a payment",
        description: "Card and bank payments are refunded through Stripe. Check and cash refunds are recorded here after the money has been handed back.",
        params,
        body: refundInput,
        response: { 200: invoiceDetailSchema },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const invoiceId = await db.transaction().execute(async (trx) => {
        const at = now();
        const p = await trx.selectFrom("payments").selectAll().where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
        if (!p) throw notFound("Payment");
        // Lock the invoice, as every payment change does, so refunds cannot race each other.
        await trx.selectFrom("invoices").select("id").where("id", "=", p.invoiceId).forUpdate().executeTakeFirstOrThrow();
        if (p.status !== "succeeded") throw unprocessable("Only a payment that has cleared can be refunded");
        // Deposit money is refunded through its own ledger, which reserves it first.
        if (await depositLink(trx, organizationId, p.invoiceId)) throw new HttpError(409, "deposit_payment", "This is a deposit payment. Refund it from the estimate's deposit.");
        const prior = await trx
          .selectFrom("refunds")
          .select([sql<number>`count(*)::int`.as("n"), sql<number>`coalesce(sum(amount_cents) filter (where status <> 'failed'), 0)::int`.as("committed")])
          .where("paymentId", "=", p.id)
          .executeTakeFirstOrThrow();
        const refundable = p.amountCents - prior.committed;
        if (req.body.amountCents > refundable) throw unprocessable(`At most ${dollars(refundable)} of this payment can be refunded`);

        let refund: { providerRefundId: string | null; status: "pending" | "succeeded" | "failed"; failureReason: string | null };
        if (p.source === "stripe") {
          const org = await trx.selectFrom("organizations").select("stripeAccountId").where("id", "=", organizationId).executeTakeFirstOrThrow();
          if (!payments.provider || !org.stripeAccountId) throw unprocessable("Online payments are not set up, so this payment cannot be refunded from here");
          const r = await payments.provider.createRefund({
            organizationId,
            accountId: org.stripeAccountId,
            // The same refund request always gets the same key, so a retry cannot refund twice.
            idempotencyKey: `refund-${p.id}-${prior.n + 1}`,
            paymentIntentId: p.providerPaymentId!,
            amountCents: req.body.amountCents,
            metadata: { organizationId, invoiceId: p.invoiceId, paymentId: p.id },
          });
          refund = { providerRefundId: r.refundId, status: r.status, failureReason: r.failureReason };
        } else {
          refund = { providerRefundId: null, status: "succeeded", failureReason: null };
        }
        const values = {
          organizationId,
          paymentId: p.id,
          amountCents: req.body.amountCents,
          status: refund.status,
          intent: req.body.intent,
          providerRefundId: refund.providerRefundId,
          reason: req.body.reason,
          failureReason: refund.failureReason,
          createdBy: userId,
          createdAt: at,
          updatedAt: at,
        };
        // Stripe's webhook for this refund may have arrived first; then keep its status and add who and why.
        await trx
          .insertInto("refunds")
          .values(values)
          .onConflict((oc) => oc.column("providerRefundId").doUpdateSet({ reason: req.body.reason, intent: req.body.intent, createdBy: userId }))
          .execute();
        await recalcInvoice(trx, organizationId, p.invoiceId, at);
        const how = req.body.intent === "reverse" ? " to reverse the payment (owed again)" : "";
        const summary =
          refund.status === "succeeded"
            ? `Refunded ${dollars(req.body.amountCents)}${how}: ${req.body.reason}`
            : refund.status === "pending"
              ? `Refund of ${dollars(req.body.amountCents)}${how} started: ${req.body.reason}`
              : `Refund of ${dollars(req.body.amountCents)} failed: ${refund.failureReason ?? "declined"}`;
        await invoiceEvent(trx, { organizationId, invoiceId: p.invoiceId, eventType: `refund_${refund.status}`, summary, actorUserId: userId, paymentId: p.id, at });
        await audit(trx, req, { action: "payment.refunded", entityType: "invoice", entityId: p.invoiceId, changes: { paymentId: p.id, ...req.body, status: refund.status } });
        // A refund lowers the payment QuickBooks has.
        if (refund.status === "succeeded") await queueQuickBooksSync(trx, organizationId, at);
        return p.invoiceId;
      });
      return detail(organizationId, invoiceId);
    },
  );
};
