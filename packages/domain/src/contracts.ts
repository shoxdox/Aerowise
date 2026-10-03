import { z } from "zod";
import { id } from "./crm.ts";

export const CUSTOMER_TYPES = ["residential", "commercial"] as const;
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

export const plan = planFields.extend({ id, createdAt: z.iso.datetime({ offset: true }) });

export const contractInput = z.object({
  planId: id,
  startOn: date,
  /** Defaults to the plan's price. */
  priceCents: money.optional(),
  autoRenew: z.boolean().default(false),
  notes: z.string().trim().max(5000).nullish(),
});

export const renewInput = z.object({
  /** Defaults to the same plan as the contract being renewed. */
  planId: id.optional(),
  priceCents: money.optional(),
});

export const cancelInput = z.object({ reason: z.string().trim().min(1).max(2000) });

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
  renewalStatus: z.string(),
  previousContractId: id.nullable(),
  renewedById: id.nullable(),
  cancelledAt: z.iso.datetime({ offset: true }).nullable(),
  cancelReason: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const contractDetail = contract.extend({ obligations: z.array(obligation) });

export const dueObligation = obligation.extend({
  overdue: z.boolean(),
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
