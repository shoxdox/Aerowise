import { z } from "zod";
import { CUSTOMER_TYPES, id } from "./crm.ts";

export const BILLING_FREQUENCIES = ["annual", "semiannual", "quarterly", "monthly"] as const;
export const SERVICE_TYPES = ["aerobic_inspection"] as const;
export const CONTRACT_STATES = ["upcoming", "active", "expired", "cancelled"] as const;
export const OBLIGATION_STATUSES = ["open", "completed", "cancelled"] as const;

const date = z.iso.date();
const money = z.number().int().min(0).max(100_000_000);

const planFields = z.object({
  name: z.string().trim().min(1).max(200),
  customerType: z.enum(CUSTOMER_TYPES),
  termMonths: z.number().int().min(1).max(60),
  visitsPerTerm: z.number().int().min(1).max(24),
  priceCents: money,
  billingFrequency: z.enum(BILLING_FREQUENCIES),
  serviceType: z.enum(SERVICE_TYPES),
  active: z.boolean(),
});

const evenVisits = (p: { termMonths?: number; visitsPerTerm?: number }) =>
  p.termMonths === undefined || p.visitsPerTerm === undefined || p.termMonths % p.visitsPerTerm === 0;
const evenVisitsError = { message: "Visits must split the term into whole months", path: ["visitsPerTerm"] };

export const planInput = planFields
  .extend({
    customerType: planFields.shape.customerType.default("residential"),
    billingFrequency: planFields.shape.billingFrequency.default("annual"),
    serviceType: planFields.shape.serviceType.default("aerobic_inspection"),
    active: planFields.shape.active.default(true),
  })
  .refine(evenVisits, evenVisitsError);

// Contracts copy term, visits and price from their plan when created, so editing a
// plan never rewrites existing contracts.
export const planPatch = planFields.partial().refine(evenVisits, evenVisitsError);

