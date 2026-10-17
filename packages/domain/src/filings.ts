import { z } from "zod";
import { locationStatus } from "./inspections.ts";
import { id, SITE_USE_CATEGORIES, SITE_USE_CATEGORY_LABELS, type SiteUseCategory } from "./crm.ts";
import type { TemplateDefinition } from "./inspections.ts";
import { labTestRule, type LabTestRule } from "./lab-tests.ts";
import { monitoredServiceRule } from "./monitoring.ts";
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
    // ready -> pending: its package went stale before sending (complaint responses changed).
    ready: ["queued", "sent", "needs_review", "pending"],
    // queued -> ready: the send task refused a submission nobody asked for (draft profile).
    queued: ["submitting", "ready"],
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

/**
 * - email: Aerowise emails the package
 * - manual_export: the office files the package by hand (portal, mail or counter)
 * - csv_export: the package carries a CSV in the authority's own column layout (its ruleset's
 *   `export` block) for the office to upload; making the file never makes the filing sent
 */
export const SUBMISSION_METHODS = ["email", "manual_export", "csv_export"] as const;
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

export const VERIFICATION_METHODS = ["email", "phone", "meeting", "letter"] as const;

/**
 * Who confirmed a ruleset version with the authority, when and how. A version is verified
 * only with this record, and a draft or fictional one never has it. It lives in the
 * versioned ruleset file, so it is reviewed like the rules it vouches for and cannot change
 * after publishing.
 */
export const verificationRecord = z.object({
  /** The person or office at the authority who confirmed it (name and title, or the office). */
  confirmedWith: z.string().min(1).max(200),
  /** Who asked the authority and recorded the answer. */
  confirmedBy: z.string().min(1).max(200),
  confirmedOn: isoDate,
  method: z.enum(VERIFICATION_METHODS),
  /** Where the confirmation is kept (an email's subject and date, a letter's reference, call notes). */
  evidence: z.string().min(1).max(1000),
});
export type VerificationRecord = z.infer<typeof verificationRecord>;

/**
 * The authority's own layout for its copy of the inspection report: its title, and which
 * answers go in which section, in order, under the authority's wording. Answers it does
 * not list are left off its copy (the customer copy is unaffected).
 */
export const reportLayoutRule = z.object({
  title: z.string().min(1).max(200),
  /** The authority form or page this layout follows, and how closely. */
  formReference: z.string().min(1).max(500),
  sections: z
    .array(
      z.object({
        title: z.string().min(1).max(100),
        fields: z.array(z.object({ key: fieldKey, label: z.string().min(1).max(200).optional() })).min(1),
      }),
    )
    .min(1),
});
export type ReportLayoutRule = z.infer<typeof reportLayoutRule>;

/** Where an authority CSV column's value comes from. */
export const AUTHORITY_EXPORT_SOURCES = [
  "filing_id",
  "submission_number",
  "submission_date",
  "inspection_date",
  "technician_name",
  "technician_license",
  /** One inspection answer, by template field key (`field`), as on the authority report version in the package. */
  "field",
  "owner_name",
  "site_address_line1",
  "site_city",
  "site_state",
  "site_postal_code",
  "site_county",
  "site_permit_number",
  /** An authority identifier recorded on the site (`identifier`). */
  "identifier",
  "provider_name",
  "responsible_provider_name",
  "responsible_provider_mp_number",
  /** The same text on every row (`value`), such as a record type code. */
  "constant",
] as const;
export type AuthorityExportSource = (typeof AUTHORITY_EXPORT_SOURCES)[number];

/**
 * The authority's own CSV layout for filings, one row per filing. Only a ruleset whose
 * layout comes from the authority's accepted specification and an accepted sample (gate
 * G-AUTH-CSV) may carry one; until then only the fictional example does (enforced when
 * bundled). Making the file is not filing it: the office uploads it and records that.
 */
