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
  // v2: a rejected filing is resubmitted through pending, so it is checked again and gets
  // its own package before anything is sent.
  version: 2,
  transitions: {
    pending: ["ready", "needs_review"],
    ready: ["queued", "sent", "needs_review"],
    queued: ["submitting"],
    submitting: ["sent", "failed"],
    sent: ["confirmed", "rejected"],
    confirmed: [],
    failed: ["submitting", "queued", "ready"],
    rejected: ["queued", "ready", "pending"],
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

export const FILING_KINDS = ["inspection_report", "contract"] as const;
export type FilingKind = (typeof FILING_KINDS)[number];

/**
 * How far an authority's profile has been checked against its published sources.
 * - fictional: made up for development and tests; never loaded in production
 * - draft: written from official sources, but something a filing depends on is still
 *   unresolved; filings are prepared and checked, but a person releases each one
 * - verified: every requirement the profile uses is confirmed; may submit automatically
 */
export const PROFILE_STATUSES = ["fictional", "draft", "verified"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

/** Where a cover sheet field's value comes from. */
export const COVER_SHEET_SOURCES = [
  "submission_date",
  "provider_name",
  "responsible_provider_name",
  "responsible_provider_mp_number",
  "owner_name",
  "site_address",
  "site_permit_number",
  "contract_start",
  "contract_end",
  "inspections_per_year",
  "inspection_report_date",
  "identifier",
] as const;
export type CoverSheetSource = (typeof COVER_SHEET_SOURCES)[number];

/**
 * A jurisdiction's rules for one version. Stored as JSON in packages/compliance/rulesets
 * and copied into `jurisdiction_rulesets`; a published version never changes.
 */
export const rulesetRules = z.object({
  jurisdiction: z.object({
    key: z.string().regex(/^[a-z0-9-]{2,63}$/),
    state: z.string().length(2),
    authorityName: z.string().min(1).max(200),
    type: z.enum(["county", "city", "state", "district", "river_authority"]),
  }),
  version: z.number().int().min(1),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable().default(null),
  /** Where the rules came from. Placeholder rulesets must say they are not real. */
  sourceReference: z.string().min(1).max(1000),
  /**
   * What has been checked, against which official sources, and what is still open.
   * Required for every ruleset that is not fictional (enforced when bundled).
   */
  profile: z
    .object({
      status: z.enum(PROFILE_STATUSES),
      verifiedOn: isoDate,
      sources: z.array(z.object({ title: z.string().min(1), url: z.url(), retrievedOn: isoDate, note: z.string().optional() })).min(1),
      /** Requirements not yet confirmed. A verified profile has none. */
      unresolved: z.array(z.string().min(1)),
    })
    .optional(),
  applicability: z.object({
    /**
     * County names (as entered on sites) this authority covers, compared case-insensitively.
     * With `assignment: "reviewed"` these are counties the authority covers only part of.
     */
    counties: z.array(z.string().min(1).max(100)).min(1),
    /**
     * `county` (the default): every site in those counties reports here. `reviewed`: the
     * authority's area follows other boundaries (a watershed, city limits), so a site is
     * never matched by county alone; a person assigns it with evidence, and a county match
     * to another authority in the same county goes to review instead.
     */
    assignment: z.enum(["county", "reviewed"]).optional(),
    /** How a person decides whether a site is inside (a map, a phone number). */
    howToDecide: z.string().max(1000).optional(),
  }),
  /** Numbers the authority gives a property, which its filings must carry. */
  identifiers: z
    .array(
      z.object({
        key: fieldKey,
        label: z.string().min(1).max(100),
        required: z.boolean(),
        /** A regular expression the value must match, when the authority's format is known. */
        pattern: z.string().optional(),
        help: z.string().max(500).optional(),
      }),
    )
    .optional(),
  /**
   * Credentials the authority needs on record: the licensed maintenance provider responsible
   * for the filing, and (for inspection reports) an active MP license or maintenance
   * technician registration held by whoever did the inspection, on the inspection date.
   */
  provider: z.object({ responsibleProviderRequired: z.boolean(), technicianCredentialRequired: z.boolean().optional() }).optional(),
  /**
   * Whether the authority has said how inspection reports reach it. `unknown` holds every
   * inspection filing in review: nothing is sent to a guessed address.
   */
  inspectionReports: z.object({ submission: z.enum(["supported", "unknown"]), note: z.string().max(1000).optional() }).optional(),
  /** Whether signed maintenance contracts are filed with the authority, and by when. */
  contracts: z
    .object({
      filingRequired: z.boolean(),
      /** Deadline for a renewal: this many days before the previous contract ends. */
      renewalDaysBeforePreviousEnd: z.number().int().min(0).max(365).nullable(),
      note: z.string().max(1000).optional(),
    })
    .optional(),
  /** The authority's cover sheet, sent as the first document of a package. */
  coverSheet: z
    .object({
      title: z.string().min(1).max(200),
      /** The official form this reproduces, and whether its layout has been matched. */
      formReference: z.string().min(1).max(500),
      appliesTo: z.array(z.enum(FILING_KINDS)).min(1),
      fields: z
        .array(
          z.object({
            label: z.string().min(1).max(100),
            source: z.enum(COVER_SHEET_SOURCES),
            /** For `identifier`: which identifier key. */
            identifier: fieldKey.optional(),
            required: z.boolean(),
          }),
        )
        .min(1),
      instructions: z.string().max(500).optional(),
    })
    .optional(),
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
    /**
     * Subjects may use {permitNumber}, {address} and {identifier:<key>}. Contracts use
     * `contractSubject` when given.
     */
    email: z.object({ to: z.email(), subject: z.string().min(1).max(200), contractSubject: z.string().min(1).max(200).optional() }).optional(),
    /** Used when the primary method fails or the office chooses to file by hand. */
    fallback: z.literal("manual_export").nullable().default("manual_export"),
    portalUrl: z.url().nullable().default(null),
  }),
  customerCopy: z.object({ required: z.boolean() }),
  confirmation: z.object({
    /**
     * `manual_reference`: the authority sends something back and the office records it.
     * `none_published`: the authority publishes no acknowledgment; "sent" is as far as a
     * filing can be shown to have gone unless the office records evidence it received.
     */
    mode: z.enum(["manual_reference", "none_published"]),
    note: z.string().max(1000).optional(),
  }),
});
export type RulesetRules = z.infer<typeof rulesetRules>;

