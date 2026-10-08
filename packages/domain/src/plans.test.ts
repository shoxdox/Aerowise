import { describe, expect, it } from "vitest";
import { coverageRule, coverageSummary, coverLine, intakeAnswers, intakeFormInput, matchingRules, planOption, planVersionInput, type CoverageRule } from "./plans.ts";

const rule = (r: object) => coverageRule.parse(r);
const ITEM = "11111111-1111-4111-8111-111111111111";

describe("coverage rules", () => {
  const rules: (CoverageRule & { id: string })[] = [
    { ...rule({ ruleKey: "no-riser", label: "Risers", match: { serviceItemId: ITEM }, effect: "excluded" }), id: "a" },
    { ...rule({ ruleKey: "repairs", label: "Repairs", match: { category: "repair" }, effect: "included", limit: { count: 2, per: "term" } }), id: "b" },
    { ...rule({ ruleKey: "pumping", label: "Pumping", match: { category: "pumping" }, effect: "percent_off", percentOff: 15 }), id: "c" },
  ];

  it("lets the first rule that fits a line decide it, an exclusion included", () => {
    expect(coverLine(rules, { category: "repair", serviceItemId: ITEM, unitPriceCents: 12000 }, "Gold")).toEqual({ ruleKey: "no-riser", effect: "excluded", unitPriceCents: 12000, note: null });
    expect(coverLine(rules, { category: "repair", serviceItemId: null, unitPriceCents: 12000 }, "Gold")).toEqual({ ruleKey: "repairs", effect: "included", unitPriceCents: 0, note: "Covered by Gold: Repairs" });
    expect(coverLine(rules, { category: "installation", serviceItemId: null, unitPriceCents: 12000 }, "Gold")).toEqual({ ruleKey: null, effect: null, unitPriceCents: 12000, note: null });
  });

  it("takes a percentage off, rounding half a cent in the customer's favor", () => {
    // 15% of 35 cents is 5.25 cents: 6 cents off.
    expect(coverLine(rules, { category: "pumping", serviceItemId: null, unitPriceCents: 35 }, "Gold")).toMatchObject({ unitPriceCents: 29, note: "15% off with Gold: Pumping" });
  });

  it("matches by the work order's kind of work or a line's item or category, never an exclusion", () => {
    expect(matchingRules(rules, { category: "other", lines: [{ serviceItemId: ITEM, category: "repair" }] }).map((r) => r.id)).toEqual(["b"]);
    expect(matchingRules(rules, { category: "pumping", lines: [] }).map((r) => r.id)).toEqual(["c"]);
    expect(matchingRules(rules, { category: "installation", lines: [{ serviceItemId: null, category: null }] })).toEqual([]);
  });

  it("checks what a rule says", () => {
    expect(coverageRule.safeParse({ ruleKey: "x", label: "X", match: { category: "repair" }, effect: "percent_off" }).success).toBe(false);
    expect(coverageRule.safeParse({ ruleKey: "x", label: "X", match: { category: "repair" }, effect: "included", percentOff: 10 }).success).toBe(false);
    expect(coverageRule.safeParse({ ruleKey: "x", label: "X", match: { category: "repair" }, effect: "excluded", limit: { count: 1, per: "term" } }).success).toBe(false);
    expect(coverageRule.safeParse({ ruleKey: "X Y", label: "X", match: { category: "repair" }, effect: "included" }).success).toBe(false);
    expect(coverageRule.safeParse({ ruleKey: "x", label: "X", match: { category: "repair", serviceItemId: ITEM }, effect: "included" }).success).toBe(false);
    expect(coverageSummary(rules[1]!)).toBe("Repairs: Repair work, no charge, up to 2 work orders per term");
    expect(coverageSummary(rules[0]!, "Riser")).toBe("Risers: Riser, not covered");
  });

  it("keeps keys unique within a version and required options ticked", () => {
    const opt = { optionKey: "a", name: "A", priceCents: 100 };
    expect(planVersionInput.safeParse({ termsText: null, options: [opt, opt], coverage: [] }).success).toBe(false);
    expect(planOption.safeParse({ ...opt, required: true, default: false }).success).toBe(false);
    expect(planOption.parse({ ...opt, required: true, default: true })).toMatchObject({ required: true, default: true, taxable: false, description: null });
  });
});

describe("intake answers", () => {
  const def = {
    photos: [],
    fields: [
      { key: "changes", label: "Changes?", section: "S", type: "boolean" as const, required: true },
      { key: "what", label: "What?", section: "S", type: "text" as const, maxLength: 100, required: true, showWhen: { field: "changes", in: [true] } },
      { key: "gallons", label: "Tank size", section: "S", type: "number" as const, unit: "gal", required: false },
    ],
  };

  it("checks answers like an inspection, keeps only shown questions and says how each reads", () => {
    expect(intakeAnswers(def, {}).problems.map((p) => p.key)).toEqual(["changes"]);
    expect(intakeAnswers(def, { changes: true }).problems.map((p) => p.key)).toEqual(["what"]);
    expect(intakeAnswers(def, { changes: false, what: "dropped", gallons: 1000 })).toEqual({
      problems: [],
      answers: [
        { key: "changes", label: "Changes?", value: false, answer: "No" },
        { key: "gallons", label: "Tank size", value: 1000, answer: "1000 gal" },
      ],
    });
  });

  it("refuses photos and signatures on an intake form", () => {
    const base = { key: "intake-a", name: "A", definition: def };
    expect(intakeFormInput.safeParse(base).success).toBe(true);
    expect(intakeFormInput.safeParse({ ...base, definition: { ...def, photos: [{ key: "p", label: "P", minCount: 1 }] } }).success).toBe(false);
    expect(intakeFormInput.safeParse({ ...base, definition: { ...def, signatures: [{ key: "s", label: "S", signer: "customer" }] } }).success).toBe(false);
  });
});
