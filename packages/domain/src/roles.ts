export const ROLES = ["owner", "office", "technician", "read_only"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Every API route declares exactly one permission. Roles map to permissions here and
 * nowhere else, so the full access matrix is reviewable in one place.
 */
export const PERMISSIONS = [
  "self:read",
  "crm:read",
  "crm:write",
  "org:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ["self:read", "crm:read", "crm:write", "org:manage"],
  office: ["self:read", "crm:read", "crm:write"],
  technician: ["self:read", "crm:read"],
  read_only: ["self:read", "crm:read"],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
