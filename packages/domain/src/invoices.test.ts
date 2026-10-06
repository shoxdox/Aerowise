import { describe, expect, it } from "vitest";
import { amountDue, contractInstallments, invoiceTotals, paymentStatus } from "./invoices.ts";

describe("invoiceTotals", () => {
  it("adds lines and charges tax on taxable lines only", () => {
    const t = invoiceTotals(
      [
        { quantity: 1, unitPriceCents: 30000, taxable: false },
        { quantity: 2, unitPriceCents: 1250, taxable: true },
      ],
      0,
      825,
    );
    expect(t).toEqual({ subtotalCents: 32500, discountCents: 0, taxableCents: 2500, taxCents: 206, totalCents: 32706 });
  });

  it("spreads a discount over taxable and untaxed lines in proportion", () => {
    const t = invoiceTotals(
      [
        { quantity: 1, unitPriceCents: 7500, taxable: false },
        { quantity: 1, unitPriceCents: 2500, taxable: true },
      ],
      1000,
      1000,
    );
    // A quarter of the subtotal is taxable, so a quarter of the discount comes off the taxed part.
    expect(t.taxableCents).toBe(2250);
    expect(t.taxCents).toBe(225);
    expect(t.totalCents).toBe(10000 - 1000 + 225);
  });

  it("never discounts below zero", () => {
    const t = invoiceTotals([{ quantity: 1, unitPriceCents: 500, taxable: true }], 900, 825);
    expect(t).toMatchObject({ discountCents: 500, taxCents: 0, totalCents: 0 });
  });
});

describe("paymentStatus", () => {
  const s = (paidCents: number, pendingCents = 0, refundedCents = 0, totalCents = 10000, creditedCents = 0) => paymentStatus({ totalCents, paidCents, pendingCents, refundedCents, creditedCents });
  it("covers each state", () => {
    expect(s(0)).toBe("unpaid");
    expect(s(0, 10000)).toBe("processing");
    expect(s(4000)).toBe("partial");
    expect(s(4000, 6000)).toBe("partial");
    expect(s(10000)).toBe("paid");
    expect(s(15000)).toBe("overpaid");
    expect(s(0, 0, 10000)).toBe("refunded");
    expect(s(6000, 0, 4000)).toBe("partial");
    expect(s(0, 0, 0, 0)).toBe("paid");
  });
  it("takes a credit refund off what is owed, and a reversed one reopens the balance", () => {
    // $100 paid, $20 refunded as a credit: $80 kept and nothing owed.
    expect(s(8000, 0, 2000, 10000, 2000)).toBe("paid");
    // The same $20 reversing the payment: $20 owed again.
    expect(s(8000, 0, 2000, 10000, 0)).toBe("partial");
    // All of it refunded as a credit.
    expect(s(0, 0, 10000, 10000, 10000)).toBe("refunded");
    expect(amountDue({ totalCents: 10000, paidCents: 8000, pendingCents: 0, creditedCents: 2000 })).toBe(0);
    expect(amountDue({ totalCents: 10000, paidCents: 8000, pendingCents: 0, creditedCents: 0 })).toBe(2000);
  });
  it("amount due leaves out what is already clearing", () => {
    expect(amountDue({ totalCents: 10000, paidCents: 2500, pendingCents: 2500, creditedCents: 0 })).toBe(5000);
    expect(amountDue({ totalCents: 10000, paidCents: 12000, pendingCents: 0, creditedCents: 0 })).toBe(0);
  });
});

describe("contractInstallments", () => {
  const base = { startOn: "2026-01-15", endOn: "2027-01-14", termMonths: 12, priceCents: 30000 };
  it("bills an annual contract once for the whole term", () => {
    expect(contractInstallments({ ...base, billingFrequency: "annual" })).toEqual([
      { installment: 1, count: 1, periodStart: "2026-01-15", periodEnd: "2027-01-14", amountCents: 30000 },
    ]);
  });

  it("splits quarterly and puts the rounding remainder on the first", () => {
    const parts = contractInstallments({ ...base, priceCents: 10000, billingFrequency: "quarterly" });
    expect(parts.map((p) => p.amountCents)).toEqual([2500, 2500, 2500, 2500]);
    expect(parts.reduce((s, p) => s + p.amountCents, 0)).toBe(10000);
    expect(parts.map((p) => [p.periodStart, p.periodEnd])).toEqual([
      ["2026-01-15", "2026-04-14"],
      ["2026-04-15", "2026-07-14"],
      ["2026-07-15", "2026-10-14"],
      ["2026-10-15", "2027-01-14"],
    ]);
  });

  it("keeps the total exact when the price does not split evenly", () => {
    const parts = contractInstallments({ ...base, priceCents: 10001, billingFrequency: "monthly" });
    expect(parts).toHaveLength(12);
    expect(parts[0]!.amountCents).toBe(838);
    expect(parts.slice(1).every((p) => p.amountCents === 833)).toBe(true);
    expect(parts.reduce((s, p) => s + p.amountCents, 0)).toBe(10001);
  });

  it("ends with a shorter period when the term does not divide evenly", () => {
    const parts = contractInstallments({ startOn: "2026-01-01", endOn: "2027-06-30", termMonths: 18, priceCents: 18000, billingFrequency: "annual" });
    expect(parts.map((p) => [p.periodStart, p.periodEnd, p.amountCents])).toEqual([
      ["2026-01-01", "2026-12-31", 12000],
      ["2027-01-01", "2027-06-30", 6000],
    ]);
  });
});
