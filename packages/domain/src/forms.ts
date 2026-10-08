import { z } from "zod";
import { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_KEY, inspectionTemplate, templateInput, type SignatureRequirement, type TemplateDefinition, type ValidationProblem } from "./inspections.ts";

// The shared form foundation (SW-F). Inspections, work orders and agreement intake all use the
// same versioned template definition. What sets them apart is the template's purpose and its key:
// every earlier release picks the inspection form by DEFAULT_TEMPLATE_KEY, so a work or intake
// form must never be saved under that key, or an older app could show it as the inspection.

export const TEMPLATE_PURPOSES = ["inspection", "work", "intake"] as const;
export type TemplatePurpose = (typeof TEMPLATE_PURPOSES)[number];
export const templatePurpose = z.enum(TEMPLATE_PURPOSES);

/** Keys only inspection templates may use: the one every release reads as "the inspection form". */
const INSPECTION_ONLY_KEYS: ReadonlySet<string> = new Set([DEFAULT_TEMPLATE_KEY]);

/** Whether a template with this purpose may be saved under this key. */
export const keyAllowedForPurpose = (key: string, purpose: TemplatePurpose) => purpose === "inspection" || !INSPECTION_ONLY_KEYS.has(key);

/** The signatures a form asks for. */
export const signatureRequirements = (def: TemplateDefinition): SignatureRequirement[] => def.signatures ?? [];

/** Required signatures not yet given, as problems the phone and the API both report the same way. */
export function signatureProblems(def: TemplateDefinition, signedKeys: ReadonlySet<string>): ValidationProblem[] {
  return signatureRequirements(def)
    .filter((s) => s.required && !signedKeys.has(s.key))
    .map((s) => ({ key: s.key, label: s.label, problem: "missing" as const, message: `${s.label} is required` }));
}

/**
 * JSON with object keys sorted and undefined members left out, so the same content always gives
 * the same text on the phone and on the server. Matches the canonical form renewals already hash.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The sha256 (hex) of the summary a signer saw. The phone computes it before the customer signs
 * and the server recomputes it from the record it receives; a different value means the summary
 * changed after signing. Uses Web Crypto, available in browsers and in Node.
 */
export async function snapshotSha256(summary: unknown): Promise<string> {
  // This package has no DOM or Node typings; both runtimes provide these globals.
  const web = globalThis as unknown as {
    crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
    TextEncoder: new () => { encode(text: string): Uint8Array };
  };
  const digest = await web.crypto.subtle.digest("SHA-256", new web.TextEncoder().encode(canonicalJson(summary)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A drawn or typed signature as captured: a drawn one is a PNG data URL from the signature pad. */
export const signatureCapture = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("typed") }),
  z.object({
    kind: z.literal("drawn"),
    image: z.string().max(300_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/),
  }),
]);
export type SignatureCapture = z.infer<typeof signatureCapture>;

export interface StarterTemplate {
  key: string;
  version: number;
  name: string;
  purpose: TemplatePurpose;
  definition: TemplateDefinition;
}

const text = (key: string, label: string, section: string, required = false, help?: string) =>
  ({ key, label, section, type: "text", required, maxLength: 2000, ...(help ? { help } : {}) }) as const;

/** A repair visit: what was wrong, why, what was used and done, with photos before and after. */
export const GENERIC_REPAIR_TEMPLATE: StarterTemplate = {
  key: "work-repair",
  version: 1,
  name: "Repair",
  purpose: "work",
  definition: {
    fields: [
      text("problem", "Problem found", "Repair", true),
      text("cause", "Likely cause", "Repair"),
      text("work_performed", "Work performed", "Repair", true),
      text("parts_used", "Parts used", "Repair", false, "One part per line, with the quantity."),
      { key: "follow_up_needed", label: "Follow-up visit needed", section: "Repair", type: "boolean", required: true },
      { ...text("follow_up_notes", "What the follow-up is for", "Repair", true), showWhen: { field: "follow_up_needed", in: [true] } },
    ],
    photos: [
      { key: "before", label: "Before the repair", minCount: 1 },
      { key: "after", label: "After the repair", minCount: 1 },
    ],
    signatures: [{ key: "customer_signoff", label: "Customer sign-off", signer: "customer", required: false }],
  },
};

/** A service call: why the customer called, what was found and how it was left. */
export const GENERIC_SERVICE_CALL_TEMPLATE: StarterTemplate = {
  key: "work-service-call",
  version: 1,
  name: "Service call",
  purpose: "work",
  definition: {
    fields: [
      text("reason", "Reason for the call", "Service call", true),
      text("findings", "What was found", "Service call", true),
      {
        key: "outcome",
        label: "Outcome",
        section: "Service call",
        type: "select",
        required: true,
        options: [
          { value: "resolved", label: "Resolved" },
          { value: "follow_up", label: "Needs a follow-up visit" },
          { value: "estimate", label: "Needs an estimate" },
        ],
      },
      text("notes", "Notes", "Service call"),
    ],
    photos: [{ key: "site", label: "Site photos", minCount: 0 }],
    signatures: [{ key: "customer_signoff", label: "Customer sign-off", signer: "customer", required: false }],
  },
};

export const STARTER_WORK_TEMPLATES: readonly StarterTemplate[] = [GENERIC_REPAIR_TEMPLATE, GENERIC_SERVICE_CALL_TEMPLATE];

/** Every built-in form, one row each in inspection_templates (organization_id null). */
export const BUILT_IN_FORMS: readonly StarterTemplate[] = [{ ...DEFAULT_TEMPLATE, purpose: "inspection" }, ...STARTER_WORK_TEMPLATES];

/** A form key: lower-case words joined by hyphens, as the built-in keys are. */
export const formKey = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Use lower-case letters, digits and hyphens");

/** A form version as the API returns it: an inspection template with its purpose. */
export const formTemplate = inspectionTemplate.extend({ purpose: templatePurpose });
export type FormTemplate = z.infer<typeof formTemplate>;

/** A new version of an existing work or intake form. */
export const formVersionInput = templateInput;
