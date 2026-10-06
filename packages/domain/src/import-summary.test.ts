import { describe, expect, it } from "vitest";
import { onboardingCounts } from "./import-summary.ts";

describe("onboardingCounts", () => {
  const contract = (startOn: string, endOn: string, extra: { status?: "active" | "cancelled"; serviceEndsOn?: string } = {}) => ({
    status: extra.status ?? ("active" as const),
    startOn,
    endOn,
    serviceEndsOn: extra.serviceEndsOn ?? null,
  });

  it("counts active and expiring contracts, inclusive of each window's last day", () => {
    const counts = onboardingCounts({
      today: "2026-02-10",
      contracts: [
        contract("2025-03-13", "2026-03-12"), // 30 days
        contract("2025-03-14", "2026-03-13"), // 31 days
        contract("2025-05-11", "2026-05-11"), // 90 days
        contract("2025-05-12", "2026-05-12"), // 91 days
        contract("2026-03-01", "2027-02-28"), // not started
        contract("2025-01-01", "2025-12-31"), // ended
        contract("2025-06-01", "2026-05-31", { status: "cancelled" }),
        contract("2025-06-01", "2026-05-31", { serviceEndsOn: "2026-02-09" }),
      ],
      visits: [],
      sites: [],
    });
    expect(counts).toMatchObject({ activeContracts: 4, expiring: { within30: 1, within60: 2, within90: 3 } });
  });

  it("counts late visits and visits due by the end of this month", () => {
    const counts = onboardingCounts({
      today: "2026-02-10",
      contracts: [],
      visits: [{ dueOn: "2026-02-09" }, { dueOn: "2026-02-10" }, { dueOn: "2026-02-28" }, { dueOn: "2026-03-01" }],
      sites: [
        { hasAuthority: true, permitNumber: "P-1" },
        { hasAuthority: false, permitNumber: null },
        { hasAuthority: false, permitNumber: "P-2" },
      ],
    });
    expect(counts).toMatchObject({ overdueVisits: 1, dueThisMonth: 2, sitesWithoutAuthority: 2, sitesWithoutPermit: 1 });
  });
});