export const authorityExportRule = z
  .object({
    format: z.literal("csv"),
    /** The specification this layout follows, and how closely. */
    formReference: z.string().min(1).max(500),
    appliesTo: z.array(z.enum(FILING_KINDS)).min(1),
    /** `utf-8-bom` starts the file with a byte order mark, which some spreadsheet imports expect. */
    encoding: z.enum(["utf-8", "utf-8-bom"]),
    dateFormat: z.enum(["YYYY-MM-DD", "MM/DD/YYYY"]),
    /** May use {permitNumber}, {inspectionDate}, {submissionDate} and {filingId}; ends in .csv. */
    filename: z
      .string()
      .min(5)
      .max(120)
      .regex(/^[A-Za-z0-9_{}-]+\.csv$/),
    columns: z
      .array(
        z.object({
          header: z.string().min(1).max(100),
          source: z.enum(AUTHORITY_EXPORT_SOURCES),
          field: fieldKey.optional(),
          identifier: fieldKey.optional(),
          value: z.string().max(200).optional(),
          /** A filing whose required column has no value waits for review instead of exporting a gap. */
          required: z.boolean(),
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((e, ctx) => {
    const headers = new Set<string>();
    e.columns.forEach((c, i) => {
      if (headers.has(c.header)) ctx.addIssue({ code: "custom", path: ["columns", i, "header"], message: `Column "${c.header}" appears twice` });
      headers.add(c.header);
      if ((c.source === "field") !== (c.field !== undefined)) ctx.addIssue({ code: "custom", path: ["columns", i, "field"], message: "`field` goes with, and only with, the field source" });
      if ((c.source === "identifier") !== (c.identifier !== undefined)) ctx.addIssue({ code: "custom", path: ["columns", i, "identifier"], message: "`identifier` goes with, and only with, the identifier source" });
      if ((c.source === "constant") !== (c.value !== undefined)) ctx.addIssue({ code: "custom", path: ["columns", i, "value"], message: "`value` goes with, and only with, the constant source" });
    });
  });
export type AuthorityExportRule = z.infer<typeof authorityExportRule>;

/** One kind of filing's fees, in cents. */
const feeRule = z.object({
  filingCents: z.number().int().min(0).max(1_000_000),
  /** Charged on top when the filing reaches the authority after its deadline. */
  lateCents: z.number().int().min(0).max(1_000_000).default(0),
});

/**
 * What the authority charges per filing, and for a late one. Recorded on each filing when
 * it opens, so a later fee schedule never changes what an earlier filing owed.
 */
export const feeScheduleRule = z.object({
  inspectionReport: feeRule.optional(),
  contract: feeRule.optional(),
  /** Where the amounts come from (the fee schedule and its date). */
  basis: z.string().min(1).max(500),
});
export type FeeScheduleRule = z.infer<typeof feeScheduleRule>;

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
  /**
   * When Aerowise starts applying this ruleset version (inspections and contracts dated
   * from then use it). For real authorities this is not a claim about when the law took
   * effect: that is `profile.requirementEffective`.
   */
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
      /** When someone last read the sources below. Not an effective date. */
      sourcesCheckedOn: isoDate,
      /** When the authority's requirement took legal effect, with the evidence; null date when unpublished. */
      requirementEffective: z.object({ date: isoDate.nullable(), basis: z.string().min(1).max(500) }),
      sources: z.array(z.object({ title: z.string().min(1), url: z.url(), retrievedOn: isoDate, note: z.string().optional() })).min(1),
      /** Requirements not yet confirmed. A verified profile has none. */
      unresolved: z.array(z.string().min(1)),
      /** Required for, and only for, a verified profile. */
      verification: verificationRecord.optional(),
    })
    .superRefine((p, ctx) => {
      if (p.status === "verified" && !p.verification) ctx.addIssue({ code: "custom", path: ["verification"], message: "A verified profile needs who confirmed it with the authority, when and how" });
      if (p.status !== "verified" && p.verification) ctx.addIssue({ code: "custom", path: ["verification"], message: "Only a verified profile has a verification record" });
      if (p.status === "verified" && p.unresolved.length > 0) ctx.addIssue({ code: "custom", path: ["unresolved"], message: "A verified profile has no unresolved requirements" });
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
  provider: z
    .object({
      responsibleProviderRequired: z.boolean(),
      technicianCredentialRequired: z.boolean().optional(),
      /**
       * The authority's own registration of maintenance providers, on top of the TCEQ
       * license (Hays: yearly, ending December 31). Aerowise shows it; it does not yet track
       * each company's registration.
       */
      countyRegistration: z.object({ required: z.literal(true), renews: z.string().max(200), note: z.string().max(1000) }).optional(),
    })
    .optional(),
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
      /**
       * Whether the authority has said how contracts reach it. `unknown` holds every contract
       * filing in review, even where reports have a published email: nothing is sent to it.
       */
      submission: z.enum(["supported", "unknown"]).optional(),
      /**
       * A renewal with the same provider is not accepted until every report from the
       * previous term has been submitted (Hays 10.V.6): such a filing is held until they are sent.
       */
      renewalNeedsPriorReports: z.boolean().optional(),
      /**
       * The least a contract taken over from another provider may cover (Hays 10.V.2: at
       * least a year and four inspections, counting the first).
       */
      newProviderMinimum: z.object({ termMonths: z.number().int().min(1).max(60), visits: z.number().int().min(1).max(60) }).optional(),
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
            /** With `officialForm`: the name of the form's own field this value goes in. */
            formField: z.string().min(1).max(200).optional(),
          }),
        )
        .min(1),
      instructions: z.string().max(500).optional(),
      /**
       * The authority's own fillable PDF, kept in packages/compliance/forms, pinned by hash.
       * When set, the package carries that form filled in; otherwise Aerowise draws a sheet
       * with the same fields.
       */
      officialForm: z
        .object({
          file: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+\.pdf$/),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          obtainedOn: isoDate,
          obtainedFrom: z.string().min(1).max(500),
        })
        .optional(),
    })
    .optional(),
  service: z.object({
    /**
     * The authority's maximum time between inspections: 4 for the TCEQ default, 3 for
     * quarterly. Contract visit windows are never longer than this.
     */
    intervalMonths: z.number().int().min(1).max(24),
    /** A shorter maximum for commercial systems (1 for monthly), where the authority sets one. */
    commercialIntervalMonths: z.number().int().min(1).max(24).optional(),
    /**
     * A longer maximum (6 months) the authority allows for systems with qualifying
     * electronic monitoring on record. Absent: monitoring changes nothing.
     */
    monitored: monitoredServiceRule.optional(),
    /**
     * Visits counted from the contract instead of split evenly across it (Hays 10.V.2): the
     * first within `firstWithinDays` of the start, the next every `intervalMonths` from the
     * start, and the last in the `lastWithinDaysOfEnd` days before the end.
     */
    contractVisits: z
      .object({
        firstWithinDays: z.number().int().min(1).max(90),
        lastWithinDaysOfEnd: z.number().int().min(1).max(90),
        note: z.string().max(1000),
        /** How Aerowise reads wording the authority has not confirmed, shown to the office with the schedule. */
        unconfirmed: z.string().max(500).optional(),
      })
      .optional(),
    /**
     * A report showing low chlorine or a system not working needs a fix, a retest and a new
     * report within this many days of that report (Hays 10.V.4). The extra report never moves
     * the regular visits.
     */
    correctiveReport: z.object({ withinDays: z.number().int().min(1).max(90), note: z.string().max(1000) }).optional(),
    /**
     * The authority lets a site's permit set the interval instead ("unless otherwise specified
     * on the permit"). A site's recorded permit interval then replaces `intervalMonths` and
     * any monitoring allowance.
     */
    permitOverride: z.object({ note: z.string().max(1000) }).optional(),
    /**
     * A different initial-term schedule for some uses, from a source the authority has not
     * confirmed still controls (Montgomery's food establishment contract form, rev. 2009).
     * It is never applied by itself: a site in one of these categories uses the interval the
     * office recorded from its own current contract or permit (`permitIntervalMonths`), and
     * until one is recorded its filings are held with `unconfirmed` as the reason.
     * `renewalIntervalMonths` null: the authority publishes nothing for later terms.
     */
    categoryTerms: z
      .array(
        z.object({
          useCategories: z.array(z.enum(SITE_USE_CATEGORIES)).min(1),
          initialTermMonths: z.number().int().min(1).max(60),
          initialIntervalMonths: z.number().int().min(1).max(24),
          renewalIntervalMonths: z.number().int().min(1).max(24).nullable(),
          source: z.string().max(1000),
          unconfirmed: z.string().max(1000),
        }),
      )
      .optional(),
  }),
  /** Lab tests the authority requires on a schedule, such as annual BOD and TSS. */
  labTests: labTestRule.optional(),
  /** The authority copy's layout. Absent: the template's own sections. */
  report: reportLayoutRule.optional(),
  /** Filing and late fees. Absent: the authority charges none, or it is not known. */
  fees: feeScheduleRule.optional(),
  inspection: z.object({
    /** Template fields the authority requires an answer for, on top of the template's own rules. */
    requiredFields: z.array(fieldKey).default([]),
    /**
     * Fields the authority requires only at some kinds of site (Travis §448.034(a) scopes its
     * report contents to single-family systems). Added to `requiredFields` for a site of a
     * listed type.
     */
    scopedRequiredFields: z
      .array(z.object({ appliesTo: z.array(z.enum(["residential", "commercial"])).min(1), fields: z.array(fieldKey).min(1), note: z.string().max(1000) }))
      .optional(),
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
  /** The authority's CSV layout, for filings by CSV export. Absent: no CSV export. */
  export: authorityExportRule.optional(),
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
}).superRefine((r, ctx) => {
  if (r.submission.method !== "csv_export") return;
  // Filing by CSV needs the layout, for every kind of filing the authority takes.
  const kinds: FilingKind[] = ["inspection_report", ...(r.contracts?.filingRequired ? (["contract"] as const) : [])];
  const missing = kinds.filter((k) => !r.export?.appliesTo.includes(k));
  if (missing.length) ctx.addIssue({ code: "custom", path: ["export"], message: `Filing by CSV export needs an export layout for ${missing.join(" and ")} filings` });
});
export type RulesetRules = z.infer<typeof rulesetRules>;

