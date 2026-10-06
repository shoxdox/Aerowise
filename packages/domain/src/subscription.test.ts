import { describe, expect, it } from "vitest";
import {
  BILLABLE_STATES,
  billingMonth,
  canChangePlan,
  DEFAULT_SUBSCRIPTION_CONFIG,
  daysLeft,
  effectivePrice,
  initialPlan,
  isReadOnly,
  monthlyCharge,
  PLATFORM_FEE_MAX_BPS,
  platformFeeCents,
  SUBSCRIPTION_STATES,
  subscriptionPlanInput,
  type SubscriptionState,
} from "./subscription.ts";

describe("plan state changes", () => {
  it("allows the brief's lifecycle: trial to active to past_due to read_only and back", () => {
    const path: SubscriptionState[] = ["trial", "active", "past_due", "read_only", "active"];
    for (let i = 1; i < path.length; i++) expect(canChangePlan(path[i - 1]!, path[i]!), `${path[i - 1]} → ${path[i]}`).toBe(true);
    expect(canChangePlan("design_partner", "active")).toBe(true);
    expect(canChangePlan("design_partner", "read_only")).toBe(true);
    expect(canChangePlan("past_due", "active")).toBe(true);
  });

  it("never puts a paying account back on a free period", () => {
    expect(canChangePlan("active", "trial")).toBe(false);
    expect(canChangePlan("active", "design_partner")).toBe(false);
    expect(canChangePlan("past_due", "trial")).toBe(false);
    expect(canChangePlan("trial", "past_due")).toBe(false);
  });

  it("lets a lapsed account be given a new free period", () => {
    expect(canChangePlan("read_only", "trial")).toBe(true);
    expect(canChangePlan("read_only", "design_partner")).toBe(true);
  });

  it("always allows keeping the state to change dates or price", () => {
    for (const s of SUBSCRIPTION_STATES) expect(canChangePlan(s, s)).toBe(true);
  });

  it("is read-only only in read_only", () => {
    expect(SUBSCRIPTION_STATES.filter(isReadOnly)).toEqual(["read_only"]);
  });
});

describe("plan input", () => {
  const base = { startsOn: "2026-03-01", pricePerContractCentsOverride: null, monthlyMinimumCentsOverride: null };

  it("needs an end date for a free period", () => {
    expect(subscriptionPlanInput.safeParse({ ...base, state: "trial", endsOn: null }).success).toBe(false);
    expect(subscriptionPlanInput.safeParse({ ...base, state: "design_partner", endsOn: null }).success).toBe(false);
    expect(subscriptionPlanInput.safeParse({ ...base, state: "trial", endsOn: "2026-03-31" }).success).toBe(true);
    expect(subscriptionPlanInput.safeParse({ ...base, state: "active", endsOn: null }).success).toBe(true);
  });

  it("refuses an end before the start and negative prices", () => {
    expect(subscriptionPlanInput.safeParse({ ...base, state: "trial", endsOn: "2026-02-28" }).success).toBe(false);
    expect(subscriptionPlanInput.safeParse({ ...base, state: "active", endsOn: null, pricePerContractCentsOverride: -1 }).success).toBe(false);
    expect(subscriptionPlanInput.safeParse({ ...base, state: "active", endsOn: null, monthlyMinimumCentsOverride: 1.5 }).success).toBe(false);
  });
});

describe("plan configuration", () => {
  const config = { trialDays: 14, designPartnerDays: 60, pricePerContractCents: 200, monthlyMinimumCents: 5000, pastDueGraceDays: 14 };

  it("starts free periods from the configured lengths", () => {
    expect(initialPlan("trial", "2026-03-01", config)).toMatchObject({ state: "trial", startsOn: "2026-03-01", endsOn: "2026-03-15" });
    expect(initialPlan("design_partner", "2026-03-01", config)).toMatchObject({ state: "design_partner", endsOn: "2026-04-30" });
    expect(initialPlan("trial", "2026-03-01", DEFAULT_SUBSCRIPTION_CONFIG).endsOn).toBe("2026-03-31");
  });

  it("uses the founder price when set and the configured price otherwise", () => {
    expect(effectivePrice({ pricePerContractCentsOverride: null, monthlyMinimumCentsOverride: null }, config)).toEqual({
      pricePerContractCents: 200,
      monthlyMinimumCents: 5000,
    });
    expect(effectivePrice({ pricePerContractCentsOverride: 100, monthlyMinimumCentsOverride: 0 }, config)).toEqual({
      pricePerContractCents: 100,
      monthlyMinimumCents: 0,
    });
  });

  it("counts the days left in a free period", () => {
    expect(daysLeft({ endsOn: "2026-03-15" }, "2026-03-01")).toBe(14);
    expect(daysLeft({ endsOn: "2026-03-01" }, "2026-03-01")).toBe(0);
    expect(daysLeft({ endsOn: "2026-02-27" }, "2026-03-01")).toBe(-2);
    expect(daysLeft({ endsOn: null }, "2026-03-01")).toBeNull();
  });
});

describe("monthly charge", () => {
  const price = { pricePerContractCents: 150, monthlyMinimumCents: 9900 };

  it("charges per active contract above the minimum", () => {
    expect(monthlyCharge(100, price)).toEqual({ usageCents: 15000, minimumTopUpCents: 0, totalCents: 15000 });
    expect(monthlyCharge(66, price)).toEqual({ usageCents: 9900, minimumTopUpCents: 0, totalCents: 9900 });
  });

  it("tops a small month up to the minimum, even with no contracts", () => {
    expect(monthlyCharge(10, price)).toEqual({ usageCents: 1500, minimumTopUpCents: 8400, totalCents: 9900 });
    expect(monthlyCharge(0, price)).toEqual({ usageCents: 0, minimumTopUpCents: 9900, totalCents: 9900 });
    expect(monthlyCharge(0, { pricePerContractCents: 100, monthlyMinimumCents: 0 }).totalCents).toBe(0);
  });

  it("bills calendar months", () => {
    expect(billingMonth("2026-03-17")).toEqual({ startsOn: "2026-03-01", endsOn: "2026-03-31" });
    expect(billingMonth("2028-02-01")).toEqual({ startsOn: "2028-02-01", endsOn: "2028-02-29" });
  });

  it("charges only paying states", () => {
    expect(SUBSCRIPTION_STATES.filter((s) => BILLABLE_STATES.includes(s))).toEqual(["active", "past_due"]);
  });
});

describe("platform fee", () => {
  it("is a share of the payment in basis points, rounded down, and 0 by default", () => {
    expect(platformFeeCents(32500, 0)).toBe(0);
    expect(platformFeeCents(32500, 250)).toBe(812);
    expect(platformFeeCents(10000, PLATFORM_FEE_MAX_BPS)).toBe(1000);
    expect(platformFeeCents(9, 1000)).toBe(0);
    expect(platformFeeCents(0, 500)).toBe(0);
  });
});
