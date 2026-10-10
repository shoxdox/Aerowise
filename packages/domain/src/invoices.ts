import { z } from "zod";
import type { BILLING_FREQUENCIES } from "./contracts.ts";
import { id } from "./crm.ts";
import { addDays, addMonths } from "./schedule.ts";

// Invoices, payments and refunds. Money is integer cents in US dollars throughout.
// Payment status is kept apart from invoice status: an invoice is a draft, open or void;
// how much of it has been paid is a separate question answered by its payments.

export const INVOICE_STATUSES = ["draft", "open", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_STATUSES = ["unpaid", "processing", "partial", "paid", "overpaid", "refunded"] as const;
export type InvoicePaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ["card", "ach", "check", "cash", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
/** Methods the office records by hand; card and ACH arrive through Stripe. */
export const MANUAL_PAYMENT_METHODS = ["check", "cash", "other"] as const;

export const PAYMENT_RECORD_STATUSES = ["pending", "succeeded", "failed"] as const;
export type PaymentRecordStatus = (typeof PAYMENT_RECORD_STATUSES)[number];

export const REFUND_STATUSES = ["pending", "succeeded", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = { card: "Card", ach: "Bank (ACH)", check: "Check", cash: "Cash", other: "Other" };
export const PAYMENT_STATUS_LABELS: Record<InvoicePaymentStatus, string> = {
  unpaid: "Unpaid",
  processing: "Payment processing",
  partial: "Partly paid",
  paid: "Paid",
  overpaid: "Overpaid",
  refunded: "Refunded",
};

/** Largest amount on one line or invoice: $1,000,000. */
export const MAX_CENTS = 100_000_000;
/** Tax rates are basis points: 825 is 8.25%. Texas tops out at 8.25%; 20% allows for anything. */
export const MAX_TAX_RATE_BPS = 2000;

export interface TotalsLine {
  quantity: number;
  unitPriceCents: number;
  taxable: boolean;
  /** Set on a fractional line (SW-3), whose amount is not quantity × price in whole units. */
  amountCents?: number;
}

export interface InvoiceTotals {
  subtotalCents: number;
  discountCents: number;
  /** The part of the subtotal tax is charged on, after its share of the discount. */
  taxableCents: number;
  taxCents: number;
  totalCents: number;
}

export const lineAmount = (l: Pick<TotalsLine, "quantity" | "unitPriceCents" | "amountCents">) => l.amountCents ?? l.quantity * l.unitPriceCents;

/**
 * The discount comes off the subtotal before tax, spread over taxable and untaxed lines
 * in proportion, so a discount never lowers tax by more than the taxed share it covers.
 * Tax rounds half up to the cent, once, on the invoice.
 */
export function invoiceTotals(lines: readonly TotalsLine[], discountCents: number, taxRateBps: number): InvoiceTotals {
  const subtotalCents = lines.reduce((sum, l) => sum + lineAmount(l), 0);
  const discount = Math.min(Math.max(0, discountCents), subtotalCents);
  const taxableGross = lines.filter((l) => l.taxable).reduce((sum, l) => sum + lineAmount(l), 0);
  const taxableDiscount = subtotalCents === 0 ? 0 : Math.round((discount * taxableGross) / subtotalCents);
  const taxableCents = taxableGross - taxableDiscount;
  const taxCents = Math.round((taxableCents * taxRateBps) / 10_000);
  return { subtotalCents, discountCents: discount, taxableCents, taxCents, totalCents: subtotalCents - discount + taxCents };
}

/**
 * Where an invoice stands with its payments. `paidCents` is what has cleared, less what
 * has been refunded; `pendingCents` is bank payments still clearing. `creditedCents` is
 * what was refunded as a credit: the customer no longer owes it, so it comes off the total.
 */
export function paymentStatus(p: { totalCents: number; paidCents: number; pendingCents: number; refundedCents: number; creditedCents: number }): InvoicePaymentStatus {
  const owed = p.totalCents - p.creditedCents;
  if (p.paidCents > owed) return "overpaid";
  if (p.paidCents === owed && (owed > 0 || p.refundedCents === 0)) return "paid";
  if (p.paidCents > 0) return "partial";
  if (p.pendingCents > 0) return "processing";
  if (p.refundedCents > 0) return "refunded";
  return "unpaid";
}

/** What is still owed and not already on its way. Never negative. */
export const amountDue = (p: { totalCents: number; paidCents: number; pendingCents: number; creditedCents: number }) => Math.max(0, p.totalCents - p.creditedCents - p.paidCents - p.pendingCents);

const PERIOD_MONTHS: Record<(typeof BILLING_FREQUENCIES)[number], number> = { annual: 12, semiannual: 6, quarterly: 3, monthly: 1 };

export interface ContractInstallment {
  /** 1-based. */
  installment: number;
  count: number;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
}

/**
 * Splits a contract's price into the installments its billing frequency asks for. A term
 * shorter than one billing period is one installment; a term that does not divide evenly
 * ends with a shorter period. Amounts follow the months each period covers, and the
 * rounding remainder goes on the first installment so the parts always add up to the price.
 */
export function contractInstallments(c: {
  startOn: string;
  endOn: string;
  termMonths: number;
  priceCents: number;
  billingFrequency: (typeof BILLING_FREQUENCIES)[number];
}): ContractInstallment[] {
  const period = Math.min(PERIOD_MONTHS[c.billingFrequency], c.termMonths);
  const count = Math.ceil(c.termMonths / period);
  const parts: ContractInstallment[] = [];
  for (let i = 0; i < count; i++) {
    const months = Math.min(period, c.termMonths - i * period);
    const periodStart = addMonths(c.startOn, i * period);
    const nextStart = addMonths(c.startOn, i * period + months);
    const periodEnd = i === count - 1 ? c.endOn : addDays(nextStart, -1);
    parts.push({ installment: i + 1, count, periodStart, periodEnd, amountCents: Math.floor((c.priceCents * months) / c.termMonths) });
  }
  const remainder = c.priceCents - parts.reduce((s, p) => s + p.amountCents, 0);
  parts[0]!.amountCents += remainder;
  return parts;
}

/** Shown as the invoice number: INV-1001. */
export const invoiceNumberLabel = (n: number | null) => (n === null ? "Draft" : `INV-${n}`);

// ---- API schemas ----

const date = z.iso.date();
const datetime = z.iso.datetime({ offset: true });
const cents = z.number().int().min(0).max(MAX_CENTS);
const note = z.string().trim().max(2000).nullish();

export const invoiceLineInput = z.object({
  /** An existing line of the same draft: keeps what it bills for (a contract installment). */
  id: id.optional(),
  description: z.string().trim().min(1).max(500),
  /** Whole units, or up to three decimals (hours, gallons) where service items are switched on. */
  quantity: z
    .number()
    .min(0.001)
    .max(10_000)
    .refine((q) => Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6, { message: "Use at most three decimals" })
    .default(1),
  unitPriceCents: cents,
  taxable: z.boolean().default(false),
  jobId: id.nullish(),
  /** The catalog item the line started from; the line keeps its own description and price. */
  serviceItemId: id.nullish(),
});
export type InvoiceLineInput = z.input<typeof invoiceLineInput>;

/** The most one line, and one invoice, may come to; amounts are stored as 32-bit integers. */
export const LINE_LIMIT_MESSAGE = "A line can come to at most $1,000,000";
export const INVOICE_LIMIT_MESSAGE = "An invoice can come to at most $1,000,000";
export const withinLineLimit = (l: { quantity: number; unitPriceCents: number }) => l.quantity * l.unitPriceCents <= MAX_CENTS;

const linesInput = z.array(invoiceLineInput.refine(withinLineLimit, { message: LINE_LIMIT_MESSAGE, path: ["unitPriceCents"] })).min(1).max(100);

const invoiceFields = z.object({
  siteId: id.nullable(),
  memo: z.string().trim().max(2000).nullable(),
  /** Days from the issue date to the due date. Defaults to the organization's terms. */
  termsDays: z.number().int().min(0).max(120),
  taxRateBps: z.number().int().min(0).max(MAX_TAX_RATE_BPS),
  discountCents: cents,
  lines: linesInput,
});

export const invoiceInput = invoiceFields.partial().extend({ customerId: id, lines: linesInput });
export type InvoiceInput = z.input<typeof invoiceInput>;
/** Drafts only; lines, when given, replace all lines. */
export const invoicePatch = invoiceFields.partial();

export const invoiceIssueInput = z.object({
  send: z.boolean().default(true),
  /** A final invoice for an estimate with a deposit: how much free deposit money to apply. All of it, up to the invoice's total, when left out. */
  depositCents: cents.optional(),
});
export const invoiceVoidInput = z.object({ reason: z.string().trim().min(1).max(2000) });

export const manualPaymentInput = z.object({
  amountCents: cents.min(1),
  method: z.enum(MANUAL_PAYMENT_METHODS),
  receivedOn: date,
  /** Check number or receipt. */
  reference: z.string().trim().max(200).nullish(),
  note,
});
export type ManualPaymentInput = z.input<typeof manualPaymentInput>;

/**
 * `credit` (the usual refund): the customer no longer owes the amount, so the invoice stays paid.
 * `reverse`: the payment was taken by mistake and the customer still owes it, so the balance reopens.
 */
export const REFUND_INTENTS = ["credit", "reverse"] as const;
export type RefundIntent = (typeof REFUND_INTENTS)[number];
export const refundInput = z.object({ amountCents: cents.min(1), reason: z.string().trim().min(1).max(2000), intent: z.enum(REFUND_INTENTS).default("credit") });

export const billingSettingsInput = z.object({
  invoiceTermsDays: z.number().int().min(0).max(120),
  defaultTaxRateBps: z.number().int().min(0).max(MAX_TAX_RATE_BPS),
});

export const billingSettings = billingSettingsInput.extend({
  /** Which payment provider the server runs with. `test` is the built-in stand-in for development. */
  provider: z.enum(["stripe", "test", "none"]),
  stripe: z.object({
    accountId: z.string().nullable(),
    chargesEnabled: z.boolean(),
    detailsSubmitted: z.boolean(),
  }),
});
export type BillingSettings = z.infer<typeof billingSettings>;

export const invoiceListItem = z.object({
  id,
  number: z.number().int().nullable(),
  status: z.enum(INVOICE_STATUSES),
  paymentStatus: z.enum(PAYMENT_STATUSES),
  issuedOn: date.nullable(),
  dueOn: date.nullable(),
  overdue: z.boolean(),
  totalCents: z.number().int(),
  paidCents: z.number().int(),
  pendingCents: z.number().int(),
  /** Refunded as a credit: no longer owed. */
  creditedCents: z.number().int(),
  amountDueCents: z.number().int(),
  sentAt: datetime.nullable(),
  customer: z.object({ id, displayName: z.string() }),
  site: z.object({ id, addressLine1: z.string(), city: z.string() }).nullable(),
  createdAt: datetime,
});
export type InvoiceListItem = z.infer<typeof invoiceListItem>;

export const invoiceLine = z.object({
  id,
  position: z.number().int(),
  description: z.string(),
  /** Whole units, or a fraction where `quantityMilli` is set. */
  quantity: z.number(),
  quantityMilli: z.number().int().nullable(),
  unitPriceCents: z.number().int(),
  amountCents: z.number().int(),
  taxable: z.boolean(),
  jobId: id.nullable(),
  serviceItemId: id.nullable(),
  contractId: id.nullable(),
  installment: z.number().int().nullable(),
  periodStart: date.nullable(),
  periodEnd: date.nullable(),
  /** Set when the line bills an authority's filing fee (the company's setting). */
  filingId: id.nullable(),
});
export type InvoiceLine = z.infer<typeof invoiceLine>;

export const refund = z.object({
  id,
  amountCents: z.number().int(),
  status: z.enum(REFUND_STATUSES),
  intent: z.enum(REFUND_INTENTS),
  reason: z.string().nullable(),
  createdAt: datetime,
});

export const payment = z.object({
  id,
  amountCents: z.number().int(),
  refundedCents: z.number().int(),
  method: z.enum(PAYMENT_METHODS),
  source: z.enum(["stripe", "manual"]),
  status: z.enum(PAYMENT_RECORD_STATUSES),
  receivedOn: date.nullable(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  failureReason: z.string().nullable(),
  /** A bank payment Stripe holds until the customer verifies their account (microdeposits). */
  awaitingBankVerification: z.boolean(),
  createdAt: datetime,
  refunds: z.array(refund),
});
export type Payment = z.infer<typeof payment>;

export const invoiceEvent = z.object({ id, eventType: z.string(), summary: z.string(), occurredAt: datetime, actorName: z.string().nullable() });

export const invoiceDetail = invoiceListItem.extend({
  memo: z.string().nullable(),
  termsDays: z.number().int(),
  taxRateBps: z.number().int(),
  subtotalCents: z.number().int(),
  discountCents: z.number().int(),
  taxableCents: z.number().int(),
  taxCents: z.number().int(),
  /** Estimate deposit money applied to this final invoice; it comes off the total. */
  depositAppliedCents: z.number().int(),
  /** The estimate this is the deposit or final invoice of (SW-5b): its deposit is managed there. */
  estimate: z.object({ id, label: z.string(), role: z.enum(["deposit", "final"]) }).nullable(),
  voidedAt: datetime.nullable(),
  voidReason: z.string().nullable(),
  billToEmail: z.string().nullable(),
  /** Where the customer pays and views the invoice. Open invoices only. */
  payUrl: z.string().nullable(),
  /** Ready once the worker has drawn it, shortly after the invoice is issued. */
  pdfReady: z.boolean(),
  lines: z.array(invoiceLine),
  payments: z.array(payment),
  events: z.array(invoiceEvent),
});
export type InvoiceDetail = z.infer<typeof invoiceDetail>;

/** What the customer sees from their pay link: no internal ids beyond the invoice's own. */
export const publicInvoice = z.object({
  number: z.string(),
  status: z.enum(INVOICE_STATUSES),
  paymentStatus: z.enum(PAYMENT_STATUSES),
  issuedOn: date,
  dueOn: date,
  provider: z.object({ name: z.string(), phone: z.string().nullable(), email: z.string().nullable() }),
  customerName: z.string(),
  serviceAddress: z.string().nullable(),
  memo: z.string().nullable(),
  lines: z.array(z.object({ description: z.string(), quantity: z.number(), unitPriceCents: z.number().int(), amountCents: z.number().int() })),
  subtotalCents: z.number().int(),
  discountCents: z.number().int(),
  taxCents: z.number().int(),
  totalCents: z.number().int(),
  paidCents: z.number().int(),
  pendingCents: z.number().int(),
  /** Refunded as a credit: no longer owed. */
  creditedCents: z.number().int(),
  amountDueCents: z.number().int(),
  canPayOnline: z.boolean(),
  /** Where the customer verifies their bank account so a bank payment can go ahead (Stripe's page). */
  bankVerificationUrl: z.string().nullable(),
  pdfReady: z.boolean(),
  /** The built-in test provider is running: checkout is simulated and no money moves. */
  testMode: z.boolean(),
  /** Why this invoice no longer takes payment though money is due (a cancelled estimate's deposit). */
  closedReason: z.string().nullable().default(null),
});
export type PublicInvoice = z.infer<typeof publicInvoice>;

/**
 * Exactly what an issued invoice says, frozen when it is issued. The PDF and the customer
 * page are drawn from this, so editing the customer or the organization later never
 * changes an invoice already sent.
 */
export const invoiceSnapshot = z.object({
  number: z.string(),
  issuedOn: date,
  dueOn: date,
  timezone: z.string(),
  provider: z.object({ name: z.string(), address: z.string().nullable(), phone: z.string().nullable(), email: z.string().nullable() }),
  billTo: z.object({ name: z.string(), address: z.string().nullable(), email: z.string().nullable() }),
  serviceAddress: z.string().nullable(),
  memo: z.string().nullable(),
  lines: z.array(z.object({ description: z.string(), quantity: z.number(), unitPriceCents: z.number().int(), amountCents: z.number().int(), taxable: z.boolean() })),
  subtotalCents: z.number().int(),
  discountCents: z.number().int(),
  taxRateBps: z.number().int(),
  taxCents: z.number().int(),
  /** Deposit money applied (SW-5b); absent on every invoice issued before it. */
  depositAppliedCents: z.number().int().optional(),
  totalCents: z.number().int(),
});
export type InvoiceSnapshot = z.infer<typeof invoiceSnapshot>;