/** A ruleset without a profile predates profiles and is the fictional example. */
export const profileStatus = (rules: RulesetRules): ProfileStatus => rules.profile?.status ?? "fictional";

/**
 * Automatic submission only for verified profiles, and for fictional ones (which only
 * ever exist outside production and send to `.example` addresses). A draft profile's
 * filings wait for a person to release them, whatever `autoSubmit` says.
 */
export const mayAutoSubmit = (rules: RulesetRules) => rules.filing.autoSubmit && profileStatus(rules) !== "draft";

export const contractFilingRequired = (rules: RulesetRules) => rules.contracts?.filingRequired === true;

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
  /** `reviewed`: a site is never matched by county alone; a person assigns it with evidence. */
  assignment: z.enum(["county", "reviewed"]),
  profileStatus: z.enum(PROFILE_STATUSES),
});
export type Jurisdiction = z.infer<typeof jurisdiction>;

export const AUTHORITY_EVIDENCE_KINDS = ["authority_map", "authority_determination", "permit_record", "other"] as const;
export const AUTHORITY_EVIDENCE_LABELS: Record<(typeof AUTHORITY_EVIDENCE_KINDS)[number], string> = {
  authority_map: "Authority's own map lookup",
  authority_determination: "Determination from the authority (call, email, letter)",
  permit_record: "Permit or authority record",
  other: "Other",
};

export const authorityIdentifierStatus = z.object({
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
  value: z.string().nullable(),
  help: z.string().nullable(),
  /** Set when the value is missing (and required) or does not match the authority's format. */
  problem: z.string().nullable(),
});

export const siteJurisdiction = z.object({
  /** How the site got its authority: set by hand, matched from the county, or none. */
  source: z.enum(["override", "county", "none"]),
  jurisdiction: jurisdiction.nullable(),
  /** Why no authority was chosen, when none was. */
  reviewReason: z.string().nullable(),
  /** Authorities that may cover this site and need a person to decide. */
  candidates: z.array(jurisdiction),
  /** The evidence behind a hand-picked authority. */
  assignment: z
    .object({
      evidenceKind: z.enum(AUTHORITY_EVIDENCE_KINDS),
      evidenceReference: z.string(),
      evidenceNote: z.string().nullable(),
      assignedAt: z.iso.datetime({ offset: true }),
      assignedBy: z.string().nullable(),
    })
    .nullable(),
  profile: z.object({ status: z.enum(PROFILE_STATUSES), unresolved: z.array(z.string()), howToDecide: z.string().nullable() }).nullable(),
  identifiers: z.array(authorityIdentifierStatus),
});
export type SiteJurisdiction = z.infer<typeof siteJurisdiction>;

export const siteJurisdictionInput = z
  .object({
    jurisdictionId: id.nullable(),
    evidenceKind: z.enum(AUTHORITY_EVIDENCE_KINDS).nullish(),
    evidenceReference: z.string().trim().min(1).max(500).nullish(),
    evidenceNote: z.string().trim().max(2000).nullish(),
  })
  .refine((v) => v.jurisdictionId === null || (v.evidenceKind && v.evidenceReference), {
    message: "Choosing an authority by hand needs the evidence it is based on (evidenceKind and evidenceReference)",
  });

