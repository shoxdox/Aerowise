import { describe, expect, it } from "vitest";
import { addMonths, buildTermSchedule, contractState, visitsWithin } from "./schedule.ts";

describe("addMonths", () => {
  it("clamps to the end of shorter months", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-08-31", 4)).toBe("2026-12-31");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
  });
});

describe("buildTermSchedule", () => {
  it("splits an annual contract into three four-month visit windows", () => {
    const s = buildTermSchedule("2026-01-15", 12, 3);
    expect(s.endOn).toBe("2027-01-14");
    expect(s.visits).toEqual([
      { sequence: 1, windowStart: "2026-01-15", windowEnd: "2026-05-14", dueOn: "2026-05-14" },
      { sequence: 2, windowStart: "2026-05-15", windowEnd: "2026-09-14", dueOn: "2026-09-14" },
      { sequence: 3, windowStart: "2026-09-15", windowEnd: "2027-01-14", dueOn: "2027-01-14" },
    ]);
  });

  it("leaves no gaps or overlaps between windows, even from a month-end start", () => {
    const s = buildTermSchedule("2026-08-31", 24, 6);
    expect(s.visits).toHaveLength(6);
    expect(s.visits[0]!.windowStart).toBe("2026-08-31");
    expect(s.visits.at(-1)!.windowEnd).toBe(s.endOn);
    for (let i = 1; i < s.visits.length; i++) {
      const prevEnd = new Date(s.visits[i - 1]!.windowEnd);
      prevEnd.setUTCDate(prevEnd.getUTCDate() + 1);
      expect(prevEnd.toISOString().slice(0, 10)).toBe(s.visits[i]!.windowStart);
    }
  });

  it("rejects visit counts that do not divide the term evenly", () => {
    expect(() => buildTermSchedule("2026-01-01", 12, 5)).toThrow();
  });
});

describe("contractState", () => {
  const c = { status: "active" as const, startOn: "2026-01-15", endOn: "2027-01-14" };
  it("derives upcoming, active and expired from the dates", () => {
    expect(contractState(c, "2026-01-14")).toBe("upcoming");
    expect(contractState(c, "2026-01-15")).toBe("active");
    expect(contractState(c, "2027-01-14")).toBe("active");
    expect(contractState(c, "2027-01-15")).toBe("expired");
    expect(contractState({ ...c, status: "cancelled" }, "2026-06-01")).toBe("cancelled");
  });
});

describe("visitsWithin", () => {
  it("keeps the plan's visits when its windows already fit the authority's interval", () => {
    expect(visitsWithin(12, 3, 4)).toBe(3);
    expect(visitsWithin(24, 6, 4)).toBe(6);
    expect(visitsWithin(12, 12, 3)).toBe(12);
  });

  it("adds the fewest visits that give equal windows within the interval", () => {
    expect(visitsWithin(12, 3, 3)).toBe(4);
    expect(visitsWithin(12, 3, 1)).toBe(12);
    expect(visitsWithin(24, 6, 3)).toBe(8);
    expect(visitsWithin(12, 1, 5)).toBe(3);
    expect(visitsWithin(12, 2, 6)).toBe(2);
    expect(visitsWithin(18, 3, 4)).toBe(6);
  });

  it("falls back to monthly visits when nothing coarser divides the term", () => {
    expect(visitsWithin(7, 1, 2)).toBe(7);
    expect(visitsWithin(1, 1, 1)).toBe(1);
  });
});
