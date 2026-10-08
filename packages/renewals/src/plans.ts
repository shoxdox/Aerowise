import type { Database, DB } from "@aerowise/db";
import { coverageSummary, cycleSummary, DEFAULT_RENEWAL_TERMS, parseCoverageRules, parsePlanOptions, parseServiceCycles, type AgreementPreview, type CoverageRule, type IntakeFormRef, type PlanOption, type ServiceCycle, type TemplateDefinition } from "@aerowise/domain";
import type { Transaction } from "kysely";

type Executor = Database | Transaction<DB>;

// Reading plan versions (SW-8).

export interface LoadedPlanVersion {
  id: string;
  planId: string;
  version: number;
  name: string;
  termsText: string | null;
  options: PlanOption[];
  coverage: CoverageRule[];
  /** The intake form version asked at online signing, with its questions. */
  intake: (IntakeFormRef & { definition: TemplateDefinition }) | null;
  /** Whether it includes aerobic inspections, and its pumping or maintenance cycles (SW-9). */
  aerobic: boolean;
  serviceCycles: ServiceCycle[];
  /** Inspection visits per term, for the aerobic cycle. */
  visitsPerTerm: number;
}

/** A version of one of this organization's plans; null when it is not one. */
export async function loadPlanVersion(db: Executor, organizationId: string, versionId: string): Promise<LoadedPlanVersion | null> {
  const v = await db
    .selectFrom("planVersions")
    .select(["id", "planId", "version", "name", "termsText", "options", "coverage", "intakeTemplateId", "serviceCycles", "visitsPerTerm"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", versionId)
    .executeTakeFirst();
  if (!v) return null;
  const { intakeTemplateId, serviceCycles, ...rest } = v;
  const cycles = parseServiceCycles(serviceCycles);
  return {
    ...rest,
    options: parsePlanOptions(v.options),
    coverage: parseCoverageRules(v.coverage),
    intake: intakeTemplateId ? await loadIntakeForm(db, intakeTemplateId) : null,
    aerobic: cycles.aerobic !== null,
    serviceCycles: cycles.cycles,
  };
}

/** One version of an intake form, as a plan version names it. */
export async function loadIntakeForm(db: Executor, templateId: string): Promise<(IntakeFormRef & { definition: TemplateDefinition }) | null> {
  const t = await db.selectFrom("inspectionTemplates").select(["id", "key", "version", "name", "definition"]).where("id", "=", templateId).executeTakeFirst();
  return t ? { id: t.id, key: t.key, version: t.version, name: t.name, definition: t.definition as TemplateDefinition } : null;
}

/** Catalog item names for coverage rules that name an item. */
export async function coverageItemNames(db: Executor, organizationId: string, rules: readonly CoverageRule[]): Promise<Map<string, string>> {
  const ids = rules.flatMap((r) => ("serviceItemId" in r.match ? [r.match.serviceItemId] : []));
  if (!ids.length) return new Map();
  const rows = await db.selectFrom("serviceItems").select(["id", "name"]).where("organizationId", "=", organizationId).where("id", "in", ids).execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** One line per rule, as agreements and the office show coverage. */
export async function coverageLines(db: Executor, organizationId: string, rules: readonly CoverageRule[]) {
  const names = await coverageItemNames(db, organizationId, rules);
  return rules.map((r) => ({ ruleKey: r.ruleKey, label: r.label, summary: coverageSummary(r, "serviceItemId" in r.match ? names.get(r.match.serviceItemId) : undefined) }));
}

/** What a customer signing under this version agrees to. The organization's terms apply when the version has none. */
export async function agreementPreview(db: Executor, organizationId: string, v: LoadedPlanVersion, organizationTerms: string | null): Promise<AgreementPreview> {
  return {
    termsSource: v.termsText ? "plan" : "organization",
    terms: v.termsText ?? organizationTerms ?? DEFAULT_RENEWAL_TERMS,
    options: v.options,
    coverage: await coverageLines(db, organizationId, v.coverage),
    intake: v.intake ? { name: v.intake.name, questions: v.intake.definition.fields.map((f) => f.label) } : null,
    cycles: agreementCycles(v) ?? [],
  };
}

/**
 * The service an agreement lists when the version has more than inspections (SW-9): every
 * cycle, inspections first. Null for an inspection-only version, so its agreement reads as before.
 */
export function agreementCycles(v: LoadedPlanVersion) {
  if (v.aerobic && !v.serviceCycles.length) return null;
  return [
    ...(v.aerobic ? [{ cycleKey: "aerobic", label: "Aerobic inspections", summary: cycleSummary({ serviceType: "aerobic_inspection", schedule: { kind: "visits_per_term", visitsPerTerm: v.visitsPerTerm } }) }] : []),
    ...v.serviceCycles.map((c) => ({ cycleKey: c.cycleKey, label: c.label, summary: cycleSummary(c) })),
  ];
}