/** The authority's CSV layout for this kind of filing, or null when it takes none. */
export const exportLayoutFor = (rules: RulesetRules, kind: FilingKind) => (rules.export?.appliesTo.includes(kind) ? rules.export : null);

/** A ruleset without a profile predates profiles and is the fictional example. */
export const profileStatus = (rules: RulesetRules): ProfileStatus => rules.profile?.status ?? "fictional";

/**
 * Automatic submission only for verified profiles, and for fictional ones (which only
 * ever exist outside production and send to `.example` addresses). A draft profile's
 * filings wait for a person to release them, whatever `autoSubmit` says. Either way an
 * inspection report goes on its own only once the maintenance provider signed the version it
 * sends (the compliance engine checks the signature; 30 TAC 285.7(b)(3)).
 */
export const mayAutoSubmit = (rules: RulesetRules) => rules.filing.autoSubmit && (profileStatus(rules) === "fictional" || verifiedWith(rules) !== null);

/**
 * "Verified with <authority> on <date>": set only for a verified profile with its
 * verification record; null for drafts, fictional rules and rules without a profile.
 */
export function verifiedWith(rules: RulesetRules) {
  const v = rules.profile?.status === "verified" ? rules.profile.verification : undefined;
  return v ? { authorityName: rules.jurisdiction.authorityName, confirmedOn: v.confirmedOn, confirmedWith: v.confirmedWith, method: v.method } : null;
}

