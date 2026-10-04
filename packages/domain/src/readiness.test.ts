import { describe, expect, it } from "vitest";
import { canTransitionFiling, siteJurisdictionInput } from "./filings.ts";
import { credentialInput, credentialProblems } from "./readiness.ts";

describe("site authority choice", () => {
  it("needs evidence to choose an authority by hand, but not to clear one", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(siteJurisdictionInput.safeParse({ jurisdictionId: id }).success).toBe(false);
    expect(siteJurisdictionInput.safeParse({ jurisdictionId: id, evidenceKind: "authority_map" }).success).toBe(false);
    expect(siteJurisdictionInput.safeParse({ jurisdictionId: id, evidenceKind: "authority_map", evidenceReference: "LCRA map" }).success).toBe(true);
    expect(siteJurisdictionInput.safeParse({ jurisdictionId: null }).success).toBe(true);
  });
});

describe("credentials", () => {
  it("record verification with its source, and flag lapsed or inactive ones on a date", () => {
    expect(credentialInput.safeParse({ holderName: "A", kind: "tceq_maintenance_provider", number: "MP1", verifiedOn: "2026-01-01" }).success).toBe(false);
    expect(credentialInput.safeParse({ holderName: "A", kind: "tceq_maintenance_provider", number: "MP1", verifiedOn: "2026-01-01", verificationSource: "TCEQ search" }).success).toBe(true);
    const c = { active: true, expiresOn: "2026-06-30", number: "MP1" };
    expect(credentialProblems(c, "2026-06-30")).toEqual([]);
    expect(credentialProblems(c, "2026-07-01")).toEqual(["expired on 2026-06-30"]);
    expect(credentialProblems({ ...c, active: false }, "2026-01-01")).toEqual(["is marked inactive"]);
  });
});

describe("filing state machine v2", () => {
  it("sends a rejected filing back through review and a new package", () => {
    expect(canTransitionFiling("rejected", "pending")).toBe(true);
    expect(canTransitionFiling("rejected", "sent")).toBe(false);
  });
});
