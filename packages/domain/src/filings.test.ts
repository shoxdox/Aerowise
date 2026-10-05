import { describe, expect, it } from "vitest";
import { applyRequirements, canTransitionFiling, deadlineState, FILING_STATE_MACHINE, FILING_STATUSES, filingFees, labTestRequirement, lateFeeOwed, rulesetRules, serviceIntervalMonths } from "./filings.ts";
import { DEFAULT_TEMPLATE, validateInspection } from "./inspections.ts";

describe("filing state machine", () => {
  it("only reaches confirmed through sent", () => {
    const into = (to: string) => FILING_STATUSES.filter((s) => canTransitionFiling(s, to as never));
    expect(into("confirmed")).toEqual(["sent"]);
    expect(into("sent")).toEqual(["ready", "submitting"]);
    expect(FILING_STATE_MACHINE.transitions.confirmed).toEqual([]);
  });

  it("lets every failure branch get back to sending", () => {
    for (const s of ["failed", "rejected", "needs_review"] as const) {
      expect(FILING_STATE_MACHINE.transitions[s].length).toBeGreaterThan(0);
    }
    expect(canTransitionFiling("ready", "confirmed")).toBe(false);
    expect(canTransitionFiling("queued", "sent")).toBe(false);
  });
});

describe("applyRequirements", () => {
  const def = DEFAULT_TEMPLATE.definition;

  it("makes the authority's fields required and raises photo minimums", () => {
    const out = applyRequirements(def, { requiredFields: ["air_pressure"], requiredPhotos: [{ key: "overview", minCount: 3 }] });
    expect(out.fields.find((f) => f.key === "air_pressure")!.required).toBe(true);
    expect(out.photos.find((p) => p.key === "overview")!.minCount).toBe(3);
    // The template itself is untouched.
    expect(def.fields.find((f) => f.key === "air_pressure")!.required).toBe(false);
  });

  it("keeps conditional fields conditional", () => {
    const out = applyRequirements(def, { requiredFields: ["chlorine_level"], requiredPhotos: [] });
    const problems = validateInspection(out, { chlorinator: "not_present" }, {});
    expect(problems.map((p) => p.key)).not.toContain("chlorine_level");
  });

  it("is the template unchanged when there is no authority", () => {
    expect(applyRequirements(def, null)).toBe(def);
  });
});

describe("deadlineState", () => {
  it("warns from the threshold day and is overdue after the deadline", () => {
    expect(deadlineState("ready", "2026-03-15", 5, "2026-03-09")).toBe("ok");
    expect(deadlineState("ready", "2026-03-15", 5, "2026-03-10")).toBe("approaching");
    expect(deadlineState("failed", "2026-03-15", 5, "2026-03-15")).toBe("approaching");
    expect(deadlineState("pending", "2026-03-15", 5, "2026-03-16")).toBe("overdue");
  });

  it("is met once the filing has been sent, even if it is not confirmed yet", () => {
    expect(deadlineState("sent", "2026-03-15", 5, "2026-04-01")).toBe("met");
    expect(deadlineState("confirmed", "2026-03-15", 5, "2026-04-01")).toBe("met");
  });
});

describe("serviceIntervalMonths", () => {
  const rules = (service: Record<string, unknown>) =>
    rulesetRules.parse({
      jurisdiction: { key: "tx-fixture", state: "TX", authorityName: "Fixture (fictional)", type: "county" },
      version: 1,
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
      sourceReference: "FICTIONAL",
      applicability: { counties: ["Fixture County"] },
      service,
      inspection: {},
      filing: { deadlineDays: 14, warningDays: 5 },
      submission: { method: "manual_export" },
      customerCopy: { required: true },
      confirmation: { mode: "manual_reference" },
    });

  it("uses the ruleset's interval, and its commercial interval for commercial systems", () => {
    expect(serviceIntervalMonths(rules({ intervalMonths: 4 }), "residential")).toBe(4);
    expect(serviceIntervalMonths(rules({ intervalMonths: 4 }), "commercial")).toBe(4);
    expect(serviceIntervalMonths(rules({ intervalMonths: 3 }), "residential")).toBe(3);
    expect(serviceIntervalMonths(rules({ intervalMonths: 4, commercialIntervalMonths: 1 }), "residential")).toBe(4);
    expect(serviceIntervalMonths(rules({ intervalMonths: 4, commercialIntervalMonths: 1 }), "commercial")).toBe(1);
  });

  it("allows the longer monitored interval only where the ruleset names the system type", () => {
    const monitored = { intervalMonths: 4, monitored: { intervalMonths: 6, appliesTo: ["residential"] } };
    expect(serviceIntervalMonths(rules(monitored), "residential", true)).toBe(6);
    expect(serviceIntervalMonths(rules(monitored), "residential", false)).toBe(4);
    expect(serviceIntervalMonths(rules(monitored), "commercial", true)).toBe(4);
    expect(serviceIntervalMonths(rules({ intervalMonths: 4 }), "residential", true)).toBe(4);
  });

  it("rejects intervals outside 1 to 24 months", () => {
    expect(() => rules({ intervalMonths: 0 })).toThrow();
    expect(() => rules({ intervalMonths: 4, commercialIntervalMonths: 25 })).toThrow();
  });
});

