import { z } from "zod";
import { id } from "./crm.ts";
import type { TemplateDefinition } from "./inspections.ts";
import { addDays } from "./schedule.ts";

// Filing an inspection with the authority that requires it. What each authority wants is
// data (a versioned ruleset); how a filing moves is the state machine below.

export const FILING_STATUSES = ["pending", "ready", "queued", "submitting", "sent", "confirmed", "failed", "rejected", "needs_review"] as const;
export type FilingStatus = (typeof FILING_STATUSES)[number];

/**
 * Versioned filing state machine (COMPLIANCE-ENGINE.md). Each filing stores the version it
 * was created under. `sent` means the authority was sent the report; only `confirmed`
 * means the authority acknowledged it. The two are never merged.
 *
 * - pending: waiting for the authority report to be made
 * - ready: report made and checked; can be submitted
 * - queued / submitting: an automatic submission is waiting for, or held by, the worker
 * - failed: the last automatic attempt failed; the worker retries, then the office can
 * - rejected: the authority refused it; fix and resubmit
 * - needs_review: something only a person can settle (no authority matched, a required
 *   answer is missing)
 */
export const FILING_STATE_MACHINE = {
  version: 1,
  transitions: {
    pending: ["ready", "needs_review"],
    ready: ["queued", "sent", "needs_review"],
    queued: ["submitting"],
    submitting: ["sent", "failed"],
    sent: ["confirmed", "rejected"],
    confirmed: [],
    failed: ["submitting", "queued", "ready"],
    rejected: ["queued", "ready"],
    needs_review: ["pending", "ready", "needs_review"],
  } satisfies Record<FilingStatus, readonly FilingStatus[]>,
} as const;

export function canTransitionFiling(from: FilingStatus, to: FilingStatus): boolean {
  return (FILING_STATE_MACHINE.transitions[from] as readonly FilingStatus[]).includes(to);
}

/** Statuses where the filing still has to reach the authority, so its deadline matters. */
export const FILING_OPEN_STATUSES: readonly FilingStatus[] = ["pending", "ready", "queued", "submitting", "failed", "rejected", "needs_review"];
/** Statuses that need a person. */
export const FILING_ATTENTION_STATUSES: readonly FilingStatus[] = ["failed", "rejected", "needs_review"];

export const SUBMISSION_METHODS = ["email", "manual_export"] as const;
export type SubmissionMethod = (typeof SUBMISSION_METHODS)[number];

const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const isoDate = z.iso.date();

/**
 * A jurisdiction's rules for one version. Stored as JSON in packages/compliance/rulesets
 * and copied into `jurisdiction_rulesets`; a published version never changes.
 */
export const rulesetRules = z.object({
  jurisdiction: z.object({
    key: z.string().regex(/^[a-z0-9-]{2,63}$/),
    state: z.string().length(2),
    authorityName: z.string().min(1).max(200),
    type: z.enum(["county", "city", "state", "district"]),
  }),
  version: z.number().int().min(1),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable().default(null),
  /** Where the rules came from. Placeholder rulesets must say they are not real. */
  sourceReference: z.string().min(1).max(1000),
  applicability: z.object({
    /** County names (as entered on sites) this authority covers, compared case-insensitively. */
    counties: z.array(z.string().min(1).max(100)).min(1),
  }),
  service: z.object({
    /** The authority's maximum time between inspections. */
    intervalMonths: z.number().int().min(1).max(24),
  }),
  inspection: z.object({
    /** Template fields the authority requires an answer for, on top of the template's own rules. */
    requiredFields: z.array(fieldKey).default([]),
    /** Minimum photos per template photo key. A list, not a map: jsonb keys would be camel-cased on read. */
    requiredPhotos: z.array(z.object({ key: fieldKey, minCount: z.number().int().min(1).max(20) })).default([]),
    technicianLicenseRequired: z.boolean().default(false),
  }),
  filing: z.object({
    /** Days after the inspection the report must reach the authority. */
    deadlineDays: z.number().int().min(1).max(365),
    /** Show a deadline warning this many days before the deadline. */
    warningDays: z.number().int().min(0).max(365),
    /** Submit automatically once the report is made, or wait for the office. */
    autoSubmit: z.boolean().default(true),
  }),
  submission: z.object({
    method: z.enum(SUBMISSION_METHODS),
    email: z.object({ to: z.email(), subject: z.string().min(1).max(200) }).optional(),
    /** Used when the primary method fails or the office chooses to file by hand. */
    fallback: z.literal("manual_export").nullable().default("manual_export"),
    portalUrl: z.url().nullable().default(null),
  }),
  customerCopy: z.object({ required: z.boolean() }),
  confirmation: z.object({
    /** How confirmation arrives: the office records the authority's reference by hand. */
    mode: z.literal("manual_reference"),
  }),
});
export type RulesetRules = z.infer<typeof rulesetRules>;

