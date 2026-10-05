import { z } from "zod";

// The platform-admin console (/admin): the people who run Aerowise create and support
// organizations here. Platform admins are not tenant users and have no tenant role.

export const PLATFORM_ADMIN_MIN_PASSWORD = 12;

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const adminOrganizationInput = z.object({
  name: z.string().trim().min(1).max(200),
  timezone: z.string().trim().refine(isTimeZone, "Unknown time zone").default("America/Chicago"),
  email: z.email().max(320).optional(),
  phone: z.string().trim().max(40).optional(),
});
export type AdminOrganizationInput = z.infer<typeof adminOrganizationInput>;

export const adminOrganization = z.object({
  id: z.uuid(),
  name: z.string(),
  timezone: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  /** Contracts in force today, in the organization's own time zone. */
  activeContracts: z.number().int(),
  /** Active users with an active membership. */
  users: z.number().int(),
  /** Newest audit event or sign-in, or null when nobody has done anything yet. */
  lastActivityAt: z.iso.datetime({ offset: true }).nullable(),
});
export type AdminOrganization = z.infer<typeof adminOrganization>;

export const platformAdminMe = z.object({ id: z.uuid(), name: z.string(), email: z.string() });
export type PlatformAdminMe = z.infer<typeof platformAdminMe>;
