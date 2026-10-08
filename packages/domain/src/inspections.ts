import { z } from "zod";
import { id } from "./crm.ts";

// Inspection templates decide what a technician sees and must fill in. A template
// version is immutable once saved: changing a template means saving a new version, and
// every inspection keeps the version it was done with.

const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "lowercase letters, digits and underscores");

export const condition = z.object({
  field: fieldKey,
  /** Show when the other field's value is one of these. */
  in: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
});
export type Condition = z.infer<typeof condition>;

const fieldBase = {
  key: fieldKey,
  label: z.string().min(1).max(200),
  section: z.string().min(1).max(100),
  required: z.boolean().default(false),
  showWhen: condition.optional(),
  help: z.string().max(500).optional(),
  /** Which report copies show this field. Defaults to both. */
  audiences: z.array(z.enum(["customer", "authority"])).min(1).optional(),
};

export const templateField = z.discriminatedUnion("type", [
  z.object({ ...fieldBase, type: z.literal("pass_fail") }),
  z.object({ ...fieldBase, type: z.literal("boolean") }),
  z.object({ ...fieldBase, type: z.literal("text"), maxLength: z.number().int().min(1).max(5000).default(2000) }),
  z.object({
    ...fieldBase,
    type: z.literal("number"),
    unit: z.string().max(20).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    ...fieldBase,
    type: z.literal("select"),
    options: z.array(z.object({ value: z.string().min(1).max(50), label: z.string().min(1).max(100) })).min(2).max(20),
  }),
]);
export type TemplateField = z.infer<typeof templateField>;

export const photoRequirement = z.object({
  key: fieldKey,
  label: z.string().min(1).max(200),
  minCount: z.number().int().min(0).max(20),
  showWhen: condition.optional(),
});
export type PhotoRequirement = z.infer<typeof photoRequirement>;

/**
 * A signature the form asks for, such as the customer signing off a summary of the work. It is a
 * plain sign-off on what was done, never a regulatory or MP signature: those stay office-side.
 */
export const signatureRequirement = z.object({
  key: fieldKey,
  label: z.string().min(1).max(200),
  signer: z.enum(["customer", "technician"]),
  required: z.boolean().default(false),
  /**
   * SW-7: asked for only on the visit that finishes the work (a multi-visit installation's
   * completion sign-off), on the phone and on the server alike. Absent means every visit, as
   * before, so every form saved without it reads unchanged.
   */
  finalVisitOnly: z.boolean().optional(),
});
export type SignatureRequirement = z.infer<typeof signatureRequirement>;

export const templateDefinition = z
  .object({
    fields: z.array(templateField).min(1).max(200),
    photos: z.array(photoRequirement).max(50),
    /** Optional, so every definition saved before signatures existed reads unchanged. */
    signatures: z.array(signatureRequirement).max(5).optional(),
  })
  .superRefine((def, ctx) => {
    const keys = new Set<string>();
    for (const f of def.fields) {
      if (keys.has(f.key)) ctx.addIssue({ code: "custom", message: `Duplicate field key ${f.key}` });
      keys.add(f.key);
    }
    const signatureKeys = new Set<string>();
    for (const sig of def.signatures ?? []) {
      if (keys.has(sig.key) || signatureKeys.has(sig.key)) ctx.addIssue({ code: "custom", message: `Duplicate signature key ${sig.key}` });
      signatureKeys.add(sig.key);
    }
    for (const item of [...def.fields, ...def.photos]) {
      if (item.showWhen && !keys.has(item.showWhen.field)) {
        ctx.addIssue({ code: "custom", message: `${item.key} depends on unknown field ${item.showWhen.field}` });
      }
    }
  });
export type TemplateDefinition = z.infer<typeof templateDefinition>;

export type InspectionValue = string | number | boolean | null;
export type InspectionValues = Record<string, InspectionValue>;

const isShown = (cond: Condition | undefined, values: InspectionValues) =>
  !cond || (values[cond.field] !== undefined && values[cond.field] !== null && cond.in.includes(values[cond.field]!));