export const siteIdentifierInput = z.object({
  jurisdictionId: id,
  value: z.string().trim().min(1).max(100).nullable(),
  sourceNote: z.string().trim().max(500).nullish(),
});

export const filingProof = z.object({
  /** Evidence the filing left us. It is never evidence the authority received it. */
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
  kind: z.enum(FILING_KINDS),
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
  inspection: z.object({ id, completedAt: z.iso.datetime({ offset: true }).nullable() }).nullable(),
  contract: z.object({ id, startOn: isoDate, endOn: isoDate, planName: z.string() }).nullable(),
  deadlineBasis: z.string().nullable(),
  site: z.object({ id, addressLine1: z.string(), city: z.string(), permitNumber: z.string().nullable() }),
  customer: z.object({ id, displayName: z.string() }),
  jurisdiction: z.object({ key: z.string(), authorityName: z.string(), rulesetVersion: z.number().int() }).nullable(),
});
export type FilingListItem = z.infer<typeof filingListItem>;

export const filingAttempt = z.object({
  attemptNo: z.number().int(),
  recipient: z.string().nullable(),
  packageId: id.nullable(),
  /** What the mail provider (or the office) said. Accepted by a provider is not received by the authority. */
  response: z.record(z.string(), z.unknown()),
  submissionNo: z.number().int(),
  method: z.enum(SUBMISSION_METHODS),
  status: z.enum(["started", "succeeded", "failed"]),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  error: z.string().nullable(),
});

export const CONFIRMATION_EVIDENCE_KINDS = ["authority_email_reply", "portal_confirmation", "phone_call", "letter", "other"] as const;

export const confirmationEvidence = z.object({
  kind: z.enum(CONFIRMATION_EVIDENCE_KINDS),
  receivedOn: isoDate,
  from: z.string().nullable(),
});

export const packageDocument = z.object({
  role: z.enum(["cover_sheet", "inspection_report", "contract"]),
  filename: z.string(),
  storageKey: z.string(),
  contentType: z.string(),
  sha256: z.string(),
  byteSize: z.number().int(),
  /** The report or signed document it was drawn from. */
  sourceId: z.string().nullable(),
  sourceVersion: z.number().int().nullable(),
});
export type PackageDocument = z.infer<typeof packageDocument>;

export const submissionPackage = z.object({
  id,
  submissionNo: z.number().int(),
  method: z.enum(SUBMISSION_METHODS),
  recipient: z.string().nullable(),
  subject: z.string(),
  body: z.string(),
  fields: z.array(z.object({ label: z.string(), value: z.string().nullable(), required: z.boolean() })),
  documents: z.array(packageDocument.omit({ storageKey: true }).extend({ url: z.string() })),
  manifestSha256: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type SubmissionPackage = z.infer<typeof submissionPackage>;

export const filingDetail = filingListItem.extend({
  stateMachineVersion: z.number().int(),
  submissionNo: z.number().int(),
  methodVersion: z.string().nullable(),
  templateId: id.nullable(),
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
  /** Every package made for this filing, newest first. Each is exactly what was (or will be) sent. */
  packages: z.array(submissionPackage),
  confirmationEvidence: confirmationEvidence.nullable(),
  profile: z.object({ status: z.enum(PROFILE_STATUSES), unresolved: z.array(z.string()), confirmationMode: z.enum(["manual_reference", "none_published"]), confirmationNote: z.string().nullable() }).nullable(),
  /** Report versions for an inspection filing, newest first; corrections link to what they replace. */
  reports: z.array(z.object({ id, version: z.number().int(), sha256: z.string(), supersedesReportId: id.nullable(), correctionReason: z.string().nullable(), generatedAt: z.iso.datetime({ offset: true }) })),
});
export type FilingDetail = z.infer<typeof filingDetail>;

const note = z.string().trim().max(2000).nullish();

export const filingConfirmInput = z.object({
  reference: z.string().trim().min(1).max(200),
  note,
  /** What showed the authority received it. Optional for compatibility; the screen asks for it. */
  evidence: confirmationEvidence.partial({ from: true }).nullish(),
});
export const filingCorrectInput = z.object({
  reason: z.string().trim().min(1).max(2000),
  /** Corrected answers, by template field key. Everything else is carried over unchanged. */
  amendments: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});
export const filingRejectInput = z.object({ reason: z.string().trim().min(1).max(2000) });
export const filingManualSentInput = z.object({ reference: z.string().trim().max(200).nullish(), note });
