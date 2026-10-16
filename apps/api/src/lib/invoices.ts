import type { Database, DB } from "@aerowise/db";
import {
  addDays,
  amountDue,
  contractInstallments,
  estimateLabel,
  invoiceNumberLabel,
  invoiceTotals,
  milliAmount,
  type InvoiceDetail,
  type InvoiceLineInput,
  type InvoiceListItem,
  type InvoiceSnapshot,
  INVOICE_LIMIT_MESSAGE,
  MAX_CENTS,
  parseSnapshotOptions,
} from "@aerowise/domain";
import { recalcInvoice, type PaymentProvider } from "@aerowise/payments";
import { billingEmail, currentInvoicePdf, enqueue, payUrlFor, RENDER_INVOICE, SEND_INVOICE } from "@aerowise/tasks";
import type { ObjectStore } from "@aerowise/storage";
import { sql, type Transaction } from "kysely";
import { applyDepositAtIssue, type LockedDeposit } from "./deposits.ts";
import { readForDownload, stampForDownload } from "./demo.ts";
import { notFound, unprocessable } from "./errors.ts";
import { dateInZone } from "./today.ts";

export interface PaymentsConfig {
  /** null when online payments are off (production without Stripe keys). */
  provider: PaymentProvider | null;
  /** The web app's public address, for pay links and Stripe's return pages. */
  appUrl: string;
}

