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
});
