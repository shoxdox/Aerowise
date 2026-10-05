import { z } from "zod";
import { verificationBadge } from "./filings.ts";

// What the public marketing page shows. Nothing here is tenant data: the authorities come
// from the bundled rulesets and the prices from the deployment's subscription config.

/** One reporting authority Aerowise has rules for. Fictional (development-only) rules are never listed. */
export const coverageItem = z.object({
  key: z.string(),
  authorityName: z.string(),
  type: z.string(),
  counties: z.array(z.string()),
  /** `verified`: confirmed with the authority; `draft`: built from public sources, still being confirmed. */
  status: z.enum(["verified", "draft"]),
  verified: verificationBadge.nullable(),
});
export type CoverageItem = z.infer<typeof coverageItem>;

export const publicOverview = z.object({
  coverage: z.array(coverageItem),
  pricing: z.object({
    designPartnerDays: z.number().int(),
    trialDays: z.number().int(),
    pricePerContractCents: z.number().int(),
    monthlyMinimumCents: z.number().int(),
  }),
});
export type PublicOverview = z.infer<typeof publicOverview>;
