import { describe, expect, it } from "vitest";
import { matchCustomer, nameSimilarity, needsAttention, normalizeName, phoneKey } from "./quickbooks.ts";

const remote = (id: string, name: string, email: string | null = null, phone: string | null = null) => ({ id, name, email, phone });

describe("normalizing", () => {
  it("treats Last, First, case, spacing and punctuation as the same name", () => {
    expect(normalizeName("Smith, John")).toBe("john smith");
    expect(normalizeName("  JOHN   SMITH. ")).toBe("john smith");
    expect(normalizeName("Smith, Inc.")).toBe("smith inc");
    expect(normalizeName("José Núñez")).toBe("jose nunez");
  });

  it("compares phones on their last ten digits", () => {
    expect(phoneKey("+1 (512) 555-0100")).toBe("5125550100");
    expect(phoneKey("512.555.0100")).toBe("5125550100");
    expect(phoneKey("555-0100")).toBeNull();
  });

  it("scores word order and small typos as similar", () => {
    expect(nameSimilarity("John Smith", "Smith John")).toBe(1);
    expect(nameSimilarity("Jon Smith", "John Smith")).toBeGreaterThanOrEqual(0.8);
    expect(nameSimilarity("John Smith", "Mary Jones")).toBeLessThan(0.5);
  });
});

describe("matchCustomer", () => {
  const local = { name: "John Smith", email: "JOHN@example.com", phone: "(512) 555-0100" };

  it("takes exactly one customer with the same name and the same email or phone", () => {
    const r = matchCustomer(local, [remote("1", "Smith, John", "john@example.com"), remote("2", "Mary Jones", "mary@example.com")]);
    expect(r).toMatchObject({ kind: "exact", match: { customer: { id: "1" }, reasons: ["same_name", "same_email"] } });
  });

  it("asks when two QuickBooks customers match exactly", () => {
    const r = matchCustomer(local, [remote("1", "John Smith", "john@example.com"), remote("2", "John Smith", null, "512-555-0100")]);
    expect(r.kind).toBe("review");
    if (r.kind === "review") expect(r.candidates.map((c) => c.customer.id).sort()).toEqual(["1", "2"]);
  });

  it("asks when only the name agrees, or only the email", () => {
    expect(matchCustomer(local, [remote("1", "John Smith")]).kind).toBe("review");
    const byEmail = matchCustomer(local, [remote("7", "Smith Family Trust", "john@example.com")]);
    expect(byEmail).toMatchObject({ kind: "review", candidates: [{ customer: { id: "7" }, reasons: ["same_email"] }] });
  });

  it("offers similar names, best first, and nothing for strangers", () => {
    const r = matchCustomer({ name: "Jon Smith", email: null, phone: null }, [remote("1", "Mary Jones"), remote("2", "John Smith"), remote("3", "John Smithers")]);
    expect(r.kind).toBe("review");
    if (r.kind === "review") expect(r.candidates[0]!.customer.id).toBe("2");
    expect(matchCustomer(local, [remote("1", "Mary Jones", "mary@example.com")]).kind).toBe("none");
  });
});

describe("needsAttention", () => {
  it("is a conflict, or a failure with no automatic retry left", () => {
    expect(needsAttention({ status: "conflict", nextAttemptAt: null })).toBe(true);
    expect(needsAttention({ status: "failed", nextAttemptAt: new Date() })).toBe(false);
    expect(needsAttention({ status: "failed", nextAttemptAt: null })).toBe(true);
    expect(needsAttention({ status: "synced", nextAttemptAt: null })).toBe(false);
  });
});