/**
 * The longest the authority allows between inspections of a residential or commercial
 * system, and of one with qualifying electronic monitoring on record where the authority
 * allows longer for those, or the site's permit interval where the authority defers to the permit.
 */
export function serviceIntervalMonths(
  rules: RulesetRules,
  customerType: "residential" | "commercial",
  monitored = false,
  permitIntervalMonths: number | null = null,
  useCategory: SiteUseCategory | null = null,
) {
  // Where the authority lets the permit decide, a recorded permit interval is the rule.
  if (rules.service.permitOverride && permitIntervalMonths) return permitIntervalMonths;
  // A site whose use has its own term uses the interval recorded from its own contract or permit.
  if (permitIntervalMonths && categoryTermFor(rules, useCategory)) return permitIntervalMonths;
  const base = (customerType === "commercial" ? rules.service.commercialIntervalMonths : undefined) ?? rules.service.intervalMonths;
  const m = rules.service.monitored;
  return monitored && m?.appliesTo.includes(customerType) ? Math.max(base, m.intervalMonths) : base;
}

/**
 * The lab tests a site needs under these rules, or null: by its recorded use category where
 * the rules name categories, otherwise by residential or commercial.
 */
export function labTestRequirement(rules: RulesetRules, customerType: "residential" | "commercial", useCategory: SiteUseCategory | null = null): LabTestRule | null {
  const lab = rules.labTests;
  if (!lab) return null;
  if (lab.useCategories && useCategory) return lab.useCategories.includes(useCategory) ? lab : null;
  return lab.appliesTo.includes(customerType) ? lab : null;
}

export type CategoryTerm = NonNullable<RulesetRules["service"]["categoryTerms"]>[number];

/** The authority's own term for this use, if it has one. */
export const categoryTermFor = (rules: RulesetRules, useCategory: SiteUseCategory | null): CategoryTerm | null =>
  (useCategory && rules.service.categoryTerms?.find((t) => t.useCategories.includes(useCategory))) || null;

