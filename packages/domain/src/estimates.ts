import { z } from "zod";
import { id } from "./crm.ts";
import { signatureCapture } from "./forms.ts";
import { depositView } from "./deposits.ts";
import { invoiceTotals, MAX_CENTS, MAX_TAX_RATE_BPS, type InvoiceTotals } from "./invoices.ts";
import { quantity } from "./work.ts";

// Estimates (SW-5 part 1; service workflows plan §3.3–§3.5). The office drafts an estimate,
// sends it as a frozen version, and the homeowner accepts it with a signature from their
// link (or the office records a paper or phone approval, with evidence). Acceptance creates
// the work order exactly once. Deposits (part 2) are in deposits.ts.

export const ESTIMATE_STATUSES = ["draft", "sent", "viewed", "accepted", "declined", "expired", "void", "cancelled"] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];
export const ESTIMATE_STATUS_LABELS: Record<EstimateStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  void: "Void",
  cancelled: "Cancelled after acceptance",
};

/**
 * Versioned estimate state machine. `draft → sent → (viewed) → accepted | declined | expired`;
 * `void` from a draft or a sent estimate; `cancelled` is the office's cancellation after
 * acceptance. A sent or viewed estimate goes back to `draft` when the office revises it, as a
 * new version. A draft can be accepted directly only when the office records it.
 */
export const ESTIMATE_STATE_MACHINE = {
  version: 1,
  transitions: {
    draft: ["sent", "accepted", "void"],
    sent: ["viewed", "draft", "accepted", "declined", "expired", "void"],
    viewed: ["draft", "accepted", "declined", "expired", "void"],
    accepted: ["cancelled"],
    declined: [],
    expired: [],
    void: [],
    cancelled: [],
  } satisfies Record<EstimateStatus, readonly EstimateStatus[]>,
} as const;

export function canTransitionEstimate(from: EstimateStatus, to: EstimateStatus): boolean {
  return (ESTIMATE_STATE_MACHINE.transitions[from] as readonly EstimateStatus[]).includes(to);
}

/** The states in which the homeowner can accept or decline from their link. */
export const ESTIMATE_OPEN_STATUSES = ["sent", "viewed"] as const satisfies readonly EstimateStatus[];
export const isEstimateOpen = (s: EstimateStatus) => (ESTIMATE_OPEN_STATUSES as readonly EstimateStatus[]).includes(s);

export const ESTIMATE_SOURCE_KINDS = ["office", "inspection_issue", "portal_request"] as const;
export type EstimateSourceKind = (typeof ESTIMATE_SOURCE_KINDS)[number];
export const ESTIMATE_ACCEPTANCE_KINDS = ["signature", "office_recorded"] as const;
export type EstimateAcceptanceKind = (typeof ESTIMATE_ACCEPTANCE_KINDS)[number];

/** Shown as EST-1001. */
export const estimateLabel = (n: number) => `EST-${n}`;

export const ESTIMATE_CONSENT_TEXT =
  "I have read this estimate and accept it, with the options I chose. I agree to sign electronically, and that my electronic signature is as binding as one on paper.";
export const DEFAULT_ESTIMATE_TERMS =
  "This estimate is for the work described. Work that turns out to be needed beyond it is quoted before it is done. Prices are good until the date shown. Payment is due on the final invoice's terms.";

const date = z.iso.date();
const datetime = z.iso.datetime({ offset: true });
const cents = z.number().int().min(0).max(MAX_CENTS);

// ---- Lines and totals ----

export const estimateLineInput = z.object({
  description: z.string().trim().min(1).max(500),
  quantity,
  unitPriceCents: cents,
  taxable: z.boolean().default(false),
  /** The homeowner may add or leave out an optional line. */
  optional: z.boolean().default(false),
  /** Whether an optional line starts selected. Ignored on a required line. */
  selectedByDefault: z.boolean().default(true),
});
export type EstimateLineInput = z.input<typeof estimateLineInput>;

/** A line as frozen in a sent version, and as the homeowner sees it. */
export const estimateLine = z.object({
  id,
  description: z.string(),
  quantityMilli: z.number().int(),
  unitPriceCents: z.number().int(),
  taxable: z.boolean(),
  optional: z.boolean(),
  selectedByDefault: z.boolean(),
  amountCents: z.number().int(),
});
export type EstimateLine = z.infer<typeof estimateLine>;

