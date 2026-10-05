import { z } from "zod";
import { BILLING_FREQUENCIES, SERVICE_TYPES } from "./contracts.ts";
import { CUSTOMER_TYPES } from "./crm.ts";
import { id } from "./crm.ts";
import { contractInstallments, invoiceTotals, MAX_CENTS, type InvoiceTotals } from "./invoices.ts";

// Renewals: the next term of a contract, offered to the homeowner through one link where
// they confirm their details, pick add-ons, sign and pay.

export const RENEWAL_STATUSES = ["upcoming", "sent", "viewed", "signed", "payment_pending", "paid", "activated", "declined", "expired", "needs_review"] as const;
export type RenewalStatus = (typeof RENEWAL_STATUSES)[number];

export const RENEWAL_STATUS_LABELS: Record<RenewalStatus, string> = {
  upcoming: "Not sent",
  sent: "Sent",
  viewed: "Viewed",
  signed: "Signed",
  payment_pending: "Awaiting payment",
  paid: "Paid",
  activated: "Renewed",
  declined: "Declined",
  expired: "Expired",
  needs_review: "Needs review",
};

/** The customer can still sign, and the office can still change the offer. */
export const SIGNABLE_STATUSES = ["upcoming", "sent", "viewed"] as const satisfies readonly RenewalStatus[];
/** Finished, one way or another. */
export const CLOSED_STATUSES = ["activated", "declined", "expired"] as const satisfies readonly RenewalStatus[];

export const isSignable = (s: RenewalStatus) => (SIGNABLE_STATUSES as readonly RenewalStatus[]).includes(s);

/** Automatic reminders go out this many days before the contract ends, while unsigned. */
export const REMINDER_DAYS = [30, 7] as const;
/** No reminder within this many days of the last email. */
export const REMINDER_GAP_DAYS = 3;

export const RENEWAL_PAYMENT_POLICIES = ["pay_to_activate", "invoice"] as const;

export const DEFAULT_RENEWAL_TERMS = [
  "1. Service. The provider will perform the maintenance visits listed above on the aerobic treatment system at the service address, inspect and service it as required by the permitting authority, and file each inspection report with that authority where required.",
  "2. Access. The customer will give the provider reasonable access to the system, keep it powered, and tell the provider about alarms or problems between visits.",
  "3. Repairs. Repairs, parts and pumping are not included unless listed as an add-on, and are quoted before any work is done.",
  "4. Payment. The customer will pay the amounts shown above on the schedule shown. Add-ons are billed once, with the first payment.",
  "5. Term. This agreement covers the dates shown above. Either party may end it with 30 days' written notice; visits already performed are not refunded.",
  "6. Electronic signature. The customer agrees that signing electronically has the same effect as signing on paper.",
].join("\n\n");

export const CONSENT_TEXT = "I have read this agreement and agree to its terms. I agree to sign electronically, and that my electronic signature is as binding as one on paper.";

const date = z.iso.date();
const datetime = z.iso.datetime({ offset: true });
const cents = z.number().int().min(0).max(MAX_CENTS);

// ---- Settings and add-ons ----

export const renewalSettingsInput = z.object({
  windowDays: z.number().int().min(14).max(180),
  autoSend: z.boolean(),
  payment: z.enum(RENEWAL_PAYMENT_POLICIES),
  /** Null restores the built-in agreement. */
  terms: z.string().trim().min(20).max(20_000).nullable(),
});
export const renewalSettings = renewalSettingsInput.extend({ terms: z.string(), customTerms: z.boolean() });
export type RenewalSettings = z.infer<typeof renewalSettings>;

const addonFields = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullish(),
  priceCents: cents,
  taxable: z.boolean(),
  active: z.boolean(),
});
export const addonInput = addonFields.extend({ taxable: addonFields.shape.taxable.default(false), active: addonFields.shape.active.default(true) });
export const addonPatch = addonFields.partial();
export const renewalAddon = z.object({ id, name: z.string(), description: z.string().nullable(), priceCents: z.number().int(), taxable: z.boolean(), active: z.boolean() });
export type RenewalAddon = z.infer<typeof renewalAddon>;

