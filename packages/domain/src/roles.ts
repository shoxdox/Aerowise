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
  "reports:sign",
  "invoices:read",
  "invoices:write",
  "billing:manage",
  "subscription:manage",
  "quickbooks:read",
  "quickbooks:write",
  "sms:read",
  "sms:write",
  "org:manage",
  "users:read",
  "users:invite",
  "users:manage",
  "data:export",
  // Work orders (SW-1): reading, office changes, and a technician completing their own visits.
  "work:read",
  "work:write",
  "work:complete",
  // Estimates (SW-5): prices offered to customers, so not for technicians.
  "estimates:read",
  "estimates:write",
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
    "reports:sign",
    "invoices:read",
    "invoices:write",
    "billing:manage",
    // What the company pays Aerowise: the owner's alone (W4.3).
    "subscription:manage",
    "quickbooks:read",
    "quickbooks:write",
    "sms:read",
    "sms:write",
    "org:manage",
    "users:read",
    "users:invite",
    "users:manage",
    "data:export",
    "work:read",
    "work:write",
    "work:complete",
    "estimates:read",
    "estimates:write",
  ],
  office: ["self:read", "crm:read", "crm:write", "contracts:read", "contracts:write", "schedule:read", "schedule:write", "route:read", "inspections:read", "inspections:review", "filings:read", "filings:write", "reports:sign", "invoices:read", "invoices:write", "quickbooks:read", "quickbooks:write", "sms:read", "sms:write", "users:read", "users:invite", "work:read", "work:write", "estimates:read", "estimates:write"],
  // Signing still needs the person's own MP license; the permission only opens the door.
  technician: ["self:read", "crm:read", "contracts:read", "schedule:read", "route:read", "inspections:read", "inspections:write", "reports:sign", "work:read", "work:complete"],
  read_only: ["self:read", "crm:read", "contracts:read", "schedule:read", "inspections:read", "filings:read", "invoices:read", "quickbooks:read", "sms:read", "work:read", "estimates:read"],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