/**
 * Why a site's schedule under these rules can't be settled from the rules alone, or null.
 * A category with its own term needs the interval from the site's own contract or permit;
 * rules that differ by use need the site's use category.
 */
export function siteScheduleProblem(
  rules: RulesetRules,
  authorityName: string,
  site: { useCategory: SiteUseCategory | null; permitIntervalMonths: number | null },
): string | null {
  const term = categoryTermFor(rules, site.useCategory);
  if (term && !site.permitIntervalMonths) {
    const every = term.initialIntervalMonths === 1 ? "every month" : `every ${term.initialIntervalMonths} months`;
    return `${authorityName}: ${term.source} asks for an inspection ${every} during the first ${term.initialTermMonths} months for a ${SITE_USE_CATEGORY_LABELS[site.useCategory!].toLowerCase()}. ${term.unconfirmed}. Record this site's interval from its current contract or permit, and where it says so, on the site page`;
  }
  if (!site.useCategory && (rules.service.categoryTerms?.length || rules.labTests?.useCategories)) {
    return `${authorityName}'s rules differ by what the system serves. Record this site's use (single-family home, multifamily, commercial or food establishment) on the site page`;
  }
  return null;
}

export const contractFilingRequired = (rules: RulesetRules) => rules.contracts?.filingRequired === true;

/** A filing's fees under these rules, as recorded when it opens; null when none are set. */
export function filingFees(rules: RulesetRules, kind: FilingKind) {
  const fee = kind === "contract" ? rules.fees?.contract : rules.fees?.inspectionReport;
  return fee ? { filingFeeCents: fee.filingCents, lateFeeRuleCents: fee.lateCents, feeBasis: rules.fees!.basis } : null;
}

/** The late fee owed when a filing first reaches the authority on `sentOn`. */
export const lateFeeOwed = (lateFeeRuleCents: number | null, deadlineOn: string | null, sentOn: string) => (deadlineOn && sentOn > deadlineOn ? (lateFeeRuleCents ?? 0) : 0);

/** The fields an authority requires an answer for at a site of this type. */
export function requiredFieldsFor(rules: RulesetRules, customerType: "residential" | "commercial") {
  const scoped = (rules.inspection.scopedRequiredFields ?? []).filter((s) => s.appliesTo.includes(customerType)).flatMap((s) => s.fields);
  return [...new Set([...rules.inspection.requiredFields, ...scoped])];
}

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

/** What the "Verified with <authority> on <date>" badge shows. */
export const verificationBadge = z.object({ authorityName: z.string(), confirmedOn: isoDate, confirmedWith: z.string(), method: z.enum(VERIFICATION_METHODS) });
export type VerificationBadge = z.infer<typeof verificationBadge>;

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
  /** For `reviewed` authorities: how to tell whether a site is theirs. */
  howToDecide: z.string().nullable(),
  profileStatus: z.enum(PROFILE_STATUSES),
  verified: verificationBadge.nullable(),
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
  profile: z
    .object({
      status: z.enum(PROFILE_STATUSES),
      sourcesCheckedOn: isoDate.nullable(),
      requirementEffective: z.object({ date: isoDate.nullable(), basis: z.string() }).nullable(),
      unresolved: z.array(z.string()),
      howToDecide: z.string().nullable(),
      /** What the authority asks of the site, line by line (W10.5), and where that comes from. */
      requirements: z.array(z.object({ key: z.string(), label: z.string(), value: z.string() })),
      requirementsSource: z.string(),
    })
    .nullable(),
  identifiers: z.array(authorityIdentifierStatus),
  /** Why the authority's schedule for this site isn't settled yet; its filings are held until it is. */
  scheduleNotice: z.string().nullable(),
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
  inspection: z.object({ id, completedAt: z.iso.datetime({ offset: true }).nullable(), locationStatus: locationStatus.nullable() }).nullable(),
  contract: z.object({ id, startOn: isoDate, endOn: isoDate, planName: z.string() }).nullable(),
  deadlineBasis: z.string().nullable(),
  site: z.object({ id, addressLine1: z.string(), city: z.string(), permitNumber: z.string().nullable() }),
  customer: z.object({ id, displayName: z.string() }),
  jurisdiction: z.object({ key: z.string(), authorityName: z.string(), rulesetVersion: z.number().int() }).nullable(),
  /**
   * The authority's fees, as recorded when the filing opened. `lateFeeCents` is decided when
   * it is first sent (0 when on time); until then it is null and `lateFeeIfLateCents` says
   * what a late filing would add. `totalCents` is what is owed so far.
   */
  fees: z
    .object({ filingFeeCents: z.number().int(), lateFeeIfLateCents: z.number().int(), lateFeeCents: z.number().int().nullable(), totalCents: z.number().int(), basis: z.string() })
    .nullable(),
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
export const CONFIRMATION_EVIDENCE_LABELS: Record<(typeof CONFIRMATION_EVIDENCE_KINDS)[number], string> = {
  authority_email_reply: "Email reply from the authority",
  portal_confirmation: "Confirmation on the authority's portal",
  phone_call: "Phone call with the authority",
  letter: "Letter from the authority",
  other: "Other",
};

