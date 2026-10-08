import { describe, expect, it } from "vitest";
import { disposalLoadSync, formatGallons, pumpOutInput, pumpOutProblems, toMilligallons } from "./pumping.ts";

describe("pump-out volumes", () => {
  it("stores gallons in thousandths exactly", () => {
    expect(toMilligallons(1000, "gallons")).toBe(1_000_000);
    expect(toMilligallons(0.1, "gallons")).toBe(100);
    expect(toMilligallons(1234.5, "gallons")).toBe(1_234_500);
  });

  it("converts liters with the exact US gallon (3.785411784 L), rounded once", () => {
    expect(toMilligallons(3.8, "liters")).toBe(1004); // 1003.85… → 1004
    expect(toMilligallons(3785.4, "liters")).toBe(999_997); // 999 996.887 → 999 997
    expect(toMilligallons(1892.7, "liters")).toBe(Math.round((1892.7 * 1000) / 3.785411784));
    // Mixed units add up on the canonical values, never on the entered ones.
    expect(toMilligallons(500, "gallons") + toMilligallons(1000, "liters")).toBe(500_000 + 264_172);
  });

  it("formats thousandths as gallons to one decimal place", () => {
    expect(formatGallons(1_234_500)).toBe("1,234.5 gal");
    expect(formatGallons(264_172)).toBe("264.2 gal");
  });

  it("accepts one decimal place and refuses more, zero or negative volumes", () => {
    const base = { clientId: "8b0e8b8e-7a3c-4d7e-9a0e-6a8f5a1d2c3b", unit: "gallons", wasteType: "septage" } as const;
    expect(pumpOutInput.safeParse({ ...base, volume: 1000.5 }).success).toBe(true);
    expect(pumpOutInput.safeParse({ ...base, volume: 1000.55 }).success).toBe(false);
    expect(pumpOutInput.safeParse({ ...base, volume: 0 }).success).toBe(false);
    expect(pumpOutInput.safeParse({ ...base, volume: -5 }).success).toBe(false);
  });

  it("asks for a pump-out only on work that needs a disposal record", () => {
    expect(pumpOutProblems(false, null)).toEqual([]);
    expect(pumpOutProblems(true, { volume: 1 })).toEqual([]);
    expect(pumpOutProblems(true, null)).toEqual([{ key: "pump_out", label: "Pump-out", problem: "missing", message: "Pump-out volume is required" }]);
  });

  it("needs at least one pump-out in a load", () => {
    const load = { clientId: "8b0e8b8e-7a3c-4d7e-9a0e-6a8f5a1d2c3b", facilityId: "8b0e8b8e-7a3c-4d7e-9a0e-6a8f5a1d2c3c", deliveredOn: "2026-10-08", total: 1000, unit: "gallons" } as const;
    expect(disposalLoadSync.safeParse({ ...load, pumpingGroupIds: [] }).success).toBe(false);
    expect(disposalLoadSync.safeParse({ ...load, pumpingGroupIds: ["8b0e8b8e-7a3c-4d7e-9a0e-6a8f5a1d2c3d"] }).success).toBe(true);
  });
});