const joinAddress = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ") || null;
const cityLine = (city: string | null, state: string | null, postal: string | null) => [city, [state, postal].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null;

/** Checks that the site and jobs on a draft belong to its customer; another org's ids are "not found". */
export async function checkDraftRefs(db: Database | Transaction<DB>, organizationId: string, customerId: string, siteId: string | null | undefined, lines: InvoiceLineInput[]) {
  const customer = await db.selectFrom("customers").select("id").where("organizationId", "=", organizationId).where("id", "=", customerId).executeTakeFirst();
  if (!customer) throw notFound("Customer");
  if (siteId) {
    const site = await db.selectFrom("sites").select("customerId").where("organizationId", "=", organizationId).where("id", "=", siteId).executeTakeFirst();
    if (!site) throw notFound("Site");
    if (site.customerId !== customerId) throw unprocessable("The site belongs to a different customer");
  }
  const jobIds = [...new Set(lines.map((l) => l.jobId).filter((j): j is string => !!j))];
  if (jobIds.length) {
    const jobs = await db
      .selectFrom("jobs as j")
      .innerJoin("sites as s", (k) => k.onRef("s.id", "=", "j.siteId").onRef("s.organizationId", "=", "j.organizationId"))
      .select(["j.id", "s.customerId"])
      .where("j.organizationId", "=", organizationId)
      // Inspection and work visits can both be billed.
      .where("j.type", "in", ["inspection", "work"])
      .where("j.id", "in", jobIds)
      .execute();
    if (jobs.length !== jobIds.length) throw notFound("Job");
    if (jobs.some((j) => j.customerId !== customerId)) throw unprocessable("A job on this invoice is for a different customer");
  }
  const itemIds = [...new Set(lines.map((l) => l.serviceItemId).filter((s): s is string => !!s))];
  if (itemIds.length) {
    const items = await db.selectFrom("serviceItems").select("id").where("organizationId", "=", organizationId).where("id", "in", itemIds).execute();
    if (items.length !== itemIds.length) throw notFound("Service item");
  }
}

/** True when a quantity is not a whole number, which only service items allow. */
export const isFractional = (quantity: number | undefined) => quantity !== undefined && !Number.isInteger(quantity);

/**
 * How a quantity is stored. A whole number keeps the original columns alone, so its amount,
 * PDF and QuickBooks payload are what they always were. A fraction is kept in thousandths and
 * prices the line; the integer column then holds it rounded up, for its range check only.
 */
export function storedQuantity(quantity: number, unitPriceCents: number) {
  if (Number.isInteger(quantity)) return { quantity, quantityMilli: null, amountCents: quantity * unitPriceCents };
  const quantityMilli = Math.round(quantity * 1000);
  return { quantity: Math.max(1, Math.ceil(quantityMilli / 1000)), quantityMilli, amountCents: milliAmount(quantityMilli, unitPriceCents) };
}

/** The quantity a stored line shows: its thousandths when it has them. */
export const shownQuantity = (l: { quantity: number; quantityMilli: number | null }) => (l.quantityMilli === null ? l.quantity : l.quantityMilli / 1000);

type NewLine = InvoiceLineInput & { contractId?: string | null; installment?: number | null; periodStart?: string | null; periodEnd?: string | null; filingId?: string | null };

/** Replaces a draft's lines and recomputes its totals. */
export async function writeDraftLines(
  trx: Transaction<DB>,
  organizationId: string,
  invoiceId: string,
  lines: NewLine[],
  pricing: { discountCents: number; taxRateBps: number },
  now: Date,
) {
  // A line sent back with its id keeps what it bills for; nothing else can claim an installment or a filing fee.
  const previous = await trx
    .selectFrom("invoiceLines")
    .select(["id", "contractId", "installment", "periodStart", "periodEnd", "filingId"])
    .where("organizationId", "=", organizationId)
    .where("invoiceId", "=", invoiceId)
    .execute();
  const kept = new Map(previous.map((p) => [p.id, p]));
  await trx.deleteFrom("invoiceLines").where("organizationId", "=", organizationId).where("invoiceId", "=", invoiceId).execute();
  const rows = lines.map((l, i) => {
    const prior = l.id ? kept.get(l.id) : undefined;
    return {
      organizationId,
      invoiceId,
      position: i + 1,
      description: l.description,
      ...storedQuantity(l.quantity ?? 1, l.unitPriceCents),
      unitPriceCents: l.unitPriceCents,
      taxable: l.taxable ?? false,
      jobId: l.jobId ?? null,
      serviceItemId: l.serviceItemId ?? null,
      contractId: prior?.contractId ?? l.contractId ?? null,
      installment: prior?.installment ?? l.installment ?? null,
      periodStart: prior?.periodStart ?? l.periodStart ?? null,
      periodEnd: prior?.periodEnd ?? l.periodEnd ?? null,
      filingId: prior?.filingId ?? l.filingId ?? null,
    };
  });
  await trx.insertInto("invoiceLines").values(rows).execute();
  const totals = invoiceTotals(rows, pricing.discountCents, pricing.taxRateBps);
  if (totals.subtotalCents > MAX_CENTS || totals.totalCents > MAX_CENTS) throw unprocessable(INVOICE_LIMIT_MESSAGE);
  await trx
    .updateTable("invoices")
    .set({ ...totals, discountCents: totals.discountCents, taxRateBps: pricing.taxRateBps, updatedAt: now })
    .where("organizationId", "=", organizationId)
    .where("id", "=", invoiceId)
    .execute();
  return totals;
}

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

/**
 * A draft for a contract's next unbilled installment (or the one asked for), in the caller's
 * transaction: the installment, the plan options taken with the first payment (SW-8), and the
 * filing fees passed on to the homeowner. An installment already on an invoice that is not
 * void is never billed again. Locking the contract makes two people billing it take turns.
 */
export async function draftContractInstallment(
  trx: Transaction<DB>,
  organizationId: string,
  contractId: string,
  opts: { installment?: number; createdBy: string | null; memo?: string | null; now: Date },
) {
  const org = await trx.selectFrom("organizations").select(["invoiceTermsDays", "defaultTaxRateBps", "billFilingFees", "timezone"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
  const c = await trx
    .selectFrom("contracts as k")
    .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "k.siteId").onRef("s.organizationId", "=", "k.organizationId"))
    .select(["k.id", "k.siteId", "k.status", "k.planName", "k.startOn", "k.endOn", "k.termMonths", "k.priceCents", "k.billingFrequency", "k.agreementSnapshot", "s.customerId", "s.addressLine1"])
    .where("k.organizationId", "=", organizationId)
    .where("k.id", "=", contractId)
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
  const part = opts.installment ? parts.find((p) => p.installment === opts.installment) : parts.find((p) => !taken.has(p.installment));
  if (!part) throw unprocessable(opts.installment ? "The contract has no such installment" : "Every installment of this contract is already on an invoice");
  if (taken.has(part.installment)) throw unprocessable(`Installment ${part.installment} is already on an invoice`);

  const inv = await trx
    .insertInto("invoices")
    .values({
      organizationId,
      customerId: c.customerId,
      siteId: c.siteId,
      number: null,
      memo: opts.memo ?? null,
      termsDays: org.invoiceTermsDays,
      taxRateBps: org.defaultTaxRateBps,
      discountCents: 0,
      subtotalCents: 0,
      taxableCents: 0,
      taxCents: 0,
      totalCents: 0,
      issuedOn: null,
      dueOn: null,
      pdfStorageKey: null,
      pdfSha256: null,
      pdfByteSize: null,
      sentAt: null,
      paidAt: null,
      voidedAt: null,
      voidReason: null,
      createdBy: opts.createdBy,
      updatedAt: opts.now,
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
    opts.now,
  );
  return { invoiceId: inv.id, installment: part.installment, count: part.count };
}

/**
 * Issues a draft: gives it the next number, fixes its dates, freezes what it says into a
 * snapshot, makes its pay link and queues its PDF (and the email, when sending). One
 * transaction, so a failure leaves the draft as it was.
 */
export async function issueDraft(
  trx: Transaction<DB>,
  organizationId: string,
  invoiceId: string,
  opts: { send: boolean; now: Date; deposit?: { lock: LockedDeposit; requestedCents?: number; actorUserId: string | null } },
) {
  let inv = await trx.selectFrom("invoices").selectAll().where("organizationId", "=", organizationId).where("id", "=", invoiceId).forUpdate().executeTakeFirst();
  if (!inv) throw notFound("Invoice");
  if (inv.status !== "draft") throw unprocessable("This invoice has already been issued");
  // The final invoice for an estimate with a deposit: its free money comes off the total.
  if (opts.deposit) {
    await applyDepositAtIssue(trx, organizationId, opts.deposit.lock, inv, { requestedCents: opts.deposit.requestedCents, actorUserId: opts.deposit.actorUserId, at: opts.now });
    inv = await trx.selectFrom("invoices").selectAll().where("id", "=", invoiceId).executeTakeFirstOrThrow();
  }
  const billTo = await billingEmail(trx, organizationId, inv.customerId);
  if (opts.send && !billTo) throw unprocessable("The customer has no email address on file. Add a billing contact with an email, or issue without sending.");

  const org = await trx
    .updateTable("organizations")
    .set((eb) => ({ nextInvoiceNumber: eb("nextInvoiceNumber", "+", 1) }))
    .where("id", "=", organizationId)
    .returning(["nextInvoiceNumber", "name", "phone", "email", "addressLine1", "city", "state", "postalCode", "timezone"])
    .executeTakeFirstOrThrow();
  const number = org.nextInvoiceNumber - 1;
  const issuedOn = dateInZone(opts.now, org.timezone);
  const dueOn = addDays(issuedOn, inv.termsDays);

  const customer = await trx
    .selectFrom("customers")
    .select(["displayName", "billingLine1", "billingLine2", "billingCity", "billingState", "billingPostalCode"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", inv.customerId)
    .executeTakeFirstOrThrow();
  const site = inv.siteId
    ? await trx.selectFrom("sites").select(["addressLine1", "addressLine2", "city", "state", "postalCode"]).where("organizationId", "=", organizationId).where("id", "=", inv.siteId).executeTakeFirst()
    : undefined;
  const lines = (
    await trx
      .selectFrom("invoiceLines")
      .select(["description", "quantity", "quantityMilli", "unitPriceCents", "amountCents", "taxable"])
      .where("organizationId", "=", organizationId)
      .where("invoiceId", "=", invoiceId)
      .orderBy("position")
      .execute()
  ).map(({ quantityMilli, ...l }) => ({ ...l, quantity: shownQuantity({ quantity: l.quantity, quantityMilli }) }));
  const serviceAddress = site ? joinAddress([site.addressLine1, site.addressLine2, cityLine(site.city, site.state, site.postalCode)]) : null;
  const snapshot: InvoiceSnapshot = {
    number: invoiceNumberLabel(number),
    issuedOn,
    dueOn,
    timezone: org.timezone,
    provider: { name: org.name, address: joinAddress([org.addressLine1, cityLine(org.city, org.state, org.postalCode)]), phone: org.phone, email: org.email },
    billTo: {
      name: customer.displayName,
      // Customers without a billing address are billed at the service address.
      address: joinAddress([customer.billingLine1, customer.billingLine2, cityLine(customer.billingCity, customer.billingState, customer.billingPostalCode)]) ?? serviceAddress,
      email: billTo,
    },
    serviceAddress,
    memo: inv.memo,
    lines,
    subtotalCents: inv.subtotalCents,
    discountCents: inv.discountCents,
    taxRateBps: inv.taxRateBps,
    taxCents: inv.taxCents,
    ...(inv.depositAppliedCents > 0 ? { depositAppliedCents: inv.depositAppliedCents } : {}),
    totalCents: inv.totalCents,
  };

  await trx
    .updateTable("invoices")
    .set({
      status: "open",
      number,
      issuedOn,
      dueOn,
      snapshot: JSON.stringify(snapshot),
      sendCount: opts.send ? 1 : 0,
      updatedAt: opts.now,
    })
    .where("id", "=", invoiceId)
    .execute();
  // A $0 invoice is paid the moment it is issued.
  await recalcInvoice(trx, organizationId, invoiceId, opts.now);
  await enqueue(trx, { kind: RENDER_INVOICE, organizationId, payload: { invoiceId }, dedupeKey: `invoice-render-${invoiceId}`, runAt: opts.now });
  if (opts.send) await queueSend(trx, organizationId, invoiceId, 1, opts.now);
  return { number, label: snapshot.number, billTo };
}

/**
 * The invoice PDF handed out for download: the copy made at issue, or once money has come in,
 * one drawn to show it (`currentInvoicePdf`), so a paid invoice never reads as owed. Null
 * while the issued copy is still being made.
 */
export async function invoicePdfForDownload(db: Database, store: ObjectStore, payments: PaymentsConfig, organizationId: string, invoiceId: string) {
  const current = await currentInvoicePdf({ db, store, appUrl: payments.appUrl, payments: payments.provider }, organizationId, invoiceId);
  if (!current) return null;
  return "drawn" in current ? stampForDownload(db, organizationId, current.drawn) : readForDownload(db, store, current.stored);
}

export async function queueSend(trx: Transaction<DB>, organizationId: string, invoiceId: string, sendNo: number, now: Date) {
  await enqueue(trx, { kind: SEND_INVOICE, organizationId, payload: { invoiceId, sendNo }, dedupeKey: `invoice-send-${invoiceId}-${sendNo}`, runAt: now });
}

/** The columns every invoice view starts from, with customer and site. */
export function invoiceBase(db: Database, organizationId: string) {
  return db
    .selectFrom("invoices as i")
    .innerJoin("customers as c", (j) => j.onRef("c.id", "=", "i.customerId").onRef("c.organizationId", "=", "i.organizationId"))
    .leftJoin("sites as s", (j) => j.onRef("s.id", "=", "i.siteId").onRef("s.organizationId", "=", "i.organizationId"))
    .select([
      "i.id",
      "i.number",
      "i.status",
      "i.paymentStatus",
      "i.issuedOn",
      "i.dueOn",
      "i.totalCents",
      "i.paidCents",
      "i.pendingCents",
      "i.creditedCents",
      "i.sentAt",
      "i.createdAt",
      "c.id as customerId",
      "c.displayName",
      "s.id as siteId",
      "s.addressLine1",
      "s.city",
    ])
    .where("i.organizationId", "=", organizationId);
}

type BaseRow = Awaited<ReturnType<ReturnType<typeof invoiceBase>["execute"]>>[number];

/** Unpaid (or partly paid) and past its due date. */
export const isOverdue = (r: { status: string; paymentStatus: string; dueOn: string | null }, today: string) =>
  r.status === "open" && (r.paymentStatus === "unpaid" || r.paymentStatus === "partial") && !!r.dueOn && r.dueOn < today;

export function toListItem(r: BaseRow, today: string): InvoiceListItem {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    paymentStatus: r.paymentStatus,
    issuedOn: r.issuedOn,
    dueOn: r.dueOn,
    overdue: isOverdue(r, today),
    totalCents: r.totalCents,
    paidCents: r.paidCents,
    pendingCents: r.pendingCents,
    creditedCents: r.creditedCents,
    amountDueCents: r.status === "open" ? amountDue(r) : 0,
    sentAt: r.sentAt?.toISOString() ?? null,
    customer: { id: r.customerId, displayName: r.displayName },
    site: r.siteId && r.addressLine1 && r.city ? { id: r.siteId, addressLine1: r.addressLine1, city: r.city } : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function invoiceDetail(db: Database, organizationId: string, invoiceId: string, today: string, appUrl: string): Promise<InvoiceDetail> {
  const row = await invoiceBase(db, organizationId)
    .select([
      "i.memo",
      "i.termsDays",
      "i.taxRateBps",
      "i.subtotalCents",
      "i.discountCents",
      "i.taxableCents",
      "i.depositAppliedCents",
      "i.taxCents",
      "i.voidedAt",
      "i.voidReason",
      "i.pdfStorageKey",
      "i.snapshot",
      "i.customerId as cid",
    ])
    .where("i.id", "=", invoiceId)
    .executeTakeFirst();
  if (!row) throw notFound("Invoice");
  const [lines, payments, refunds, events, estimate] = await Promise.all([
    db.selectFrom("invoiceLines").selectAll().where("organizationId", "=", organizationId).where("invoiceId", "=", invoiceId).orderBy("position").execute(),
    db.selectFrom("payments").selectAll().where("organizationId", "=", organizationId).where("invoiceId", "=", invoiceId).orderBy("createdAt").execute(),
    db
      .selectFrom("refunds as r")
      .innerJoin("payments as p", "p.id", "r.paymentId")
      .select(["r.id", "r.paymentId", "r.amountCents", "r.status", "r.intent", "r.reason", "r.createdAt"])
      .where("p.organizationId", "=", organizationId)
      .where("p.invoiceId", "=", invoiceId)
      .orderBy("r.createdAt")
      .execute(),
    db
      .selectFrom("invoiceEvents as e")
      .leftJoin("users as u", "u.id", "e.actorUserId")
      .select(["e.id", "e.eventType", "e.summary", "e.occurredAt", "u.name as actorName"])
      .where("e.organizationId", "=", organizationId)
      .where("e.invoiceId", "=", invoiceId)
      .orderBy("e.seq")
      .execute(),
    db
      .selectFrom("estimateInvoices as ei")
      .innerJoin("estimates as est", (j) => j.onRef("est.id", "=", "ei.estimateId").onRef("est.organizationId", "=", "ei.organizationId"))
      .select(["est.id", "est.number", "ei.role"])
      .where("ei.organizationId", "=", organizationId)
      .where("ei.invoiceId", "=", invoiceId)
      .executeTakeFirst(),
  ]);
  const snapshot = row.snapshot as InvoiceSnapshot | null;
  return {
    ...toListItem(row, today),
    memo: row.memo,
    termsDays: row.termsDays,
    taxRateBps: row.taxRateBps,
    subtotalCents: row.subtotalCents,
    discountCents: row.discountCents,
    taxableCents: row.taxableCents,
    depositAppliedCents: row.depositAppliedCents,
    estimate: estimate ? { id: estimate.id, label: estimateLabel(estimate.number), role: estimate.role } : null,
    taxCents: row.taxCents,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    billToEmail: snapshot?.billTo.email ?? (row.status === "draft" ? await billingEmail(db, organizationId, row.cid) : null),
    payUrl: row.status === "open" ? payUrlFor(appUrl, invoiceId) : null,
    pdfReady: !!row.pdfStorageKey,
    lines: lines.map((l) => ({
      id: l.id,
      position: l.position,
      description: l.description,
      quantity: shownQuantity(l),
      quantityMilli: l.quantityMilli,
      unitPriceCents: l.unitPriceCents,
      amountCents: l.amountCents,
      taxable: l.taxable,
      jobId: l.jobId,
      serviceItemId: l.serviceItemId,
      contractId: l.contractId,
      installment: l.installment,
      periodStart: l.periodStart,
      periodEnd: l.periodEnd,
      filingId: l.filingId,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      refundedCents: p.refundedCents,
      method: p.method,
      source: p.source,
      status: p.status,
      receivedOn: p.receivedOn,
      reference: p.reference,
      note: p.note,
      failureReason: p.failureReason,
      awaitingBankVerification: p.status === "pending" && p.bankVerificationUrl !== null,
      createdAt: p.createdAt.toISOString(),
      refunds: refunds
        .filter((r) => r.paymentId === p.id)
        .map((r) => ({ id: r.id, amountCents: r.amountCents, status: r.status, intent: r.intent, reason: r.reason, createdAt: r.createdAt.toISOString() })),
    })),
    events: events.map((e) => ({ id: e.id, eventType: e.eventType, summary: e.summary, occurredAt: e.occurredAt.toISOString(), actorName: e.actorName })),
  };
}

/** Narrows an invoice query to one of the list views. */
type BaseQuery = ReturnType<typeof invoiceBase>;
export function applyView(q: BaseQuery, view: string, today: string): BaseQuery {
  switch (view) {
    case "unpaid":
      return q.where("i.status", "=", "open").where("i.paymentStatus", "in", ["unpaid", "processing", "partial"]);
    case "overdue":
      return q.where("i.status", "=", "open").where("i.paymentStatus", "in", ["unpaid", "partial"]).where("i.dueOn", "<", today);
    case "draft":
      return q.where("i.status", "=", "draft");
    case "paid":
      return q.where("i.status", "=", "open").where("i.paymentStatus", "in", ["paid", "overpaid", "refunded"]);
    case "void":
      return q.where("i.status", "=", "void");
    default:
      return q;
  }
}

export const overdueFirst = sql`case when i.status = 'draft' then 0 else 1 end, i.due_on nulls first, i.created_at desc`;
