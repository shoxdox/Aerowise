import { describe, expect, it } from "vitest";
import { formatDate, formatDateOf, humanize, ROLE_LABELS, statusLabel } from "./labels.ts";

describe("status labels", () => {
  it("reads a known status as its label and tone", () => {
    expect(statusLabel("workOrder", "open")).toEqual({ label: "Ready to schedule", tone: "neutral" });
    expect(statusLabel("job", "in_progress")).toEqual({ label: "In progress", tone: "info" });
    expect(statusLabel("customer", "active").label).toBe("Active");
    expect(ROLE_LABELS.read_only).toBe("Read-only");
  });

  it("never shows a raw value it has no label for", () => {
    expect(statusLabel("customer", "on_hold")).toEqual({ label: "On hold", tone: "neutral" });
    expect(humanize("locked_gate")).toBe("Locked gate");
  });
});

describe("dates", () => {
  it("formats a calendar date without shifting it", () => {
    expect(formatDate("2026-10-25")).toBe("Oct 25, 2026");
  });

  it("takes a moment's day in the company's zone, not UTC", () => {
    // 8:30 PM in Texas is already the next day in UTC.
    const evening = new Date("2026-10-16T01:30:00Z");
    expect(formatDateOf(evening, "America/Chicago")).toBe("Oct 15, 2026");
    expect(evening.toISOString().slice(0, 10)).toBe("2026-10-16");
  });
});