/** Fields currently shown, given the answers so far (conditional fields depend on them). */
export function visibleFields(def: TemplateDefinition, values: InspectionValues): TemplateField[] {
  return def.fields.filter((f) => isShown(f.showWhen, values));
}

export function visiblePhotos(def: TemplateDefinition, values: InspectionValues): PhotoRequirement[] {
  return def.photos.filter((p) => isShown(p.showWhen, values));
}

export interface ValidationProblem {
  key: string;
  label: string;
  problem: "missing" | "invalid" | "photos";
  message: string;
}

const isEmpty = (v: InspectionValue | undefined) => v === undefined || v === null || v === "";

/**
 * Checks an inspection against its template. Used by the phone app before completing
 * and by the API when the completed inspection arrives, so both agree.
 */
export function validateInspection(
  def: TemplateDefinition,
  values: InspectionValues,
  photoCounts: Record<string, number>,
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  for (const f of visibleFields(def, values)) {
    const v = values[f.key];
    if (isEmpty(v)) {
      if (f.required) problems.push({ key: f.key, label: f.label, problem: "missing", message: `${f.label} is required` });
      continue;
    }
    const invalid = (message: string) => problems.push({ key: f.key, label: f.label, problem: "invalid", message });
    switch (f.type) {
      case "pass_fail":
        if (v !== "pass" && v !== "fail") invalid(`${f.label} must be pass or fail`);
        break;
      case "boolean":
        if (typeof v !== "boolean") invalid(`${f.label} must be yes or no`);
        break;
      case "text":
        if (typeof v !== "string" || v.length > f.maxLength) invalid(`${f.label} must be text up to ${f.maxLength} characters`);
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) invalid(`${f.label} must be a number`);
        else if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) {
          invalid(`${f.label} must be between ${f.min ?? "−∞"} and ${f.max ?? "∞"}${f.unit ? ` ${f.unit}` : ""}`);
        }
        break;
      case "select":
        if (!f.options.some((o) => o.value === v)) invalid(`${f.label} has an unknown option`);
        break;
    }
  }
  for (const p of visiblePhotos(def, values)) {
    const have = photoCounts[p.key] ?? 0;
    if (have < p.minCount) {
      problems.push({ key: p.key, label: p.label, problem: "photos", message: `${p.label}: ${p.minCount - have} more photo${p.minCount - have === 1 ? "" : "s"} needed` });
    }
  }
  return problems;
}

/** Keys from `values` that the template does not define (rejected on sync). */
export function unknownKeys(def: TemplateDefinition, values: InspectionValues): string[] {
  const known = new Set(def.fields.map((f) => f.key));
  return Object.keys(values).filter((k) => !known.has(k));
}

const passFail = (key: string, label: string, section: string, required = true) =>
  ({ key, label, section, type: "pass_fail", required }) as const;

/**
 * The built-in template covering the canonical aerobic fields in PRODUCT-SPEC §5.7.
 * Required/optional choices are a sensible provider default, not a county rule; the
 * compliance engine adds jurisdiction requirements on top.
 */
