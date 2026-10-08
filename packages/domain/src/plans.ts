import { z } from "zod";
import { BILLING_FREQUENCIES, plan, SERVICE_TYPES } from "./contracts.ts";
import { serviceCycle } from "./cycles.ts";
import { CUSTOMER_TYPES, id } from "./crm.ts";
import { formKey } from "./forms.ts";
import { templateDefinition, validateInspection, visibleFields, type InspectionValues, type TemplateDefinition, type ValidationProblem } from "./inspections.ts";
import { MAX_CENTS } from "./invoices.ts";
import { WORK_CATEGORIES, WORK_CATEGORY_LABELS, type WorkCategory } from "./work.ts";

// Versioned plan definitions (SW-8, service workflows plan §4.2 and §4.3). A plan's version
// holds what it was when a contract or renewal took it: name, term, visits and price, its
// own agreement terms (or none, for the organization's), priced options offered at signing,
// and coverage rules. Versions never change. A contract freezes its version's coverage
// rules when it is made and is judged only by those, never by a later version.
//
// Basic, Gold and Platinum are only names: benefits come from coverage rules alone, and a
// plan with none covers nothing.

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Use lowercase letters, digits, - and _ (up to 64)");
const cents = z.number().int().min(0).max(MAX_CENTS);

/** A priced choice offered with the plan when the customer signs. Billed once, with the first payment, like an add-on. */
export const planOption = z
  .object({
    optionKey: slug,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).nullable().default(null),
    priceCents: cents,
    taxable: z.boolean().default(false),
    /** Always included; the customer cannot remove it. */
    required: z.boolean().default(false),
    /** Ticked when the customer opens the offer. */
    default: z.boolean().default(false),
  })
  .refine((o) => !o.required || o.default, { message: "A required option is always ticked", path: ["default"] });
export type PlanOption = z.infer<typeof planOption>;

export const COVERAGE_EFFECTS = ["included", "percent_off", "excluded"] as const;
export type CoverageEffect = (typeof COVERAGE_EFFECTS)[number];

/** Which work lines a rule applies to: a kind of work, or one catalog item. */
export const coverageMatch = z.union([z.object({ category: z.enum(WORK_CATEGORIES) }).strict(), z.object({ serviceItemId: id }).strict()]);
export type CoverageMatch = z.infer<typeof coverageMatch>;

export const coverageRule = z
  .object({
    ruleKey: slug,
    label: z.string().trim().min(1).max(200),
    match: coverageMatch,
    /** `included`: no charge. `percent_off`: that much off. `excluded`: never covered (stops later rules from matching). */
    effect: z.enum(COVERAGE_EFFECTS),
    percentOff: z.number().int().min(1).max(99).nullable().default(null),
    /** Work orders that may use this rule in one contract term; null is no limit. */
    limit: z.object({ count: z.number().int().min(1).max(1000), per: z.literal("term") }).nullable().default(null),
  })
  .superRefine((r, ctx) => {
    if ((r.effect === "percent_off") !== (r.percentOff !== null)) {
      ctx.addIssue({ code: "custom", path: ["percentOff"], message: r.effect === "percent_off" ? "Say how much is taken off" : "Only a percent-off rule has a percentage" });
    }
    if (r.effect === "excluded" && r.limit) ctx.addIssue({ code: "custom", path: ["limit"], message: "An exclusion has no limit" });
  });
export type CoverageRule = z.infer<typeof coverageRule>;

const uniqueKeys =
  <T>(key: (t: T) => string, what: string) =>
  (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    items.forEach((it, i) => {
      const k = key(it);
      if (seen.has(k)) ctx.addIssue({ code: "custom", path: [i], message: `Two ${what} use the key "${k}"` });
      seen.add(k);
    });
  };

/** Stored options and rules, checked again when read so a value that no longer fits is an error, never a silent benefit. */
export const parsePlanOptions = (v: unknown): PlanOption[] => z.array(planOption).parse(v);
export const parseCoverageRules = (v: unknown): CoverageRule[] => z.array(coverageRule).parse(v);
/** The options an office-made contract took, from its agreement snapshot (SW-8); none without one. */
export function parseSnapshotOptions(snapshot: unknown): PlanOption[] {
  const o = snapshot && typeof snapshot === "object" ? (snapshot as { options?: unknown }).options : undefined;
  return o === undefined ? [] : parsePlanOptions(o);
}