describe("labTestRequirement", () => {
  const rules = (labTests?: Record<string, unknown>) =>
    rulesetRules.parse({
      jurisdiction: { key: "tx-fixture", state: "TX", authorityName: "Fixture (fictional)", type: "county" },
      version: 1,
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
      sourceReference: "FICTIONAL",
      applicability: { counties: ["Fixture County"] },
      service: { intervalMonths: 4 },
      labTests,
      inspection: {},
      filing: { deadlineDays: 14, warningDays: 5 },
      submission: { method: "manual_export" },
      customerCopy: { required: true },
      confirmation: { mode: "manual_reference" },
    });

  it("applies only to the system types the ruleset names", () => {
    const commercialOnly = rules({ analytes: ["bod", "tss"], everyMonths: 12, appliesTo: ["commercial"] });
    expect(labTestRequirement(commercialOnly, "commercial")).toMatchObject({ analytes: ["bod", "tss"], everyMonths: 12 });
    expect(labTestRequirement(commercialOnly, "residential")).toBeNull();
    expect(labTestRequirement(rules(), "commercial")).toBeNull();
  });

  it("rejects unknown analytes and empty lists", () => {
    expect(() => rules({ analytes: ["cod"], everyMonths: 12, appliesTo: ["residential"] })).toThrow();
    expect(() => rules({ analytes: [], everyMonths: 12, appliesTo: ["residential"] })).toThrow();
    expect(() => rules({ analytes: ["bod"], everyMonths: 12, appliesTo: [] })).toThrow();
  });
});

describe("filing fees", () => {
  const rules = (fees?: Record<string, unknown>) =>
    rulesetRules.parse({
      jurisdiction: { key: "tx-fixture", state: "TX", authorityName: "Fixture (fictional)", type: "county" },
      version: 1,
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
      sourceReference: "FICTIONAL",
      applicability: { counties: ["Fixture County"] },
      service: { intervalMonths: 4 },
      fees,
      inspection: {},
      filing: { deadlineDays: 14, warningDays: 5 },
      submission: { method: "manual_export" },
      customerCopy: { required: true },
      confirmation: { mode: "manual_reference" },
    });

  it("come from the ruleset per kind of filing, or not at all", () => {
    const r = rules({ inspectionReport: { filingCents: 1000, lateCents: 2500 }, contract: { filingCents: 500 }, basis: "Fee schedule" });
    expect(filingFees(r, "inspection_report")).toEqual({ filingFeeCents: 1000, lateFeeRuleCents: 2500, feeBasis: "Fee schedule" });
    expect(filingFees(r, "contract")).toEqual({ filingFeeCents: 500, lateFeeRuleCents: 0, feeBasis: "Fee schedule" });
    expect(filingFees(rules({ contract: { filingCents: 500 }, basis: "x" }), "inspection_report")).toBeNull();
    expect(filingFees(rules(), "inspection_report")).toBeNull();
    expect(() => rules({ inspectionReport: { filingCents: -1 }, basis: "x" })).toThrow();
    expect(() => rules({ inspectionReport: { filingCents: 10 } })).toThrow();
  });

  it("add the late fee only when sent after the deadline day", () => {
    expect(lateFeeOwed(2500, "2026-03-15", "2026-03-15")).toBe(0);
    expect(lateFeeOwed(2500, "2026-03-15", "2026-03-16")).toBe(2500);
    expect(lateFeeOwed(null, "2026-03-15", "2026-03-16")).toBe(0);
    expect(lateFeeOwed(2500, null, "2026-03-16")).toBe(0);
  });
});
