import { z } from "zod";
import { id } from "./crm.ts";
import type { ISSUE_TYPES } from "./inspections.ts";
import type { ServiceRequestKind } from "./portal.ts";

// General work orders: pumping, repairs, installations and service calls. They sit beside
// the aerobic inspection path and never touch it: a work order never opens a filing, makes
// an authority report, counts as a contract visit or moves a due date. See
// docs/engineering/SERVICE-WORKFLOWS-IMPLEMENTATION-PLAN.md §1.

/** What a job is: an aerobic inspection visit (the compliance path) or a visit for a work order. */
export const JOB_TYPES = ["inspection", "work"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const WORK_CATEGORIES = ["pumping", "repair", "installation", "maintenance", "inspection_other", "other"] as const;
export type WorkCategory = (typeof WORK_CATEGORIES)[number];
export const WORK_CATEGORY_LABELS: Record<WorkCategory, string> = {
  pumping: "Pumping",
  repair: "Repair",
  installation: "Installation",
  maintenance: "Maintenance",
  inspection_other: "Other inspection",
  other: "Other",
};

export const WORK_ORDER_STATUSES = ["draft", "open", "scheduled", "in_progress", "completed", "cancelled"] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];
export const WORK_ORDER_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  draft: "Draft",
  open: "Ready to schedule",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

/**
 * Versioned work order state machine. Each row records the version it was created under.
 * `open` means ready to schedule; `scheduled` follows its open visit; a visit that is not the
 * last returns the order to `open` ("another visit needed"). `completed` comes only from a
 * final field record or the office completing it with a reason.
 */
export const WORK_ORDER_STATE_MACHINE = {
  version: 1,
  transitions: {
    draft: ["open", "cancelled"],
    open: ["scheduled", "completed", "cancelled"],
    scheduled: ["open", "in_progress", "completed", "cancelled"],
    in_progress: ["open", "completed", "cancelled"],
    completed: [],
    cancelled: [],
  } satisfies Record<WorkOrderStatus, readonly WorkOrderStatus[]>,
} as const;

export function canTransitionWorkOrder(from: WorkOrderStatus, to: WorkOrderStatus): boolean {
  return (WORK_ORDER_STATE_MACHINE.transitions[from] as readonly WorkOrderStatus[]).includes(to);
}

export const WORK_ORDER_PRIORITIES = ["normal", "urgent"] as const;
export const WORK_BILLING_STATUSES = ["unbilled", "invoiced", "no_charge"] as const;
export const WORK_SOURCE_KINDS = ["office", "portal_request", "inspection_issue", "estimate", "contract_cycle"] as const;
export type WorkSourceKind = (typeof WORK_SOURCE_KINDS)[number];
export const WORK_NOTE_VISIBILITIES = ["internal", "customer"] as const;

/** Shown as WO-1001. */
export const workOrderLabel = (n: number) => `WO-${n}`;

/** The default kind of work for an inspection issue or a homeowner's request turned into a work order. */
export function workTypeKeyForIssue(type: (typeof ISSUE_TYPES)[number]): string {
  if (type === "pump_out") return "pumping";
  if (type === "repair_needed" || type === "part_replacement") return "repair";
  return "service_call";
}
export function workTypeKeyForRequest(kind: ServiceRequestKind): string {
  if (kind === "pumping") return "pumping";
  if (kind === "repair") return "repair";
  return "service_call";
}

const date = z.iso.date();
const datetime = z.iso.datetime({ offset: true });

// ---- Work types ----

export const workType = z.object({
  id,
  key: z.string(),
  name: z.string(),
  category: z.enum(WORK_CATEGORIES),
  defaultDurationMinutes: z.number().int().nullable(),
  requiresDisposalRecord: z.boolean(),
  active: z.boolean(),
  position: z.number().int(),
});
export type WorkType = z.infer<typeof workType>;

const workTypeName = z.string().trim().min(1).max(80);
export const workTypeInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lower-case letters, digits and underscores"),
  name: workTypeName,
  category: z.enum(WORK_CATEGORIES),
  defaultDurationMinutes: z.number().int().min(5).max(1440).nullish(),
  requiresDisposalRecord: z.boolean().default(false),
});
export const workTypeFields = z.object({
  name: workTypeName.optional(),
  defaultDurationMinutes: z.number().int().min(5).max(1440).nullish(),
  requiresDisposalRecord: z.boolean().optional(),
  active: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional(),
});

// ---- Lines ----

/** Quantities are kept in thousandths (fractional hours, gallons): at most three decimals. */
export const quantity = z
  .number()
  .positive()
  .max(1_000_000)
  .refine((q) => Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6, { message: "Use at most three decimals" });
export const toMilli = (q: number) => Math.round(q * 1000);

export const workOrderLineInput = z.object({
  description: z.string().trim().min(1).max(500),
  quantity,
  unitPriceCents: z.number().int().min(0).max(100_000_000),
  taxable: z.boolean().default(false),
});
export const workOrderLine = z.object({
  id,
  position: z.number().int(),
  description: z.string(),
  quantityMilli: z.number().int(),
  quantity: z.number(),
  unitPriceCents: z.number().int(),
  taxable: z.boolean(),
  source: z.enum(["planned", "added_in_field"]),
  amountCents: z.number().int(),
});

