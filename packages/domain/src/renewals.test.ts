import { describe, expect, it } from "vitest";
import { renewalCharges, type RenewalTerms } from "./renewals.ts";

const terms = (over: Partial<RenewalTerms> = {}): RenewalTerms => ({
  planId: null,
  planName: "Standard",
  customerType: "residential",
  termMonths: 12,
  visitsPerTerm: 2,
  priceCents: 30000,
  billingFrequency: "annual",
  serviceType: "aerobic_inspection",
  autoRenew: false,
  startOn: "2026-04-01",
  endOn: "2027-03-31",
  ...over,
});

describe("renewalCharges", () => {
  it("charges the whole term up front for annual billing, plus add-ons once with tax on taxable ones", () => {
    const c = renewalCharges(terms(), [{ id: "00000000-0000-4000-8000-000000000001", name: "Riser lid", description: null, priceCents: 4500, taxable: true }], 825);
    expect(c.lines.map((l) => [l.description, l.unitPriceCents])).toEqual([
      ["Renewal: Standard, Apr 1, 2026 to Mar 31, 2027", 30000],
      ["Riser lid", 4500],
    ]);
    expect(c.lines[0]!.installment).toEqual({ number: 1, count: 1, periodStart: "2026-04-01", periodEnd: "2027-03-31" });
    expect(c.totals).toMatchObject({ subtotalCents: 34500, taxCents: 371, totalCents: 34871 });
  });

  it("charges only the first installment of a plan billed in parts", () => {
    const c = renewalCharges(terms({ billingFrequency: "quarterly", priceCents: 30001 }), [], 0);
    expect(c.installments).toBe(4);
    // The rounding remainder goes on the first installment.
    expect(c.lines[0]).toMatchObject({ unitPriceCents: 7501, description: "Renewal: Standard, Apr 1, 2026 to Jun 30, 2026 (payment 1 of 4)" });
    expect(c.totals.totalCents).toBe(7501);
  });
});
