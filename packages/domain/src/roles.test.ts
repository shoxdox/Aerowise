import { describe, expect, it } from "vitest";
import { roleHasPermission } from "./roles.ts";

describe("roleHasPermission", () => {
  it("lets office staff edit records but not manage the organization", () => {
    expect(roleHasPermission("office", "crm:write")).toBe(true);
    expect(roleHasPermission("office", "org:manage")).toBe(false);
  });

  it("keeps technicians and read-only users read-only", () => {
    for (const role of ["technician", "read_only"] as const) {
      expect(roleHasPermission(role, "crm:read")).toBe(true);
      expect(roleHasPermission(role, "crm:write")).toBe(false);
    }
  });

  it("leaves what the company pays Aerowise to the owner", () => {
    expect(roleHasPermission("owner", "subscription:manage")).toBe(true);
    for (const role of ["office", "technician", "read_only"] as const) expect(roleHasPermission(role, "subscription:manage")).toBe(false);
  });
});

describe("work order permissions", () => {
  it("lets everyone read work, the office change it, and technicians complete their own", () => {
    for (const role of ["owner", "office", "technician", "read_only"] as const) expect(roleHasPermission(role, "work:read")).toBe(true);
    expect(roleHasPermission("office", "work:write")).toBe(true);
    for (const role of ["technician", "read_only"] as const) expect(roleHasPermission(role, "work:write")).toBe(false);
    expect(roleHasPermission("technician", "work:complete")).toBe(true);
    for (const role of ["office", "read_only"] as const) expect(roleHasPermission(role, "work:complete")).toBe(false);
  });
});

describe("estimate permissions", () => {
  it("lets the owner and office write estimates, read-only users read them, and keeps prices from technicians", () => {
    for (const role of ["owner", "office", "read_only"] as const) expect(roleHasPermission(role, "estimates:read")).toBe(true);
    for (const role of ["owner", "office"] as const) expect(roleHasPermission(role, "estimates:write")).toBe(true);
    expect(roleHasPermission("read_only", "estimates:write")).toBe(false);
    for (const p of ["estimates:read", "estimates:write"] as const) expect(roleHasPermission("technician", p)).toBe(false);
  });
});
