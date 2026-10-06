import { describe, expect, it } from "vitest";
import { isFictionalEmail, isFictionalPhone } from "./demo.ts";

describe("fictional contact details", () => {
  it("accepts only addresses at domains reserved for examples", () => {
    for (const e of ["owner@example.com", "A.B@Example.ORG", "x@mail.example.net", "x@demo.test", "x@foo.invalid", "x@example", "", null, undefined]) {
      expect(isFictionalEmail(e), String(e)).toBe(true);
    }
    for (const e of ["justin@gmail.com", "ossf@wilcotx.gov", "x@example.com.evil.com", "x@notexample.com", "x@test.com"]) {
      expect(isFictionalEmail(e), e).toBe(false);
    }
  });

  it("accepts only numbers in 555-0100 to 555-0199", () => {
    for (const p of ["(512) 555-0100", "512-555-0199", "+15125550142", "1 737 555 0150", "", null]) expect(isFictionalPhone(p), String(p)).toBe(true);
    for (const p of ["(512) 555-1000", "(512) 555-0200", "+15125551234", "555-0100", "(512) 867-5309"]) expect(isFictionalPhone(p), p).toBe(false);
  });
});
