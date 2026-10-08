"use client";

import type { InspectionValue, InspectionValues, TemplateField, ValidationProblem } from "@aerowise/domain";

// Renders a template's fields, grouped into its sections, for any form built on a template: the
// technician's inspection today, and work and intake forms (SW-F) on the phone and the web.

function Choice({ label, options, value, onChange }: { label: string; options: { value: string | boolean; label: string }[]; value: InspectionValue | undefined; onChange: (v: InspectionValue) => void }) {
  return (
    <div className="choice" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={value === o.value ? "chosen" : "secondary"}
          aria-pressed={value === o.value}
          onClick={() => onChange(value === o.value ? null : o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TemplateFieldInput({ field, value, problem, onChange }: { field: TemplateField; value: InspectionValue | undefined; problem?: ValidationProblem; onChange: (v: InspectionValue) => void }) {
  const title = (
    <span className="field-title">
      {field.label}
      {field.type === "number" && field.unit ? ` (${field.unit})` : ""}
      {field.required && <span className="req" aria-label="required"> *</span>}
    </span>
  );
  let control;
  switch (field.type) {
    case "pass_fail":
      control = <Choice label={field.label} value={value} onChange={onChange} options={[{ value: "pass", label: "Pass" }, { value: "fail", label: "Fail" }]} />;
      break;
    case "boolean":
      control = <Choice label={field.label} value={value} onChange={onChange} options={[{ value: true, label: "Yes" }, { value: false, label: "No" }]} />;
      break;
    case "select":
      control = <Choice label={field.label} value={value} onChange={onChange} options={field.options} />;
      break;
    case "number":
      control = (
        <input
          aria-label={field.label}
          type="number"
          inputMode="decimal"
          step="any"
          min={field.min}
          max={field.max}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
      break;
    case "text":
      control = <textarea aria-label={field.label} rows={3} maxLength={field.maxLength} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
      break;
  }
  return (
    <div className={`field ${problem ? "has-problem" : ""}`} data-field={field.key}>
      {title}
      {control}
      {field.help && <span className="muted small">{field.help}</span>}
      {problem && <span className="error small">{problem.message}</span>}
    </div>
  );
}

/** The visible fields, one card per section, in template order. */
export function TemplateSections({
  fields,
  values,
  problemFor,
  onChange,
}: {
  fields: TemplateField[];
  values: InspectionValues;
  problemFor: (key: string) => ValidationProblem | undefined;
  onChange: (key: string, value: InspectionValue) => void;
}) {
  const sections = [...new Set(fields.map((f) => f.section))];
  return sections.map((section) => (
    <section key={section} className="card stack">
      <h2>{section}</h2>
      {fields
        .filter((f) => f.section === section)
        .map((f) => (
          <TemplateFieldInput key={f.key} field={f} value={values[f.key]} problem={problemFor(f.key)} onChange={(v) => onChange(f.key, v)} />
        ))}
    </section>
  ));
}