/** What a jurisdiction adds to an inspection, as sent to the technician's phone. */
export const inspectionRequirements = z.object({
  jurisdictionKey: z.string(),
  authorityName: z.string(),
  rulesetVersion: z.number().int(),
  requiredFields: z.array(z.string()),
  requiredPhotos: z.array(z.object({ key: z.string(), minCount: z.number().int() })),
});
export type InspectionRequirements = z.infer<typeof inspectionRequirements>;

/**
 * The template with a jurisdiction's requirements layered on: listed fields become
 * required and photo minimums are raised. Conditional fields stay conditional, so a
 * chlorine reading is still only asked for when there is a chlorinator.
 */
export function applyRequirements(def: TemplateDefinition, req: Pick<InspectionRequirements, "requiredFields" | "requiredPhotos"> | null | undefined): TemplateDefinition {
  if (!req) return def;
  const fields = new Set(req.requiredFields);
  return {
    fields: def.fields.map((f) => (fields.has(f.key) && !f.required ? { ...f, required: true } : f)),
    photos: def.photos.map((p) => {
      const min = req.requiredPhotos.find((r) => r.key === p.key)?.minCount;
      return min !== undefined && min > p.minCount ? { ...p, minCount: min } : p;
    }),
  };
}

export type DeadlineState = "ok" | "approaching" | "overdue" | "met";

/** Where a filing stands against its deadline, on the organization's "today". */
export function deadlineState(status: FilingStatus, deadlineOn: string | null, warningDays: number, today: string): DeadlineState {
  if (!FILING_OPEN_STATUSES.includes(status)) return "met";
  if (!deadlineOn) return "ok";
  if (today > deadlineOn) return "overdue";
  if (today >= addDays(deadlineOn, -warningDays)) return "approaching";
  return "ok";
}

// API shapes.

export const jurisdiction = z.object({
  id,
  key: z.string(),
  state: z.string(),
  authorityName: z.string(),
  type: z.string(),
  rulesetVersion: z.number().int().nullable(),
  counties: z.array(z.string()),
});
export type Jurisdiction = z.infer<typeof jurisdiction>;

export const siteJurisdiction = z.object({
  /** How the site got its authority: set by hand, matched from the county, or none. */
  source: z.enum(["override", "county", "none"]),
  jurisdiction: jurisdiction.nullable(),
});
export type SiteJurisdiction = z.infer<typeof siteJurisdiction>;

export const siteJurisdictionInput = z.object({ jurisdictionId: id.nullable() });

export const filingProof = z.object({
  kind: z.enum(["email_message_id", "manual_submission"]),
  /** The email Message-ID, or the portal reference the office typed in. */
  reference: z.string().nullable(),
  at: z.iso.datetime({ offset: true }),
  note: z.string().nullable().optional(),
  by: z.string().nullable().optional(),
});
export type FilingProof = z.infer<typeof filingProof>;

export const filingListItem = z.object({
  id,
  status: z.enum(FILING_STATUSES),
  submissionMethod: z.enum(SUBMISSION_METHODS).nullable(),
  deadlineOn: isoDate.nullable(),
  deadlineState: z.enum(["ok", "approaching", "overdue", "met"]),
  nextDueOn: isoDate.nullable(),
  sentAt: z.iso.datetime({ offset: true }).nullable(),
  confirmedAt: z.iso.datetime({ offset: true }).nullable(),
  confirmationReference: z.string().nullable(),
  reviewReason: z.string().nullable(),
  lastError: z.string().nullable(),
  attemptCount: z.number().int(),
  inspection: z.object({ id, completedAt: z.iso.datetime({ offset: true }).nullable() }),
  site: z.object({ id, addressLine1: z.string(), city: z.string(), permitNumber: z.string().nullable() }),
  customer: z.object({ id, displayName: z.string() }),
  jurisdiction: z.object({ key: z.string(), authorityName: z.string(), rulesetVersion: z.number().int() }).nullable(),
});
export type FilingListItem = z.infer<typeof filingListItem>;

export const filingAttempt = z.object({
  attemptNo: z.number().int(),
  submissionNo: z.number().int(),
  method: z.enum(SUBMISSION_METHODS),
  status: z.enum(["started", "succeeded", "failed"]),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  error: z.string().nullable(),
});

export const filingDetail = filingListItem.extend({
  stateMachineVersion: z.number().int(),
  submissionNo: z.number().int(),
  methodVersion: z.string().nullable(),
  templateId: id,
  proof: filingProof.nullable(),
  confirmationNote: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  /** What a manual filer needs: where to send it, and a short-lived link to the report. */
  package: z
    .object({
      destination: z.string().nullable(),
      portalUrl: z.string().nullable(),
      subject: z.string().nullable(),
      reportUrl: z.string().nullable(),
      fallback: z.enum(SUBMISSION_METHODS).nullable(),
    })
    .nullable(),
  attempts: z.array(filingAttempt),
});
export type FilingDetail = z.infer<typeof filingDetail>;

const note = z.string().trim().max(2000).nullish();

export const filingConfirmInput = z.object({ reference: z.string().trim().min(1).max(200), note });
export const filingRejectInput = z.object({ reason: z.string().trim().min(1).max(2000) });
export const filingManualSentInput = z.object({ reference: z.string().trim().max(200).nullish(), note });