export const DEFAULT_TEMPLATE_KEY = "aerobic-standard";
export const DEFAULT_TEMPLATE: { key: string; version: number; name: string; definition: TemplateDefinition } = {
  key: DEFAULT_TEMPLATE_KEY,
  // Bump when the built-in definition changes; inspections keep the version they used.
  // v2 (W12.C3): pump-tank sludge and pH, spray area and unauthorized alterations, which
  // Williamson, Grimes, Travis and SJRA require on the report.
  version: 2,
  name: "Aerobic maintenance inspection",
  definition: {
    fields: [
      passFail("aerator", "Aerator", "Aeration"),
      { key: "air_pressure", label: "Air pressure", section: "Aeration", type: "number", unit: "psi", min: 0, max: 30, required: false },
      passFail("air_filter", "Air filter", "Aeration"),
      passFail("diffuser", "Diffuser", "Aeration"),
      passFail("alarm_controller", "Alarms / controller", "Controls"),
      passFail("electrical", "Electrical condition", "Controls"),
      passFail("floats_wiring", "Floats / wiring", "Controls"),
      passFail("treatment_tank", "Clarifier / treatment tank", "Tanks"),
      passFail("pump_tank", "Pump tank", "Tanks"),
      passFail("lids_openings", "Lids / openings", "Tanks"),
      passFail("tank_condition", "Tank condition", "Tanks"),
      passFail("effluent_pump", "Effluent pump / filter", "Tanks"),
      {
        key: "pump_tank_sludge",
        label: "Sludge in pump tank",
        section: "Tanks",
        type: "number",
        unit: "in",
        min: 0,
        max: 120,
        required: false,
        help: "Depth of settled sludge measured in the pump tank, in inches.",
      },
      { key: "pump_tank_ph", label: "pH in pump tank", section: "Tanks", type: "number", min: 0, max: 14, required: false },
      {
        key: "chlorinator",
        label: "Chlorine device",
        section: "Disinfection",
        type: "select",
        required: true,
        options: [
          { value: "working", label: "Working" },
          { value: "needs_service", label: "Needs service" },
          { value: "not_present", label: "Not present" },
        ],
      },
      {
        key: "chlorine_level",
        label: "Chlorine level",
        section: "Disinfection",
        type: "number",
        unit: "ppm",
        min: 0,
        max: 20,
        required: true,
        showWhen: { field: "chlorinator", in: ["working", "needs_service"] },
      },
      {
        key: "chlorine_added",
        label: "Chlorine tablets added",
        section: "Disinfection",
        type: "number",
        min: 0,
        max: 50,
        required: false,
        showWhen: { field: "chlorinator", in: ["working", "needs_service"] },
      },
      passFail("dispersal_field", "Dispersal / spray field", "Dispersal"),
      { key: "field_pressure", label: "Field pressure", section: "Dispersal", type: "number", unit: "psi", min: 0, max: 100, required: false },
      {
        key: "spray_area",
        label: "Spray area condition",
        section: "Dispersal",
        type: "select",
        required: false,
        options: [
          { value: "acceptable", label: "Acceptable" },
          { value: "needs_attention", label: "Needs attention" },
          { value: "not_spray", label: "Not a spray system" },
        ],
      },
      {
        key: "spray_area_detail",
        label: "What needs attention in the spray area",
        section: "Dispersal",
        type: "text",
        maxLength: 2000,
        required: true,
        showWhen: { field: "spray_area", in: ["needs_attention"] },
      },
      {
        key: "odor",
        label: "Odor",
        section: "Dispersal",
        type: "select",
        required: true,
        options: [
          { value: "none", label: "None" },
          { value: "mild", label: "Mild" },
          { value: "strong", label: "Strong" },
        ],
      },
      { key: "ph", label: "pH", section: "Lab values", type: "number", min: 0, max: 14, required: false },
      { key: "tss", label: "TSS", section: "Lab values", type: "number", unit: "mg/L", min: 0, required: false },
      { key: "bod", label: "BOD", section: "Lab values", type: "number", unit: "mg/L", min: 0, required: false },
      {
        key: "unauthorized_alterations",
        label: "Unauthorized alterations",
        section: "Wrap-up",
        type: "select",
        required: false,
        options: [
          { value: "none_found", label: "None found" },
          { value: "found", label: "Found" },
        ],
      },
      {
        key: "unauthorized_alterations_detail",
        label: "Alterations found",
        section: "Wrap-up",
        type: "text",
        maxLength: 2000,
        required: true,
        showWhen: { field: "unauthorized_alterations", in: ["found"] },
      },
      { key: "pumping_needed", label: "Pumping needed", section: "Wrap-up", type: "boolean", required: true },
      { key: "repairs_made", label: "Repairs made", section: "Wrap-up", type: "text", maxLength: 2000, required: false },
      { key: "notes", label: "Notes for the customer", section: "Wrap-up", type: "text", maxLength: 5000, required: false, audiences: ["customer"] },
    ],
    photos: [
      { key: "overview", label: "Overview of the unit", minCount: 1 },
      { key: "chlorinator", label: "Chlorinator", minCount: 1, showWhen: { field: "chlorinator", in: ["working", "needs_service"] } },
      { key: "aerator_failure", label: "Aerator problem", minCount: 1, showWhen: { field: "aerator", in: ["fail"] } },
    ],
  },
};