/** What the office saves from the plan builder: a new version of the plan. */
export const planVersionInput = z.object({
  /** Null: the organization's agreement terms. */
  termsText: z.string().trim().min(20).max(20_000).nullable(),
  options: z.array(planOption).max(20).superRefine(uniqueKeys((o) => o.optionKey, "options")),
  coverage: z.array(coverageRule).max(30).superRefine(uniqueKeys((r) => r.ruleKey, "coverage rules")),
  /** One version of an intake form the customer answers when signing online; null asks nothing. */
  intakeTemplateId: id.nullable().default(null),
  /**
   * Pumping or maintenance cycles (SW-9, needs `service_cycles`). Each numbers its own visits
   * and is done as work orders, never as inspections. Left out, the current version's are kept.
   */
  serviceCycles: z.array(serviceCycle).max(6).superRefine(uniqueKeys((c) => c.cycleKey, "cycles")).optional(),
  /**
   * Whether the plan includes its aerobic inspections. False makes a pumping or maintenance
   * service plan with no inspections (SW-9, needs `service_cycles` and at least one cycle).
   * Left out, the current version's choice is kept.
   */
  aerobic: z.boolean().optional(),
});
export type PlanVersionInput = z.input<typeof planVersionInput>;

/** The version of an intake form a plan version asks. */
export const intakeFormRef = z.object({ id, key: z.string(), version: z.number().int(), name: z.string() });
export type IntakeFormRef = z.infer<typeof intakeFormRef>;

export const planVersion = z.object({
  id,
  planId: id,
  version: z.number().int(),
  name: z.string(),
  customerType: z.enum(CUSTOMER_TYPES),
  termMonths: z.number().int(),
  visitsPerTerm: z.number().int(),
  priceCents: z.number().int(),
  billingFrequency: z.enum(BILLING_FREQUENCIES),
  serviceType: z.enum(SERVICE_TYPES),
  termsText: z.string().nullable(),
  options: z.array(planOption),
  coverage: z.array(coverageRule),
  intake: intakeFormRef.nullable(),
  /** Whether the version includes aerobic inspections (SW-9). */
  aerobic: z.boolean(),
  /** Its pumping or maintenance cycles (SW-9). */
  serviceCycles: z.array(serviceCycle),
  createdAt: z.iso.datetime({ offset: true }),
  /** Contracts and renewals made from this version. */
  contracts: z.number().int(),
  renewals: z.number().int(),
});
export type PlanVersion = z.infer<typeof planVersion>;

/** What the customer would sign under this version: the provider's own terms text when it has none. */
export const agreementPreview = z.object({
  termsSource: z.enum(["plan", "organization"]),
  terms: z.string(),
  options: z.array(planOption),
  coverage: z.array(z.object({ ruleKey: z.string(), label: z.string(), summary: z.string() })),
  /** The intake questions asked at signing, as labels; null when the version asks none. */
  intake: z.object({ name: z.string(), questions: z.array(z.string()) }).nullable(),
  /** Pumping or maintenance included, one line each (SW-9); empty for an inspection-only plan. */
  cycles: z.array(z.object({ cycleKey: z.string(), label: z.string(), summary: z.string() })),
});
export type AgreementPreview = z.infer<typeof agreementPreview>;

/** A plan with its version history and what the current version would have a customer sign. */
export const planDetail = plan.extend({
  versions: z.array(planVersion),
  preview: agreementPreview,
});
export type PlanDetail = z.infer<typeof planDetail>;

/** One line of plain text per rule, for agreements and the office ("Pump replacement: no charge, up to 2 per term"). */
export function coverageSummary(r: CoverageRule, itemName?: string): string {
  const what = "category" in r.match ? `${WORK_CATEGORY_LABELS[r.match.category]} work` : (itemName ?? "One catalog item");
  const effect = r.effect === "included" ? "no charge" : r.effect === "percent_off" ? `${r.percentOff}% off` : "not covered";
  const limit = r.limit ? `, up to ${r.limit.count} work order${r.limit.count === 1 ? "" : "s"} per term` : "";
  return `${r.label}: ${what}, ${effect}${limit}`;
}

/** A work line as coverage sees it. */
export interface CoverableLine {
  /** The line's catalog item's category, or the work order's when it has none. */
  category: WorkCategory;
  serviceItemId: string | null;
  unitPriceCents: number;
}

export interface CoveredLine {
  /** The rule that decided this line, or null when none matched. */
  ruleKey: string | null;
  effect: CoverageEffect | null;
  unitPriceCents: number;
  /** Printed with the line, so a covered line at zero still says why. */
  note: string | null;
}

/**
 * Applies a contract's rules, in their order, to one line: the first rule that matches
 * decides. `included` brings the price to zero, `percent_off` takes its share off (half a
 * cent rounds in the customer's favor), and `excluded` stops the search with no change.
 */
export function coverLine(rules: readonly CoverageRule[], line: CoverableLine, planName: string): CoveredLine {
  const rule = rules.find((r) => ("category" in r.match ? r.match.category === line.category : r.match.serviceItemId === line.serviceItemId));
  if (!rule || rule.effect === "excluded") return { ruleKey: rule?.ruleKey ?? null, effect: rule?.effect ?? null, unitPriceCents: line.unitPriceCents, note: null };
  if (rule.effect === "included") return { ruleKey: rule.ruleKey, effect: "included", unitPriceCents: 0, note: `Covered by ${planName}: ${rule.label}` };
  const off = Math.ceil((line.unitPriceCents * rule.percentOff!) / 100);
  return { ruleKey: rule.ruleKey, effect: "percent_off", unitPriceCents: line.unitPriceCents - off, note: `${rule.percentOff}% off with ${planName}: ${rule.label}` };
}