export const plan = planFields.extend({
  id,
  /** The version contracts and renewals take now (SW-8); a change to any term above makes a new one. */
  currentVersionId: id,
  version: z.number().int(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const contractInput = z.object({
  planId: id,
  startOn: date,
  /** Defaults to the plan's price. */
  priceCents: money.optional(),
  autoRenew: z.boolean().default(false),
  notes: z.string().trim().max(5000).nullish(),
  /**
   * The visits per term the office agreed to, when the site's authority needs more than the
   * plan has (see `GET /sites/:id/contract-terms`). Without it such a contract is refused (409).
   */
  acceptVisits: z.number().int().min(1).max(366).optional(),
  /**
   * SW-7: the office confirms an aerobic inspection contract on a site whose systems are all
   * recorded as non-aerobic (see `systemWarning` in `GET /sites/:id/contract-terms`). Without it
   * such a contract is refused (409 `system_not_aerobic`); the records may be wrong, so it is
   * never a hard refusal.
   */
  confirmSystemCategory: z.boolean().optional(),
  /**
   * The plan version's options the customer takes (SW-8, plan builder on). Required options are
   * included whatever is sent; any other option is taken only when named here.
   */
  optionKeys: z.array(z.string().max(64)).max(20).optional(),
});

/** What a contract on this plan at this site would get, before it is created. */
export const contractTermsPreview = z.object({
  planVisits: z.number().int(),
  visitsPerTerm: z.number().int(),
  /** Set when the site's authority needs more visits than the plan has: say so before creating. */
  warning: z.string().nullable(),
  /** Set when the authority's schedule for this site isn't settled yet (Montgomery food establishments). */
  scheduleNotice: z.string().nullable(),
  /** SW-7: set when the site's systems are all recorded as non-aerobic: confirm before creating. */
  systemWarning: z.string().nullable(),
});

export const renewInput = z.object({
  /** Defaults to the same plan as the contract being renewed. */
  planId: id.optional(),
  priceCents: money.optional(),
  /** As for a new contract: the visits agreed to when the authority needs more than the plan has. */
  acceptVisits: z.number().int().min(1).max(366).optional(),
  /** As for a new contract: the plan options taken (SW-8). */
  optionKeys: z.array(z.string().max(64)).max(20).optional(),
});

export const cancelInput = z.object({
  reason: z.string().trim().min(1).max(2000),
  /** Who ended it: the provider or the owner. Decides who must get written notice (30 TAC 285.7(d)(3)). */
  discontinuedBy: z.enum(["provider", "owner"]).optional(),
  /** The last day of service. The provider's written notice is due 30 days before it. */
  serviceEndsOn: z.iso.date().optional(),
});

export const obligation = z.object({
  id,
  contractId: id,
  siteId: id,
  serviceType: z.enum(SERVICE_TYPES),
  sequence: z.number().int(),
  windowStart: date,
  windowEnd: date,
  dueOn: date,
  status: z.enum(OBLIGATION_STATUSES),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});

export const contract = z.object({
  id,
  siteId: id,
  planId: id.nullable(),
  planName: z.string(),
  /** Copied from the plan. An authority may require commercial systems to be serviced more often. */
  customerType: z.enum(CUSTOMER_TYPES),
  startOn: date,
  endOn: date,
  termMonths: z.number().int(),
  visitsPerTerm: z.number().int(),
  priceCents: z.number().int(),
  billingFrequency: z.enum(BILLING_FREQUENCIES),
  serviceType: z.enum(SERVICE_TYPES),
  autoRenew: z.boolean(),
  status: z.enum(["active", "cancelled"]),
  state: z.enum(CONTRACT_STATES),
  /** The latest renewal's status, or "not_started". */
  renewalStatus: z.string(),
  renewalId: id.nullable(),
  previousContractId: id.nullable(),
  renewedById: id.nullable(),
  cancelledAt: z.iso.datetime({ offset: true }).nullable(),
  cancelReason: z.string().nullable(),
  /**
   * The last day of service when the contract is ending or has ended. A contract with a
   * later last day stays active until then, with the visits due before it.
   */
  serviceEndsOn: z.iso.date().nullable(),
  discontinuedBy: z.enum(["provider", "owner"]).nullable(),
  /** The MP license named on the contract, who signs its reports by default. Null: the organization's responsible MP. */
  providerCredentialId: id.nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const contractDetail = contract.extend({
  obligations: z.array(obligation),
  /** The plan version the contract was made from (SW-8); null for one made before versions, or without a plan. */
  planVersion: z.object({ id, version: z.number().int() }).nullable(),
  /** The coverage rules frozen on the contract when it was made, with their use this term. */
  coverage: z.array(z.object({ id, ruleKey: z.string(), label: z.string(), summary: z.string(), limit: z.number().int().nullable(), used: z.number().int() })),
  /** Plan options taken when the office made the contract (SW-8), billed with its first payment. */
  options: z.array(z.object({ optionKey: z.string(), name: z.string(), priceCents: z.number().int(), taxable: z.boolean() })),
});

export const dueObligation = obligation.extend({
  overdue: z.boolean(),
  /** The live job this visit is scheduled as, if any. */
  job: z.object({ id, scheduledDate: date, technicianId: id, technicianName: z.string() }).nullable(),
  site: z.object({
    id,
    addressLine1: z.string(),
    city: z.string(),
    safetyFlags: z.array(z.string()),
    schedulingNotes: z.string().nullable(),
  }),
  customer: z.object({ id, displayName: z.string() }),
});

export const dueQuery = z.object({
  /** Include open visits due on or before this date (so overdue ones too). Defaults to today + 30 days. */
  through: date.optional(),
  siteId: id.optional(),
  overdueOnly: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  /** Only visits that have no live job yet: the scheduler's "unscheduled work". */
  unscheduledOnly: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PlanInput = z.input<typeof planInput>;
export type Plan = z.infer<typeof plan>;
export type ContractInput = z.input<typeof contractInput>;
export type Contract = z.infer<typeof contract>;
export type ContractDetail = z.infer<typeof contractDetail>;
export type Obligation = z.infer<typeof obligation>;
export type DueObligation = z.infer<typeof dueObligation>;
export type ContractTermsPreview = z.infer<typeof contractTermsPreview>;