export const ISSUE_TYPES = ["repair_needed", "pump_out", "part_replacement", "callback", "estimate_required", "noncompliance"] as const;
export const ISSUE_SEVERITIES = ["low", "medium", "high"] as const;

export const ISSUE_LABELS: Record<(typeof ISSUE_TYPES)[number], string> = {
  repair_needed: "Repair needed",
  pump_out: "Pump-out needed",
  part_replacement: "Part replacement",
  callback: "Callback",
  estimate_required: "Estimate required",
  noncompliance: "Noncompliance",
};

const value = z.union([z.string().max(5000), z.number(), z.boolean(), z.null()]);
const gps = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100000).optional() });

/**
 * What the phone app sends. The same payload is sent again after every edit and on every
 * retry; `clientId` (generated on the phone) makes it idempotent.
 */
export const inspectionSync = z.object({
  clientId: z.uuid(),
  jobId: id,
  templateId: id,
  status: z.enum(["draft", "completed"]),
  arrivedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullish(),
  arrivalGps: gps.nullish(),
  completionGps: gps.nullish(),
  accessIssue: z.string().trim().max(500).nullish(),
  values: z.record(z.string(), value),
  issues: z
    .array(
      z.object({
        clientId: z.uuid(),
        type: z.enum(ISSUE_TYPES),
        severity: z.enum(ISSUE_SEVERITIES).default("medium"),
        description: z.string().trim().max(2000).default(""),
      }),
    )
    .max(20)
    .default([]),
});
export type InspectionSync = z.input<typeof inspectionSync>;

export const validationProblem = z.object({
  key: z.string(),
  label: z.string(),
  problem: z.enum(["missing", "invalid", "photos"]),
  message: z.string(),
});

export const inspectionTemplate = z.object({
  id,
  key: z.string(),
  version: z.number().int(),
  name: z.string(),
  builtIn: z.boolean(),
  definition: templateDefinition,
});

export const attachment = z.object({
  id,
  clientId: z.string(),
  photoKey: z.string(),
  contentType: z.string(),
  byteSize: z.number().int(),
  capturedAt: z.iso.datetime({ offset: true }).nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  url: z.string(),
});

export const inspection = z.object({
  id,
  clientId: z.string(),
  jobId: id,
  siteId: id,
  templateId: id,
  technicianId: id,
  status: z.enum(["draft", "completed"]),
  validationStatus: z.enum(["pending", "valid", "invalid", "overridden"]),
  validationProblems: z.array(validationProblem),
  overrideReason: z.string().nullable(),
  overrideBy: id.nullable(),
  arrivedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  arrivalLat: z.number().nullable(),
  arrivalLng: z.number().nullable(),
  completionLat: z.number().nullable(),
  completionLng: z.number().nullable(),
  accessIssue: z.string().nullable(),
  values: z.record(z.string(), value),
  issues: z.array(z.object({ id, clientId: z.string(), type: z.enum(ISSUE_TYPES), severity: z.enum(ISSUE_SEVERITIES), description: z.string(), status: z.string() })),
  photos: z.array(attachment),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const templateInput = z.object({ name: z.string().trim().min(1).max(200), definition: templateDefinition });
export const overrideInput = z.object({ reason: z.string().trim().min(3).max(2000) });

export type InspectionTemplate = z.infer<typeof inspectionTemplate>;
export type Inspection = z.infer<typeof inspection>;
export type Attachment = z.infer<typeof attachment>;
