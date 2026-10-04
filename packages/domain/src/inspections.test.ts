import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE, templateDefinition, validateInspection, visibleFields, type InspectionValues } from "./inspections.ts";

const def = DEFAULT_TEMPLATE.definition;

const complete: InspectionValues = {
  aerator: "pass",
  air_filter: "pass",
  diffuser: "pass",
  alarm_controller: "pass",
  electrical: "pass",
  floats_wiring: "pass",
  treatment_tank: "pass",
  pump_tank: "pass",
  lids_openings: "pass",
  tank_condition: "pass",
  effluent_pump: "pass",
  chlorinator: "working",
  chlorine_level: 1.5,
  dispersal_field: "pass",
  odor: "none",
  pumping_needed: false,
};

describe("default template", () => {
  it("is a valid template definition", () => {
    expect(() => templateDefinition.parse(def)).not.toThrow();
  });

  it("accepts a complete inspection with its photos", () => {
    expect(validateInspection(def, complete, { overview: 1, chlorinator: 1 })).toEqual([]);
  });

  it("reports missing required fields", () => {
    const partial = { ...complete, aerator: null, odor: null };
    const problems = validateInspection(def, partial, { overview: 1, chlorinator: 1 });
    expect(problems.map((p) => [p.key, p.problem])).toEqual([
      ["aerator", "missing"],
      ["odor", "missing"],
    ]);
  });

  it("shows and requires chlorine fields only when a chlorinator is present", () => {
    const without = { ...complete, chlorinator: "not_present", chlorine_level: null };
    expect(visibleFields(def, without).map((f) => f.key)).not.toContain("chlorine_level");
    expect(validateInspection(def, without, { overview: 1 })).toEqual([]);
    const withMissingLevel = { ...complete, chlorine_level: null };
    expect(validateInspection(def, withMissingLevel, { overview: 1, chlorinator: 1 }).map((p) => p.key)).toEqual(["chlorine_level"]);
  });

  it("enforces required photo counts, including conditional ones", () => {
    expect(validateInspection(def, complete, { overview: 1 }).map((p) => [p.key, p.problem])).toEqual([["chlorinator", "photos"]]);
    const failed = { ...complete, aerator: "fail" };
    expect(validateInspection(def, failed, { overview: 1, chlorinator: 1 }).map((p) => p.key)).toEqual(["aerator_failure"]);
  });

  it("rejects out-of-range and wrongly typed values", () => {
    const bad = { ...complete, chlorine_level: 99, aerator: "maybe", pumping_needed: "no" };
    expect(validateInspection(def, bad, { overview: 1, chlorinator: 1 }).map((p) => [p.key, p.problem])).toEqual([
      ["aerator", "invalid"],
      ["chlorine_level", "invalid"],
      ["pumping_needed", "invalid"],
    ]);
  });
});

describe("template definitions", () => {
  it("rejects duplicate keys and conditions on unknown fields", () => {
    const dup = { fields: [{ key: "a", label: "A", section: "S", type: "boolean" }, { key: "a", label: "A2", section: "S", type: "boolean" }], photos: [] };
    expect(templateDefinition.safeParse(dup).success).toBe(false);
    const dangling = { fields: [{ key: "a", label: "A", section: "S", type: "boolean", showWhen: { field: "zzz", in: [true] } }], photos: [] };
    expect(templateDefinition.safeParse(dangling).success).toBe(false);
  });
});