export const confirmationEvidence = z.object({
  kind: z.enum(CONFIRMATION_EVIDENCE_KINDS),
  receivedOn: isoDate,
  from: z.string().nullable(),
});

export const packageDocument = z.object({
  role: z.enum(["cover_sheet", "inspection_report", "contract", "authority_csv"]),
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
      /** The authority's CSV layout, when its rules have one for this kind of filing; the office may file by CSV export. */
      csvExport: z.object({ formReference: z.string() }).nullable(),
      /** A short-lived link to the CSV in the current package, once made. */
      csvUrl: z.string().nullable(),
    })
    .nullable(),
  attempts: z.array(filingAttempt),
  /** Every package made for this filing, newest first. Each is exactly what was (or will be) sent. */
  packages: z.array(submissionPackage),
  confirmationEvidence: confirmationEvidence.nullable(),
  profile: z.object({ status: z.enum(PROFILE_STATUSES), sourcesCheckedOn: isoDate.nullable(), requirementEffective: z.object({ date: isoDate.nullable(), basis: z.string() }).nullable(), unresolved: z.array(z.string()), confirmationMode: z.enum(["manual_reference", "none_published"]), confirmationNote: z.string().nullable(), verified: verificationBadge.nullable() }).nullable(),
  /** Report versions for an inspection filing, newest first; corrections link to what they replace. */
  reports: z.array(z.object({ id, version: z.number().int(), sha256: z.string(), supersedesReportId: id.nullable(), correctionReason: z.string().nullable(), generatedAt: z.iso.datetime({ offset: true }) })),
  /**
   * An inspection filing held for review because readings are missing or out of range: what to
   * enter, by template field (`POST /filings/:id/correct` with those keys as `amendments`). The
   * corrected version then needs the MP's signature. Empty when nothing can be corrected that way.
   */
  answersToCorrect: z.array(z.object({ key: z.string(), label: z.string(), problem: z.enum(["missing", "invalid"]), message: z.string() })).default([]),
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

/**
 * One reporting authority on the coverage page: how far its rules are checked, what is
 * still open, and how many sites (across every organization) report to it today.
 */
export const rulesetCoverageItem = z.object({
  key: z.string(),
  state: z.string(),
  authorityName: z.string(),
  type: z.string(),
  active: z.boolean(),
  /** The version in force today, or null when none is. */
  rulesetVersion: z.number().int().nullable(),
  versions: z.number().int(),
  profileStatus: z.enum(PROFILE_STATUSES),
  verified: verificationBadge.nullable(),
  sourcesCheckedOn: z.iso.date().nullable(),
  sourceCount: z.number().int(),
  unresolved: z.array(z.string()),
  /** W12.V4: how far where reports go and the acceptance questions are confirmed, in one line. */
  confirmation: z.string(),
  /** Active sites whose authority this is today. */
  sites: z.number().int(),
  /** Organizations with at least one of those sites. */
  organizations: z.number().int(),
  /** Active sites that may be this authority's but need a person to decide. */
  sitesToDecide: z.number().int(),
});
export type RulesetCoverageItem = z.infer<typeof rulesetCoverageItem>;

export const rulesetCoverage = z.object({
  /** The date the counts are for (UTC). */
  today: z.iso.date(),
  items: z.array(rulesetCoverageItem),
  /** Active sites no authority covers and none may: no county, or a county with no ruleset. */
  sitesWithoutAuthority: z.number().int(),
});
export type RulesetCoverage = z.infer<typeof rulesetCoverage>;
