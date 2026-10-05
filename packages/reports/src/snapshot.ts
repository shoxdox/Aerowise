import { ISSUE_LABELS, visibleFields, type InspectionValues, type ReportLayoutRule, type TemplateDefinition, type TemplateField } from "@aerowise/domain";

export type Audience = "customer" | "authority";

/**
 * Everything a report shows, frozen when the report is made. The PDF is drawn only from
 * this, and the snapshot is stored with it, so later edits to the template, customer,
 * site or technician never change a historical report.
 */
export interface ReportSnapshot {
  audience: Audience;
  reportId: string;
  generatedAt: string;
  timezone: string;
  provider: { name: string; phone: string | null; email: string | null; address: string | null };
  customer: { name: string };
  site: { address: string; county: string | null; permitNumber: string | null };
  system: { manufacturer: string | null; model: string | null; serial: string | null; disposalType: string | null; chlorinationMethod: string | null } | null;
  technician: {
    name: string;
    license: string | null;
    /** The technician's licenses and registrations, each with what it is. */
    credentials?: { kind: string; label: string; number: string }[];
  };
  /** The licensed maintenance provider responsible for the report (authority copy). */
  responsibleProvider?: { name: string; label: string; number: string } | null;
  /**
   * Owner complaints and electronic monitoring notices since the last report, with the
   * response to each, as the authority requires (authority copy only).
   */
  responses?: { classification: "owner_complaint" | "monitoring_notice"; receivedAt: string; description: string; responseAction: string | null; respondedAt: string | null; outcome?: "resolved" | "outstanding" | null; carriedOver?: boolean }[];
  /** Set on a corrected version. `amendments` are every corrected answer so far, by field key. */
  correction?: { version: number; supersedesReportId: string; reason: string; amendedFields: string[]; amendments?: { key: string; value: string | number | boolean | null }[] } | null;
  /**
   * Only on the signed copy of an authority report: the licensed maintenance provider's
   * signature (30 TAC 285.7(b)(3)). The stored report snapshot never has it.
   */
  signature?: { name: string; licenseLabel: string; licenseNumber: string; typedName: string; statement: string; signedAt: string; reportVersion: number; reportSha256: string } | null;
  inspection: {
    id: string;
    arrivedAt: string;
    completedAt: string;
    arrivalGps: { lat: number; lng: number } | null;
    completionGps: { lat: number; lng: number } | null;
    validationStatus: string;
    overrideReason: string | null;
    accessIssue: string | null;
  };
  template: { id: string; name: string; version: number };
  /**
   * Set when the authority's ruleset defines its own report layout (authority copy only):
   * the title it uses and the ruleset version the sections were laid out under.
   */
  layout?: { title: string; formReference: string; jurisdictionKey: string; rulesetVersion: number } | null;
  sections: { title: string; rows: { label: string; value: string; failed: boolean }[] }[];
  issues: { type: string; severity: string; description: string }[];
  photos: { label: string; storageKey: string; contentType: string; capturedAt: string | null }[];
}

function formatValue(field: TemplateField, value: InspectionValues[string] | undefined): string {
  if (value === undefined || value === null || value === "") return "—";
  switch (field.type) {
    case "pass_fail":
      return value === "pass" ? "Pass" : value === "fail" ? "Fail" : String(value);
    case "boolean":
      return value === true ? "Yes" : value === false ? "No" : String(value);
    case "select":
      return field.options.find((o) => o.value === value)?.label ?? String(value);
    case "number":
      return `${value}${field.unit ? ` ${field.unit}` : ""}`;
    case "text":
      return String(value);
  }
}

/** Turns answers into labelled rows, grouped by section, for one audience. */
export function reportSections(def: TemplateDefinition, values: InspectionValues, audience: Audience): ReportSnapshot["sections"] {
  const fields = visibleFields(def, values).filter((f) => (f.audiences ?? ["customer", "authority"]).includes(audience));
  const sections: ReportSnapshot["sections"] = [];
  for (const f of fields) {
    // Optional fields nobody filled in are left off rather than printed as blanks.
    if (!f.required && (values[f.key] === undefined || values[f.key] === null || values[f.key] === "")) continue;
    let section = sections.find((s) => s.title === f.section);
    if (!section) sections.push((section = { title: f.section, rows: [] }));
    section.rows.push({ label: f.label, value: formatValue(f, values[f.key]), failed: f.type === "pass_fail" && values[f.key] === "fail" });
  }
  return sections;
}

const unanswered = (v: InspectionValues[string] | undefined) => v === undefined || v === null || v === "";

/**
 * The authority copy laid out as the authority's ruleset says: its sections, in its order,
 * under its labels. A listed answer the inspection never asked for (a conditional field
 * that did not apply, or one the template lacks) is left off, as is an optional one nobody
 * filled in; answers the layout does not list are not on this copy.
 */
export function layoutSections(def: TemplateDefinition, values: InspectionValues, layout: ReportLayoutRule): ReportSnapshot["sections"] {
  const visible = new Map(visibleFields(def, values).map((f) => [f.key, f]));
  const sections: ReportSnapshot["sections"] = [];
  for (const section of layout.sections) {
    const rows: ReportSnapshot["sections"][number]["rows"] = [];
    for (const item of section.fields) {
      const f = visible.get(item.key);
      if (!f || (!f.required && unanswered(values[f.key]))) continue;
      rows.push({ label: item.label ?? f.label, value: formatValue(f, values[f.key]), failed: f.type === "pass_fail" && values[f.key] === "fail" });
    }
    if (rows.length) sections.push({ title: section.title, rows });
  }
  return sections;
}

/**
 * Issue types left off the authority copy. Only sales follow-ups: a failure, needed
 * repair, part, pumping or return visit is part of the system's condition and stays on it.
 */
export const AUTHORITY_OMITTED_ISSUES: readonly string[] = ["estimate_required"];

/** The customer copy lists every issue; the authority copy everything but sales follow-ups. */
export function reportIssues(issues: { type: string; severity: string; description: string }[], audience: Audience): ReportSnapshot["issues"] {
  return issues
    .filter((i) => audience === "customer" || !AUTHORITY_OMITTED_ISSUES.includes(i.type))
    .map((i) => ({ type: ISSUE_LABELS[i.type as keyof typeof ISSUE_LABELS] ?? i.type, severity: i.severity, description: i.description }));
}
