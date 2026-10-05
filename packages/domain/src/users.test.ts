import { describe, expect, it } from "vitest";
import { canInviteRole, invitationStatus } from "./users.ts";

describe("canInviteRole", () => {
  it("lets owners invite anyone and office staff anyone but an owner", () => {
    expect(["owner", "office", "technician", "read_only"].every((r) => canInviteRole("owner", r as never))).toBe(true);
    expect(canInviteRole("office", "owner")).toBe(false);
    expect(canInviteRole("office", "office")).toBe(true);
    expect(canInviteRole("office", "technician")).toBe(true);
    expect(canInviteRole("technician", "technician")).toBe(false);
    expect(canInviteRole("read_only", "read_only")).toBe(false);
  });
});

describe("invitationStatus", () => {
  const now = new Date("2026-03-01T12:00:00Z");
  const base = { acceptedAt: null, revokedAt: null, expiresAt: new Date("2026-03-02T00:00:00Z") };
  it("reads accepted, revoked, expired and pending", () => {
    expect(invitationStatus(base, now)).toBe("pending");
    expect(invitationStatus({ ...base, expiresAt: now }, now)).toBe("expired");
    expect(invitationStatus({ ...base, acceptedAt: now, expiresAt: new Date(0) }, now)).toBe("accepted");
    expect(invitationStatus({ ...base, revokedAt: now }, now)).toBe("revoked");
  });
});