/** An add-on as chosen: copied, so later catalog edits never change a signed renewal. */
export const chosenAddon = renewalAddon.pick({ id: true, name: true, description: true, priceCents: true, taxable: true });
export type ChosenAddon = z.infer<typeof chosenAddon>;

// ---- The offer and what it costs ----

export const renewalTerms = z.object({
  planId: id.nullable(),
  planName: z.string(),
  customerType: z.enum(CUSTOMER_TYPES),
  termMonths: z.number().int(),
  visitsPerTerm: z.number().int(),
  priceCents: z.number().int(),
  billingFrequency: z.enum(BILLING_FREQUENCIES),
  serviceType: z.enum(SERVICE_TYPES),
  autoRenew: z.boolean(),
  startOn: date,
  endOn: date,
});
export type RenewalTerms = z.infer<typeof renewalTerms>;

export interface RenewalChargeLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxable: boolean;
  /** The first installment of the new term (the line that is linked to the new contract). */
  installment?: { number: number; count: number; periodStart: string; periodEnd: string };
}

const longDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

/**
 * What the customer pays when they renew: the new term's first installment (all of it,
 * for annual billing) plus each add-on once. Later installments are billed as usual.
 */
export function renewalCharges(t: RenewalTerms, addons: readonly ChosenAddon[], taxRateBps: number): { lines: RenewalChargeLine[]; totals: InvoiceTotals; installments: number } {
  const parts = contractInstallments(t);
  const first = parts[0]!;
  const which = first.count > 1 ? ` (payment 1 of ${first.count})` : "";
  const lines: RenewalChargeLine[] = [
    {
      description: `Renewal: ${t.planName}, ${longDay(first.periodStart)} to ${longDay(first.periodEnd)}${which}`,
      quantity: 1,
      unitPriceCents: first.amountCents,
      taxable: false,
      installment: { number: 1, count: first.count, periodStart: first.periodStart, periodEnd: first.periodEnd },
    },
    ...addons.map((a) => ({ description: a.name, quantity: 1, unitPriceCents: a.priceCents, taxable: a.taxable })),
  ];
  return { lines, totals: invoiceTotals(lines, 0, taxRateBps), installments: first.count };
}

// ---- What gets signed ----

export const agreementContent = z.object({
  format: z.literal(1),
  title: z.string(),
  offerVersion: z.number().int(),
  provider: z.object({ name: z.string(), address: z.string().nullable(), phone: z.string().nullable(), email: z.string().nullable() }),
  customer: z.object({ name: z.string(), email: z.string().nullable(), phone: z.string().nullable() }),
  serviceAddress: z.string(),
  previousTerm: z.object({ planName: z.string(), startOn: date, endOn: date }),
  term: renewalTerms,
  addons: z.array(chosenAddon),
  charges: z.object({
    lines: z.array(z.object({ description: z.string(), amountCents: z.number().int(), taxable: z.boolean() })),
    taxCents: z.number().int(),
    totalCents: z.number().int(),
    installments: z.number().int(),
    payment: z.enum(RENEWAL_PAYMENT_POLICIES),
  }),
  terms: z.string(),
});
export type AgreementContent = z.infer<typeof agreementContent>;

// ---- API shapes ----

export const renewalOfferPatch = z.object({
  /** Offer a different plan (its current terms and price). */
  planId: id.optional(),
  priceCents: cents.optional(),
});

