import { describe, expect, it } from "vitest";
import { formatPhone, nextSmsTime, smsAllowedAt, smsKeyword, toE164 } from "./sms.ts";

describe("toE164", () => {
  it("reads US numbers however they were typed", () => {
    for (const raw of ["(512) 555-0123", "512.555.0123", "5125550123", "1-512-555-0123", "+1 512 555 0123", "512-555-0123 ext. 4"]) {
      expect(toE164(raw)).toBe("+15125550123");
    }
  });
  it("keeps international numbers that carry their country code", () => {
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });
  it("refuses what cannot be a number", () => {
    for (const raw of [null, "", "555-0123", "012-555-0123", "call the office", "+12"]) expect(toE164(raw)).toBeNull();
  });
  it("formats US numbers for people", () => {
    expect(formatPhone("+15125550123")).toBe("(512) 555-0123");
  });
});

describe("smsKeyword", () => {
  it("knows the carrier keywords in any case, alone", () => {
    expect(smsKeyword("stop")).toBe("stop");
    expect(smsKeyword(" Unsubscribe. ")).toBe("stop");
    expect(smsKeyword("START")).toBe("start");
    expect(smsKeyword("help")).toBe("help");
    expect(smsKeyword("please stop by tomorrow")).toBeNull();
  });
});

describe("quiet hours", () => {
  const tz = "America/Chicago";
  it("allows texts from 8 am to 9 pm local time", () => {
    expect(smsAllowedAt(new Date("2026-03-02T14:00:00Z"), tz)).toBe(true); // 8:00
    expect(smsAllowedAt(new Date("2026-03-02T13:59:00Z"), tz)).toBe(false); // 7:59
    expect(smsAllowedAt(new Date("2026-03-03T02:59:00Z"), tz)).toBe(true); // 20:59
    expect(smsAllowedAt(new Date("2026-03-03T03:00:00Z"), tz)).toBe(false); // 21:00
  });
  it("moves a text due at night to 8 am", () => {
    expect(nextSmsTime(new Date("2026-03-03T04:30:00Z"), tz).toISOString()).toBe("2026-03-03T14:00:00.000Z"); // 22:30 → 8:00 next day
    expect(nextSmsTime(new Date("2026-03-03T10:15:00Z"), tz).toISOString()).toBe("2026-03-03T14:00:00.000Z"); // 4:15 → 8:00 same day
    const day = new Date("2026-03-03T18:00:00Z");
    expect(nextSmsTime(day, tz)).toBe(day);
  });
  it("lands inside the window across a daylight saving change", () => {
    // Clocks go forward at 2 am on 2026-03-08 in Chicago.
    const at = nextSmsTime(new Date("2026-03-08T05:00:00Z"), tz);
    expect(smsAllowedAt(at, tz)).toBe(true);
    expect(at.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });
});