/**
 * Rules a work order can use: those that match its kind of work, or one of its lines' items
 * or their categories. Exclusions are never used.
 */
export function matchingRules<R extends CoverageRule>(
  rules: readonly R[],
  workOrder: { category: WorkCategory; lines: readonly { serviceItemId: string | null; category: WorkCategory | null }[] },
): R[] {
  const categories = new Set([workOrder.category, ...workOrder.lines.flatMap((l) => (l.category ? [l.category] : []))]);
  return rules.filter((r) => {
    const m = r.match;
    return r.effect !== "excluded" && ("category" in m ? categories.has(m.category) : workOrder.lines.some((l) => l.serviceItemId === m.serviceItemId));
  });
}

export const COVERAGE_USE_STATES = ["reserved", "consumed", "released"] as const;
export type CoverageUseState = (typeof COVERAGE_USE_STATES)[number];

/** A work order's coverage, as the office sees it. */
export const workOrderCoverage = z.object({
  /** The contract at the site on the day the work was requested; null when there is none. */
  contract: z.object({ id, planName: z.string(), planVersion: z.number().int().nullable(), startOn: z.iso.date(), endOn: z.iso.date() }).nullable(),
  /** Why there is nothing to apply, when there is nothing. */
  notice: z.string().nullable(),
  rules: z.array(
    z.object({
      id,
      ruleKey: z.string(),
      label: z.string(),
      summary: z.string(),
      effect: z.enum(COVERAGE_EFFECTS),
      limit: z.number().int().nullable(),
      /** Reserved and consumed uses in the term, by any work order. */
      used: z.number().int(),
      /** Whether this rule fits this work order. */
      matches: z.boolean(),
      use: z.object({ state: z.enum(COVERAGE_USE_STATES), invoiceId: id.nullable(), reason: z.string().nullable() }).nullable(),
    }),
  ),
  canApply: z.boolean(),
  /** The work order's draft or issued invoice. While there is one, coverage can't be applied or declined. */
  liveInvoiceId: id.nullable(),
});
export type WorkOrderCoverage = z.infer<typeof workOrderCoverage>;

export const coverageReasonInput = z.object({ reason: z.string().trim().min(1).max(2000) });

// ---- Intake at signing (SW-8 follow-up) ----

/**
 * A new version of an intake form (SW-F purpose `intake`), saved from the plan builder. Answers
 * only: the customer's signature on the agreement covers it, and there is nothing to photograph.
 */
export const intakeFormInput = z
  .object({ key: formKey, name: z.string().trim().min(1).max(200), definition: templateDefinition })
  .superRefine((f, ctx) => {
    if (f.definition.photos.length) ctx.addIssue({ code: "custom", path: ["definition", "photos"], message: "An intake form asks questions only, without photos" });
    if (f.definition.signatures?.length) ctx.addIssue({ code: "custom", path: ["definition", "signatures"], message: "An intake form has no signatures of its own: the agreement is signed" });
  });
export type IntakeFormInput = z.input<typeof intakeFormInput>;

export const intakeValues = z.record(z.string().max(64), z.union([z.string().max(5000), z.number(), z.boolean(), z.null()]));

/** One answer as the signed agreement keeps it: the value and how it reads. */
export const intakeAnswer = z.object({ key: z.string(), label: z.string(), value: z.union([z.string(), z.number(), z.boolean()]), answer: z.string() });
export type IntakeAnswer = z.infer<typeof intakeAnswer>;

/** The intake form and answers inside a signed agreement. */
export const signedIntake = intakeFormRef.omit({ id: true }).extend({ templateId: id, answers: z.array(intakeAnswer) });
export type SignedIntake = z.infer<typeof signedIntake>;

/**
 * Checks a customer's intake answers against the form, the same way an inspection is checked,
 * and keeps only answers to questions the form shows. Problems mean the agreement is not signed.
 */
export function intakeAnswers(def: TemplateDefinition, values: InspectionValues): { problems: ValidationProblem[]; answers: IntakeAnswer[] } {
  const problems = validateInspection(def, values, {});
  const answers: IntakeAnswer[] = [];
  for (const f of visibleFields(def, values)) {
    const v = values[f.key];
    if (v === undefined || v === null || v === "") continue;
    const answer =
      f.type === "boolean" ? (v ? "Yes" : "No")
      : f.type === "pass_fail" ? (v === "pass" ? "Pass" : "Fail")
      : f.type === "select" ? (f.options.find((o) => o.value === v)?.label ?? String(v))
      : f.type === "number" && f.unit ? `${v} ${f.unit}`
      : String(v);
    answers.push({ key: f.key, label: f.label, value: v, answer });
  }
  return { problems, answers };
}