export const renewalSignInput = z.object({
  /** The offer version the customer was shown; a changed offer has to be re-read. */
  version: z.number().int().min(1),
  contact: z.object({
    email: z.email().max(320),
    phone: z.string().trim().max(40).nullish(),
  }),
  addonIds: z.array(id).max(20).default([]),
  signerName: z.string().trim().min(2).max(200),
  signature: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("typed") }),
    z.object({
      kind: z.literal("drawn"),
      /** A PNG data URL from the signature pad; about 200 KB at most. */
      image: z.string().max(300_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/),
    }),
  ]),
  agree: z.literal(true),
});
export type RenewalSignInput = z.input<typeof renewalSignInput>;

export const renewalDeclineInput = z.object({ reason: z.string().trim().max(2000).nullish() });

export const renewalListItem = z.object({
  id,
  status: z.enum(RENEWAL_STATUSES),
  contractId: id,
  planName: z.string(),
  priceCents: z.number().int(),
  startOn: date,
  endOn: date,
  /** When the contract being renewed ends. */
  contractEndOn: date,
  sentAt: datetime.nullable(),
  viewedAt: datetime.nullable(),
  signedAt: datetime.nullable(),
  activatedAt: datetime.nullable(),
  reviewReason: z.string().nullable(),
  customer: z.object({ id, displayName: z.string() }),
  site: z.object({ id, addressLine1: z.string(), city: z.string() }),
  hasEmail: z.boolean(),
});
export type RenewalListItem = z.infer<typeof renewalListItem>;

export const renewalList = z.object({
  items: z.array(renewalListItem),
  counts: z.partialRecord(z.enum(RENEWAL_STATUSES), z.number().int()),
  /** Active contracts inside the renewal window that have no renewal yet. */
  notStarted: z.number().int(),
});

export const signedDocumentSummary = z.object({
  id,
  title: z.string(),
  signerName: z.string(),
  signatureKind: z.enum(["typed", "drawn"]),
  signedAt: datetime,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  contentSha256: z.string(),
  pdfReady: z.boolean(),
});

export const renewalDetail = renewalListItem.extend({
  version: z.number().int(),
  terms: renewalTerms,
  link: z.string(),
  sendCount: z.number().int(),
  autoRenewContract: z.boolean(),
  selectedAddons: z.array(chosenAddon),
  customerUpdates: z.record(z.string(), z.unknown()),
  paidAt: datetime.nullable(),
  declinedAt: datetime.nullable(),
  declineReason: z.string().nullable(),
  expiredAt: datetime.nullable(),
  invoice: z.object({ id, number: z.number().int().nullable(), totalCents: z.number().int(), paymentStatus: z.string() }).nullable(),
  newContractId: id.nullable(),
  signedDocument: signedDocumentSummary.nullable(),
  email: z.string().nullable(),
});
export type RenewalDetail = z.infer<typeof renewalDetail>;

/** What the homeowner sees from their link. */
export const publicRenewal = z.object({
  status: z.enum(RENEWAL_STATUSES),
  version: z.number().int(),
  provider: z.object({ name: z.string(), phone: z.string().nullable(), email: z.string().nullable() }),
  customerName: z.string(),
  serviceAddress: z.string(),
  currentTerm: z.object({ planName: z.string(), endOn: date }),
  terms: renewalTerms,
  installments: z.number().int(),
  firstPaymentCents: z.number().int(),
  taxRateBps: z.number().int(),
  addons: z.array(chosenAddon),
  selectedAddonIds: z.array(id),
  contact: z.object({ name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }),
  agreementText: z.string(),
  consentText: z.string(),
  payment: z.enum(RENEWAL_PAYMENT_POLICIES),
  signed: z.object({ signerName: z.string(), signedAt: datetime, pdfReady: z.boolean() }).nullable(),
  /** Set while there is something to pay. */
  pay: z.object({ amountDueCents: z.number().int(), canPayOnline: z.boolean(), invoiceUrl: z.string() }).nullable(),
  newTermStartsOn: date.nullable(),
  testMode: z.boolean(),
});
export type PublicRenewal = z.infer<typeof publicRenewal>;
