import { visibleFields, type InspectionValues, type TemplateDefinition, type TemplateField } from "@aerowise/domain";

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
  technician: { name: string; license: string | null };
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
  sections: { title: string; rows: { label: string; value: string; failed: boolean }[] }[];
  issues: { type: string; severity: string; description: string }[];
  photos: { label: string; storageKey: string; contentType: string; capturedAt: string | null }[];
}

const ISSUE_LABELS: Record<string, string> = {
  repair_needed: "Repair needed",
  pump_out: "Pump-out needed",
  part_replacement: "Part replacement",
  callback: "Callback",
  estimate_required: "Estimate required",
  noncompliance: "Noncompliance",
};

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

/** The customer copy lists every issue; the authority copy only noncompliance. */
export function reportIssues(issues: { type: string; severity: string; description: string }[], audience: Audience): ReportSnapshot["issues"] {
  return issues
    .filter((i) => audience === "customer" || i.type === "noncompliance")
    .map((i) => ({ type: ISSUE_LABELS[i.type] ?? i.type, severity: i.severity, description: i.description }));
}