// ---- Work orders ----

const title = z.string().trim().min(1).max(200);
const description = z.string().trim().max(5000);

export const workOrderInput = z.object({
  siteId: id,
  workTypeId: id,
  title: title.optional(),
  description: description.default(""),
  priority: z.enum(WORK_ORDER_PRIORITIES).default("normal"),
  requestedOn: date.nullish(),
  /** Saved as a draft instead of ready to schedule. */
  draft: z.boolean().default(false),
  lines: z.array(workOrderLineInput).max(100).default([]),
});
export const workOrderFields = z.object({
  title: title.optional(),
  description: description.optional(),
  priority: z.enum(WORK_ORDER_PRIORITIES).optional(),
  requestedOn: date.nullish(),
  workTypeId: id.optional(),
  /** Moves a draft to ready to schedule. */
  ready: z.literal(true).optional(),
  /** Replaces the planned lines. */
  lines: z.array(workOrderLineInput).max(100).optional(),
  billingStatus: z.enum(["unbilled", "no_charge"]).optional(),
});
export const workOrderCancelInput = z.object({ reason: z.string().trim().min(1).max(2000) });
export const workOrderCompleteInput = z.object({ reason: z.string().trim().min(1).max(2000) });
export const workOrderScheduleInput = z.object({
  technicianId: id,
  scheduledDate: date,
  notes: z.string().trim().max(2000).nullish(),
});
export const workOrderNoteInput = z.object({
  body: z.string().trim().min(1).max(4000),
  visibility: z.enum(WORK_NOTE_VISIBILITIES).default("internal"),
});
/** Turning an inspection issue or a service request into a work order. Everything is optional. */
export const workOrderConvertInput = z.object({
  workTypeId: id.optional(),
  title: title.optional(),
  priority: z.enum(WORK_ORDER_PRIORITIES).optional(),
});

export const workOrderSummary = z.object({
  id,
  number: z.number().int(),
  label: z.string(),
  title: z.string(),
  category: z.enum(WORK_CATEGORIES),
  workType: z.object({ id, name: z.string() }),
  status: z.enum(WORK_ORDER_STATUSES),
  priority: z.enum(WORK_ORDER_PRIORITIES),
  billingStatus: z.enum(WORK_BILLING_STATUSES),
  sourceKind: z.enum(WORK_SOURCE_KINDS),
  sourceId: id.nullable(),
  requestedOn: date.nullable(),
  customer: z.object({ id, displayName: z.string() }),
  site: z.object({ id, addressLine1: z.string(), city: z.string() }),
  /** The open visit, if one is scheduled. */
  nextVisit: z.object({ jobId: id, scheduledDate: date, technicianId: id, technicianName: z.string(), status: z.string() }).nullable(),
  createdAt: datetime,
  completedAt: datetime.nullable(),
});
export type WorkOrderSummary = z.infer<typeof workOrderSummary>;

export const workOrderVisit = z.object({
  jobId: id,
  visitNumber: z.number().int(),
  status: z.string(),
  scheduledDate: date,
  technicianId: id,
  technicianName: z.string(),
  notes: z.string().nullable(),
  cancelReason: z.string().nullable(),
});
export const workOrderEvent = z.object({
  id,
  eventType: z.string(),
  summary: z.string(),
  occurredAt: datetime,
  actorName: z.string().nullable(),
  homeownerVisible: z.boolean(),
});
export const workOrderNote = z.object({ id, body: z.string(), visibility: z.enum(WORK_NOTE_VISIBILITIES), authorName: z.string().nullable(), createdAt: datetime });

export const workOrderDetail = workOrderSummary.extend({
  description: z.string(),
  stateMachineVersion: z.number().int(),
  completedWithoutRecordReason: z.string().nullable(),
  cancelledAt: datetime.nullable(),
  cancelReason: z.string().nullable(),
  createdByName: z.string().nullable(),
  /** Where the work came from, with a label the office can follow. */
  source: z.object({ kind: z.enum(WORK_SOURCE_KINDS), id: id.nullable(), label: z.string() }),
  lines: z.array(workOrderLine),
  linesTotalCents: z.number().int(),
  visits: z.array(workOrderVisit),
  events: z.array(workOrderEvent),
  notes: z.array(workOrderNote),
  invoices: z.array(z.object({ id, number: z.string().nullable(), status: z.string(), totalCents: z.number().int() })),
});
export type WorkOrderDetail = z.infer<typeof workOrderDetail>;

export const workOrderListQuery = z.object({
  status: z.enum(WORK_ORDER_STATUSES).optional(),
  /** Everything not completed or cancelled. */
  active: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  category: z.enum(WORK_CATEGORIES).optional(),
  siteId: id.optional(),
  customerId: id.optional(),
  technicianId: id.optional(),
  sourceKind: z.enum(WORK_SOURCE_KINDS).optional(),
  scheduledFrom: date.optional(),
  scheduledTo: date.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** A link from an inspection issue or service request to its work order, as the inbox shows it. */
export const workOrderLink = z.object({ id, label: z.string(), status: z.enum(WORK_ORDER_STATUSES) });
export type WorkOrderLink = z.infer<typeof workOrderLink>;
