import { visibleFields, type InspectionValue, type InspectionValues, type TemplateDefinition } from "./inspections.ts";

// SW-7: the "Work completion summary", a customer-facing account of finished work (any kind of
// work, from its field records). Never an authority report: nothing in it is filed.

/** One answer as the customer reads it. */
export function answerText(def: TemplateDefinition, key: string, value: InspectionValue): string {
  const field = def.fields.find((f) => f.key === key);
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (field?.type === "pass_fail") return value === "pass" ? "Pass" : "Fail";
  if (field?.type === "select") return field.options.find((o) => o.value === value)?.label ?? String(value);
  if (field?.type === "number" && field.unit) return `${value} ${field.unit}`;
  return String(value);
}

/** The answers a visit's form shows, in form order, leaving out empty ones and any meant only for an authority. */
export function completionAnswers(def: TemplateDefinition, values: InspectionValues): { section: string; label: string; answer: string }[] {
  return visibleFields(def, values)
    .filter((f) => !f.audiences || f.audiences.includes("customer"))
    .filter((f) => values[f.key] !== undefined && values[f.key] !== null && values[f.key] !== "")
    .map((f) => ({ section: f.section, label: f.label, answer: answerText(def, f.key, values[f.key]!) }));
}
