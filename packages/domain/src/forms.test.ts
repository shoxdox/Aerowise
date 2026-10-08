import { describe, expect, it } from "vitest";
import {
  BUILT_IN_FORMS,
  canonicalJson,
  GENERIC_REPAIR_TEMPLATE,
  GENERIC_SERVICE_CALL_TEMPLATE,
  keyAllowedForPurpose,
  signatureCapture,
  signatureProblems,
  snapshotSha256,
  STARTER_WORK_TEMPLATES,
} from "./forms.ts";
import { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_KEY, templateDefinition, validateInspection } from "./inspections.ts";

describe("template definitions with signatures", () => {
  it("reads a definition saved before signatures existed exactly as before", () => {
    const parsed = templateDefinition.parse(DEFAULT_TEMPLATE.definition);
    expect(parsed).toEqual(DEFAULT_TEMPLATE.definition);
    expect("signatures" in parsed).toBe(false);
  });

  it("rejects a signature key used twice, or shared with a field", () => {
    const base = { fields: [{ key: "notes", label: "Notes", section: "A", type: "text" }], photos: [] };
    const twice = templateDefinition.safeParse({
      ...base,
      signatures: [
        { key: "customer", label: "Customer", signer: "customer" },
        { key: "customer", label: "Again", signer: "technician" },
      ],
    });
    expect(twice.success).toBe(false);
    const clash = templateDefinition.safeParse({ ...base, signatures: [{ key: "notes", label: "Customer", signer: "customer" }] });
    expect(clash.success).toBe(false);
    const ok = templateDefinition.parse({ ...base, signatures: [{ key: "customer", label: "Customer", signer: "customer" }] });
    expect(ok.signatures).toEqual([{ key: "customer", label: "Customer", signer: "customer", required: false }]);
  });

  it("reports a required signature that is missing, and nothing for an optional one", () => {
    const def = templateDefinition.parse({
      fields: [{ key: "notes", label: "Notes", section: "A", type: "text" }],
      photos: [],
      signatures: [
        { key: "customer", label: "Customer sign-off", signer: "customer", required: true },
        { key: "tech", label: "Technician", signer: "technician" },
      ],
    });
    expect(signatureProblems(def, new Set())).toEqual([{ key: "customer", label: "Customer sign-off", problem: "missing", message: "Customer sign-off is required" }]);
    expect(signatureProblems(def, new Set(["customer"]))).toEqual([]);
  });
});

describe("starter work templates", () => {
  it("are valid definitions under work keys that no release reads as the inspection form", () => {
    for (const t of STARTER_WORK_TEMPLATES) {
      expect(templateDefinition.parse(t.definition)).toEqual(templateDefinition.parse(t.definition));
      expect(t.purpose).toBe("work");
      expect(t.key).not.toBe(DEFAULT_TEMPLATE_KEY);
      expect(keyAllowedForPurpose(t.key, t.purpose)).toBe(true);
    }
    expect(new Set(STARTER_WORK_TEMPLATES.map((t) => t.key)).size).toBe(STARTER_WORK_TEMPLATES.length);
  });

  it("are built in beside the inspection form, each key once and with its own purpose", () => {
    expect(BUILT_IN_FORMS.map((f) => [f.key, f.purpose])).toEqual([
      [DEFAULT_TEMPLATE_KEY, "inspection"],
      ["work-repair", "work"],
      ["work-service-call", "work"],
      ["work-pumping", "work"],
    ]);
    expect(BUILT_IN_FORMS[0]).toMatchObject({ version: DEFAULT_TEMPLATE.version, definition: DEFAULT_TEMPLATE.definition });
  });

  it("never lets a work or intake form take the inspection form's key", () => {
    expect(keyAllowedForPurpose(DEFAULT_TEMPLATE_KEY, "inspection")).toBe(true);
    expect(keyAllowedForPurpose(DEFAULT_TEMPLATE_KEY, "work")).toBe(false);
    expect(keyAllowedForPurpose(DEFAULT_TEMPLATE_KEY, "intake")).toBe(false);
  });

  it("repair asks for the follow-up reason only when a follow-up is needed, and for before and after photos", () => {
    const def = templateDefinition.parse(GENERIC_REPAIR_TEMPLATE.definition);
    const base = { problem: "Alarm sounding", work_performed: "Replaced float switch" };
    const noFollowUp = validateInspection(def, { ...base, follow_up_needed: false }, { before: 1, after: 1 });
    expect(noFollowUp).toEqual([]);
    const followUp = validateInspection(def, { ...base, follow_up_needed: true }, { before: 1 });
    expect(followUp.map((p) => p.key).sort()).toEqual(["after", "follow_up_notes"]);
  });

  it("service call needs a known outcome", () => {
    const def = templateDefinition.parse(GENERIC_SERVICE_CALL_TEMPLATE.definition);
    const problems = validateInspection(def, { reason: "Odor", findings: "Lid seal worn", outcome: "maybe" }, {});
    expect(problems).toEqual([expect.objectContaining({ key: "outcome", problem: "invalid" })]);
    expect(validateInspection(def, { reason: "Odor", findings: "Lid seal worn", outcome: "resolved" }, {})).toEqual([]);
  });
});

describe("signed summary hash", () => {
  const summary = { workDone: "Replaced float switch", parts: [{ name: "Float switch", qty: 1 }], notes: undefined, volume: { gallons: 750 } };

  it("ignores key order and undefined members", () => {
    expect(canonicalJson(summary)).toBe('{"parts":[{"name":"Float switch","qty":1}],"volume":{"gallons":750},"workDone":"Replaced float switch"}');
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
  });

  it("is the sha256 of the canonical JSON, whatever the key order", async () => {
    // sha256 of the canonical text above, computed independently.
    const expected = "5610be9eb04d062b5ed8f9f743c7e78a048b274844d951650d083def3f1a3781";
    expect(await snapshotSha256(summary)).toBe(expected);
    expect(await snapshotSha256({ volume: { gallons: 750 }, workDone: "Replaced float switch", parts: [{ qty: 1, name: "Float switch" }] })).toBe(expected);
    expect(await snapshotSha256({ ...summary, volume: { gallons: 751 } })).not.toBe(expected);
  });
});

describe("signature capture", () => {
  it("accepts a typed signature or a PNG drawing, and nothing else", () => {
    expect(signatureCapture.safeParse({ kind: "typed" }).success).toBe(true);
    expect(signatureCapture.safeParse({ kind: "drawn", image: "data:image/png;base64,iVBORw0KGgo=" }).success).toBe(true);
    expect(signatureCapture.safeParse({ kind: "drawn", image: "data:image/svg+xml;base64,PHN2Zz4=" }).success).toBe(false);
    expect(signatureCapture.safeParse({ kind: "drawn" }).success).toBe(false);
  });
});