export const estimateLineAmount = (l: { quantityMilli: number; unitPriceCents: number }) => Math.round((l.quantityMilli * l.unitPriceCents) / 1000);

/** The lines a selection includes: every required line, and the chosen optional ones (or their defaults). */
export function selectedLines<L extends Pick<EstimateLine, "id" | "optional" | "selectedByDefault">>(lines: readonly L[], selectedOptionalIds?: readonly string[] | null): L[] {
  const chosen = selectedOptionalIds ? new Set(selectedOptionalIds) : null;
  return lines.filter((l) => !l.optional || (chosen ? chosen.has(l.id) : l.selectedByDefault));
}

/** Totals for a selection, with the same discount and tax rules as an invoice. */
export function estimateTotals(
  lines: readonly Pick<EstimateLine, "id" | "optional" | "selectedByDefault" | "quantityMilli" | "unitPriceCents" | "taxable">[],
  discountCents: number,
  taxRateBps: number,
  selectedOptionalIds?: readonly string[] | null,
): InvoiceTotals {
  return invoiceTotals(
    selectedLines(lines, selectedOptionalIds).map((l) => ({ quantity: 1, unitPriceCents: estimateLineAmount(l), taxable: l.taxable })),
    discountCents,
    taxRateBps,
  );
}

const totals = z.object({ subtotalCents: z.number().int(), discountCents: z.number().int(), taxableCents: z.number().int(), taxCents: z.number().int(), totalCents: z.number().int() });

// ---- Office input ----

const title = z.string().trim().min(1).max(200);
const terms = z.string().trim().max(10_000);

export const estimateInput = z.object({
  siteId: id,
  workTypeId: id.nullish(),
  /** "Estimate" plus the kind of work when left out. */
  title: title.optional(),
  lines: z.array(estimateLineInput).min(1).max(100),
  taxRateBps: z.number().int().min(0).max(MAX_TAX_RATE_BPS).optional(),
  discountCents: cents.default(0),
  /** The company's default terms when left out. */
  termsText: terms.optional(),
  expiresOn: date.nullish(),
  /** A deposit to pay on acceptance (needs the deposits feature). Never more than the accepted total. */
  depositCents: z.number().int().min(1).max(MAX_CENTS).nullish(),
});
export type EstimateInput = z.input<typeof estimateInput>;

/** Changes to a draft. Lines, when given, replace all of them. */
export const estimateFields = z.object({
  workTypeId: id.nullish(),
  title: title.optional(),
  lines: z.array(estimateLineInput).min(1).max(100).optional(),
  taxRateBps: z.number().int().min(0).max(MAX_TAX_RATE_BPS).optional(),
  discountCents: cents.optional(),
  termsText: terms.optional(),
  expiresOn: date.nullish(),
  /** A deposit to pay on acceptance (needs the deposits feature). Never more than the accepted total. */
  depositCents: z.number().int().min(1).max(MAX_CENTS).nullish(),
});

export const estimateFromSourceInput = z.object({
  /** Lines to start the draft with; the office edits it afterwards. */
  lines: z.array(estimateLineInput).max(100).default([]),
});

export const estimateReasonInput = z.object({ reason: z.string().trim().min(1).max(2000) });

/** The office recording a paper or phone approval. Never shown as a homeowner e-signature. */
export const estimateRecordAcceptanceInput = z.object({
  /** The version the customer approved; the current one when left out. */
  version: z.number().int().min(1).optional(),
  selectedOptionalLineIds: z.array(id).max(100).default([]),
  evidence: z.string().trim().min(1).max(4000),
});

