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
  "contracts:read",
  "contracts:write",
  "schedule:read",
  "schedule:write",
  "route:read",
  "inspections:read",
  "inspections:write",
  "inspections:review",
  "filings:read",
  "filings:write",
  "invoices:read",
  "invoices:write",
  "billing:manage",
  "quickbooks:read",
  "quickbooks:write",
  "sms:read",
  "sms:write",
  "org:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    "self:read",
    "crm:read",
    "crm:write",
    "contracts:read",
    "contracts:write",
    "schedule:read",
    "schedule:write",
    "route:read",
    "inspections:read",
    "inspections:write",
    "inspections:review",
    "filings:read",
    "filings:write",
    "invoices:read",
    "invoices:write",
    "billing:manage",
    "quickbooks:read",
    "quickbooks:write",
    "sms:read",
    "sms:write",
    "org:manage",
  ],
  office: ["self:read", "crm:read", "crm:write", "contracts:read", "contracts:write", "schedule:read", "schedule:write", "route:read", "inspections:read", "inspections:review", "filings:read", "filings:write", "invoices:read", "invoices:write", "quickbooks:read", "quickbooks:write", "sms:read", "sms:write"],
  technician: ["self:read", "crm:read", "contracts:read", "schedule:read", "route:read", "inspections:read", "inspections:write"],
  read_only: ["self:read", "crm:read", "contracts:read", "schedule:read", "inspections:read", "filings:read", "invoices:read", "quickbooks:read", "sms:read"],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
