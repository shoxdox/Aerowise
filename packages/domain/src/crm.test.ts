import { describe, expect, it } from "vitest";
import { aerobicContractWarning } from "./crm.ts";

describe("aerobic contract warning (SW-7)", () => {
  it("speaks only when every system is recorded as something other than aerobic", () => {
    expect(aerobicContractWarning([])).toBeNull();
    expect(aerobicContractWarning([null])).toBeNull();
    expect(aerobicContractWarning(["unknown"])).toBeNull();
    expect(aerobicContractWarning(["aerobic", "drip"])).toBeNull();
    expect(aerobicContractWarning(["conventional", null])).toBeNull();
    expect(aerobicContractWarning(["conventional", "holding_tank"])).toBe(
      "This site's systems are recorded as conventional and holding tank, not aerobic. An aerobic inspection contract is for an aerobic system. Start it anyway?",
    );
  });
});
