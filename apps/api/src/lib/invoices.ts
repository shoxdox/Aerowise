import { randomBytes } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import {
  addDays,
  amountDue,
  invoiceNumberLabel,
  invoiceTotals,
  type InvoiceDetail,
  type InvoiceLineInput,
  type InvoiceListItem,
  type InvoiceSnapshot,
} from "@aerowise/domain";
import { recalcInvoice, type PaymentProvider } from "@aerowise/payments";
import { billingEmail, enqueue, payUrlFor, RENDER_INVOICE, SEND_INVOICE } from "@aerowise/tasks";
import { sql, type Transaction } from "kysely";
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
      .where("j.id", "in", jobIds)
      .execute();
    if (jobs.length !== jobIds.length) throw notFound("Job");
    if (jobs.some((j) => j.customerId !== customerId)) throw unprocessable("A job on this invoice is for a different customer");
  }
}

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
      quantity: l.quantity ?? 1,
      unitPriceCents: l.unitPriceCents,
      amountCents: (l.quantity ?? 1) * l.unitPriceCents,
      taxable: l.taxable ?? false,
      jobId: l.jobId ?? null,
      contractId: prior?.contractId ?? l.contractId ?? null,
      installment: prior?.installment ?? l.installment ?? null,
      periodStart: prior?.periodStart ?? l.periodStart ?? null,
      periodEnd: prior?.periodEnd ?? l.periodEnd ?? null,
      filingId: prior?.filingId ?? l.filingId ?? null,
    };
  });
  await trx.insertInto("invoiceLines").values(rows).execute();
  const totals = invoiceTotals(rows, pricing.discountCents, pricing.taxRateBps);
  await trx
    .updateTable("invoices")
    .set({ ...totals, discountCents: totals.discountCents, taxRateBps: pricing.taxRateBps, updatedAt: now })
    .where("organizationId", "=", organizationId)
    .where("id", "=", invoiceId)
    .execute();
  return totals;
}

/**
 * Issues a draft: gives it the next number, fixes its dates, freezes what it says into a
 * snapshot, makes its pay link and queues its PDF (and the email, when sending). One
 * transaction, so a failure leaves the draft as it was.
 */
export async function issueDraft(trx: Transaction<DB>, organizationId: string, invoiceId: string, opts: { send: boolean; now: Date }) {
  const inv = await trx.selectFrom("invoices").selectAll().where("organizationId", "=", organizationId).where("id", "=", invoiceId).forUpdate().executeTakeFirst();
  if (!inv) throw notFound("Invoice");
  if (inv.status !== "draft") throw unprocessable("This invoice has already been issued");
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
  const lines = await trx
    .selectFrom("invoiceLines")
    .select(["description", "quantity", "unitPriceCents", "amountCents", "taxable"])
    .where("organizationId", "=", organizationId)
    .where("invoiceId", "=", invoiceId)
    .orderBy("position")
    .execute();
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
    totalCents: inv.totalCents,
  };

  await trx
    .updateTable("invoices")
    .set({
      status: "open",
      number,
      issuedOn,
      dueOn,
      publicToken: randomBytes(24).toString("base64url"),
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
      "i.taxCents",
      "i.voidedAt",
      "i.voidReason",
      "i.publicToken",
      "i.pdfStorageKey",
      "i.snapshot",
      "i.customerId as cid",
    ])
    .where("i.id", "=", invoiceId)
    .executeTakeFirst();
  if (!row) throw notFound("Invoice");
  const [lines, payments, refunds, events] = await Promise.all([
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
    taxCents: row.taxCents,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    billToEmail: snapshot?.billTo.email ?? (row.status === "draft" ? await billingEmail(db, organizationId, row.cid) : null),
    payUrl: row.status === "open" && row.publicToken ? payUrlFor(appUrl, row.publicToken) : null,
    pdfReady: !!row.pdfStorageKey,
    lines: lines.map((l) => ({
      id: l.id,
      position: l.position,
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      amountCents: l.amountCents,
      taxable: l.taxable,
      jobId: l.jobId,
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
