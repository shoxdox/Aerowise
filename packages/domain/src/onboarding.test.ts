import { describe, expect, it } from "vitest";
import { onboardingChecklistFor, type OnboardingFacts } from "./onboarding.ts";

const complete: OnboardingFacts = {
  company: { name: "Brazos Aerobic Co", phone: "(979) 555-0100", addressLine1: "12 Main St", city: "Bryan", state: "TX", postalCode: "77801" },
  responsibleMpValid: true,
  inspectors: [{ name: "Tina Tech", role: "technician", hasValidCredential: true }],
  serviceCounties: 1,
  customers: 1,
  sites: 1, applicableSites: 1, contracts: 1, scheduledVisits: 1, reviewedReports: 1,
  stripeChargesEnabled: true,
  quickbooksConnected: false,
};

const itemOf = (f: OnboardingFacts, key: string) => onboardingChecklistFor(f).items.find((i) => i.key === key)!;

describe("first-run checklist", () => {
  it("is complete with every required item done, QuickBooks or not", () => {
    const c = onboardingChecklistFor(complete);
    expect(c.complete).toBe(true);
    expect(c.items.filter((i) => !i.done).map((i) => i.key)).toEqual(["quickbooks"]);
    expect(onboardingChecklistFor({ ...complete, quickbooksConnected: true }).items.every((i) => i.done)).toBe(true);
  });

  it("lists everything for a brand-new company", () => {
    const fresh: OnboardingFacts = {
      company: { name: "New Co", phone: null, addressLine1: null, city: null, state: null, postalCode: null },
      responsibleMpValid: false,
      inspectors: [],
      serviceCounties: 0,
      customers: 0,
      sites: 0, applicableSites: 0, contracts: 0, scheduledVisits: 0, reviewedReports: 0,
      stripeChargesEnabled: false,
      quickbooksConnected: false,
    };
    const c = onboardingChecklistFor(fresh);
    expect(c.complete).toBe(false);
    expect(c.items.map((i) => [i.key, i.done])).toEqual([
      ["company_details", false],
      ["responsible_mp", false],
      ["technicians", false],
      ["service_counties", false],
      ["customers", false],
      ["sites", false],
      ["authority_fit", false],
      ["contract", false],
      ["scheduled_visit", false],
      ["reviewed_report", false],
      ["stripe", false],
      ["quickbooks", false],
    ]);
    expect(c.items.find((i) => i.key === "quickbooks")!.optional).toBe(true);
  });

  it("company details need a phone and a full address, and say which parts are missing", () => {
    const i = itemOf({ ...complete, company: { ...complete.company, phone: null, postalCode: null } }, "company_details");
    expect(i.done).toBe(false);
    expect(i.detail).toContain("phone, ZIP code");
    expect(itemOf(complete, "company_details").detail).toBeNull();
  });

  it("the responsible MP must be a valid license", () => {
    expect(itemOf({ ...complete, responsibleMpValid: false }, "responsible_mp").done).toBe(false);
  });

  it("someone must hold a valid inspecting license, and every technician must have one", () => {
    const none = itemOf({ ...complete, inspectors: [] }, "technicians");
    expect(none.done).toBe(false);
    expect(none.href).toBe("/settings/users");
    // An owner who does the inspections themselves counts.
    expect(itemOf({ ...complete, inspectors: [{ name: "Olive Owner", role: "owner", hasValidCredential: true }] }, "technicians").done).toBe(true);
    const missing = itemOf(
      { ...complete, inspectors: [...complete.inspectors, { name: "Ned New", role: "technician", hasValidCredential: false }] },
      "technicians",
    );
    expect(missing.done).toBe(false);
    expect(missing.detail).toContain("Ned New");
    expect(missing.href).toBe("/settings/credentials");
    expect(itemOf({ ...complete, inspectors: [{ name: "Ned New", role: "technician", hasValidCredential: false }] }, "technicians").done).toBe(false);
  });

  it("needs operational records while payments stay optional", () => {
    expect(itemOf({ ...complete, serviceCounties: 0 }, "service_counties").done).toBe(false);
    expect(itemOf({ ...complete, customers: 0 }, "customers").done).toBe(false);
    expect(itemOf({ ...complete, stripeChargesEnabled: false }, "stripe").done).toBe(false);
    for (const f of [{ serviceCounties: 0 }, { customers: 0 }, { reviewedReports: 0 }, { responsibleMpValid: false }]) {
      expect(onboardingChecklistFor({ ...complete, ...f }).complete).toBe(false);
    }
  });
  it("allows check-only operations and never links Office to owner-only setup", () => {
    expect(onboardingChecklistFor({ ...complete, stripeChargesEnabled: false }).complete).toBe(true);
    const office = onboardingChecklistFor({ ...complete, role: "office", responsibleMpValid: false, stripeChargesEnabled: false });
    expect(office.items.find((i) => i.key === "stripe")).toMatchObject({ optional: true, href: null });
    expect(office.items.find((i) => i.key === "responsible_mp")).toMatchObject({ href: null });
    expect(office.items.find((i) => i.key === "responsible_mp")!.detail).toContain("company owner");
  });
});
