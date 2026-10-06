import { z } from "zod";

// Organization settings: what the company tells its customers and the authorities about
// itself (name, contact, address, logo) and where it works (service counties). The
// responsible MP license is the existing credential chosen on the licenses page.

export const MAX_LOGO_BYTES = 1024 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg"] as const;

const text = (max: number) => z.string().trim().max(max).transform((v) => (v === "" ? null : v)).nullable();

/** County names as people type them, trimmed, with case-insensitive repeats removed. */
export const serviceCounties = z
  .array(z.string().trim().min(1).max(60))
  .max(60)
  .transform((names) => {
    const seen = new Set<string>();
    return names.filter((n) => {
      const key = n.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

export const organizationSettingsFields = z.object({
  name: z.string().trim().min(1).max(200),
  phone: text(40),
  email: z.union([z.email().max(320), z.literal("").transform(() => null)]).nullable(),
  addressLine1: text(200),
  addressLine2: text(200),
  city: text(100),
  state: text(40),
  postalCode: text(20),
  serviceCounties,
  /** Put the authority's filing fees on the homeowner's contract invoices. Off by default. */
  billFilingFees: z.boolean(),
});
export const organizationSettingsPatch = organizationSettingsFields.partial();

export const organizationSettings = z.object({
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  serviceCounties: z.array(z.string()),
  billFilingFees: z.boolean(),
  timezone: z.string(),
  hasLogo: z.boolean(),
  /** The TCEQ maintenance provider license reports are filed under, chosen on the licenses page. */
  responsibleProvider: z.object({ id: z.uuid(), holderName: z.string(), number: z.string() }).nullable(),
});
export type OrganizationSettings = z.infer<typeof organizationSettings>;
