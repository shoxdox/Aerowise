import { describe, expect, it } from "vitest";
import { agreementTermRows, AUTO_RENEW_TEXT, DEFAULT_RENEWAL_TERMS, renewalAgreementTerms, renewalCharges, renewalPitch, type RenewalTerms } from "./renewals.ts";

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

describe("agreementTermRows", () => {
  const prev = { endOn: "2026-03-31" };

  it("lists the term in present tense, and says it renews automatically only when it does", () => {
    expect(agreementTermRows({ term: terms(), previousTerm: prev })).toEqual([
      { key: "plan", label: "Plan", value: "Standard" },
      { key: "term", label: "Term", value: "April 1, 2026 to March 31, 2027 (12 months)" },
      { key: "visits", label: "Visits", value: "2 maintenance visits" },
      { key: "price", label: "Price", value: "$300.00 for the term, billed yearly" },
      { key: "follows", label: "Follows", value: "The term ending March 31, 2026" },
    ]);
    expect(agreementTermRows({ term: terms({ autoRenew: true }), previousTerm: prev }).at(-1)).toEqual({ key: "renews", label: "Renews", value: AUTO_RENEW_TEXT });
  });

  it("says how a plan billed in parts is paid, and lists each kind of visit on its own line", () => {
    const rows = agreementTermRows({
      term: terms({ billingFrequency: "quarterly", priceCents: 30001 }),
      previousTerm: prev,
      cycles: [
        { label: "Aerobic inspections", summary: "3 visits a term" },
        { label: "Tank pumping", summary: "Every 36 months" },
      ],
    });
    expect(rows.find((r) => r.key === "price")!.value).toBe("$300.01 for the term, billed quarterly in 4 payments, the first $75.01");
    expect(rows.find((r) => r.key === "visits")!.value).toBe("Aerobic inspections: 3 visits a term\nTank pumping: Every 36 months");
    expect(agreementTermRows({ term: terms({ billingFrequency: "quarterly" }), previousTerm: prev }).find((r) => r.key === "price")!.value).toBe(
      "$300.00 for the term, billed quarterly in 4 payments of $75.00",
    );
  });
});

describe("renewalAgreementTerms", () => {
  it("puts automatic renewal into clause 5 of the built-in terms, and changes nothing else", () => {
    expect(renewalAgreementTerms(null, { autoRenew: false })).toBe(DEFAULT_RENEWAL_TERMS);
    const auto = renewalAgreementTerms(null, { autoRenew: true });
    expect(auto).toContain("5. Term. This agreement covers the dates shown above and renews automatically unless either party gives written notice before it ends.");
    expect(auto.split("\n\n").filter((c, i) => c !== DEFAULT_RENEWAL_TERMS.split("\n\n")[i])).toHaveLength(1);
  });
});

describe("renewalPitch", () => {
  it("promises inspections and filing only on an inspection plan", () => {
    expect(renewalPitch("aerobic_inspection")).toContain("inspected");
    expect(renewalPitch("pumping")).toBe("Renewing keeps your pumping visits on schedule.");
    expect(renewalPitch("maintenance")).toBe("Renewing keeps your maintenance visits on schedule.");
  });
});
