import { describe, expect, it } from "vitest";
import { applyRequirements, canTransitionFiling, deadlineState, FILING_STATE_MACHINE, FILING_STATUSES } from "./filings.ts";
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