export const estimateListQuery = z.object({
  status: z.enum(ESTIMATE_STATUSES).optional(),
  /** Draft, sent and viewed. */
  active: z.coerce.boolean().optional(),
  customerId: id.optional(),
  siteId: id.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Office views ----

export const estimateSummary = z.object({
  id,
  number: z.number().int(),
  label: z.string(),
  title: z.string(),
  status: z.enum(ESTIMATE_STATUSES),
  currentVersion: z.number().int(),
  customer: z.object({ id, displayName: z.string() }),
  site: z.object({ id, addressLine1: z.string(), city: z.string() }),
  /** With the default selection, for the version being drafted or the last one sent. */
  totalCents: z.number().int(),
  expiresOn: date.nullable(),
  sentAt: datetime.nullable(),
  acceptedAt: datetime.nullable(),
  workOrderId: id.nullable(),
  createdAt: datetime,
});
export type EstimateSummary = z.infer<typeof estimateSummary>;

export const estimateVersionView = z.object({
  version: z.number().int(),
  lines: z.array(estimateLine),
  taxRateBps: z.number().int(),
  discountCents: z.number().int(),
  totals,
  termsText: z.string(),
  expiresOn: date.nullable(),
  depositCents: z.number().int().nullable(),
  contentSha256: z.string(),
  sentAt: datetime,
});
export type EstimateVersionView = z.infer<typeof estimateVersionView>;

export const estimateDetail = estimateSummary.extend({
  workType: z.object({ id, name: z.string() }).nullable(),
  source: z.object({ kind: z.enum(ESTIMATE_SOURCE_KINDS), id: id.nullable(), label: z.string() }),
  /** The draft (editable only while status is draft). */
  draft: z.object({ lines: z.array(estimateLine), taxRateBps: z.number().int(), discountCents: z.number().int(), totals, termsText: z.string(), expiresOn: date.nullable(), depositCents: z.number().int().nullable() }),
  versions: z.array(estimateVersionView),
  acceptance: z
    .object({
      version: z.number().int(),
      kind: z.enum(ESTIMATE_ACCEPTANCE_KINDS),
      at: datetime,
      selectedOptionalLineIds: z.array(z.string()),
      totals,
      signerName: z.string().nullable(),
      signatureKind: z.enum(["typed", "drawn"]).nullable(),
      documentSha256: z.string().nullable(),
      evidence: z.string().nullable(),
      recordedByName: z.string().nullable(),
    })
    .nullable(),
  workOrder: z.object({ id, label: z.string(), status: z.string() }).nullable(),
  declinedReason: z.string().nullable(),
  voidReason: z.string().nullable(),
  cancelReason: z.string().nullable(),
  events: z.array(z.object({ id, eventType: z.string(), summary: z.string(), occurredAt: datetime, actorName: z.string().nullable() })),
  /** Whether the company has an email on file for the customer, so the estimate can be emailed. */
  canEmail: z.boolean(),
  /** The deposit invoice and its ledger, once a deposit has been asked for. */
  deposit: depositView.nullable(),
});
export type EstimateDetail = z.infer<typeof estimateDetail>;

// ---- The homeowner's link ----

export const publicEstimate = z.object({
  status: z.enum(ESTIMATE_STATUSES),
  label: z.string(),
  title: z.string(),
  provider: z.object({ name: z.string(), phone: z.string().nullable(), email: z.string().nullable() }),
  customerName: z.string(),
  serviceAddress: z.string(),
  /** The last version sent, or null while the first one is still a draft. */
  version: estimateVersionView.omit({ contentSha256: true }).nullable(),
  /** A newer version is being drafted: the link waits for it. */
  beingRevised: z.boolean(),
  consentText: z.string(),
  accepted: z
    .object({ version: z.number().int(), at: datetime, kind: z.enum(ESTIMATE_ACCEPTANCE_KINDS), signerName: z.string().nullable(), selectedOptionalLineIds: z.array(z.string()), totals })
    .nullable(),
  /** The deposit to pay after accepting, with its pay page while it is owed. */
  deposit: z.object({ amountCents: z.number().int(), paymentStatus: z.string(), payUrl: z.string().nullable() }).nullable(),
});
export type PublicEstimate = z.infer<typeof publicEstimate>;

export const estimateAcceptInput = z.object({
  /** The version the homeowner was shown; a revised estimate has to be read again. */
  version: z.number().int().min(1),
  selectedOptionalLineIds: z.array(id).max(100).default([]),
  signerName: z.string().trim().min(2).max(200),
  signature: signatureCapture,
  agree: z.literal(true, { message: "Tick the box to accept" }),
});
export type EstimateAcceptInput = z.input<typeof estimateAcceptInput>;

export const estimateDeclineInput = z.object({ reason: z.string().trim().max(2000).nullish() });

/** For the customer portal's list. */
export const portalEstimate = z.object({
  label: z.string(),
  title: z.string(),
  status: z.enum(ESTIMATE_STATUSES),
  totalCents: z.number().int(),
  expiresOn: date.nullable(),
  sentAt: datetime.nullable(),
  acceptedAt: datetime.nullable(),
});
export type PortalEstimate = z.infer<typeof portalEstimate>;
