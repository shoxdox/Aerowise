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
  /**
   * For a draft: the filing questions the authority itself has confirmed (where reports go,
   * format, signature, where contracts go, receipt). Nothing else counts, so a provider's
   * document or a published rule never shows here.
   */
  confirmedWithAuthority: z.array(z.string()),
  /**
   * How a report reaches this authority from Aerowise: `email` (sent when the office presses
   * Send), `portal` (prepared for the office to upload on the authority's own page), or
   * `prepared` (no provider channel published; prepared for the office to send as it does today).
   */
  filing: z.enum(["email", "portal", "prepared"]),
  /** The rules a provider would ask about first, read from the same ruleset the product applies. */
  rules: z.object({
    /** Months between routine visits; `monitoredIntervalMonths` when the system has electronic monitoring on record. */
    intervalMonths: z.number().int(),
    monitoredIntervalMonths: z.number().int().nullable(),
    /** Days after the test by which the report is due. */
    reportDeadlineDays: z.number().int(),
    /** Days before the previous contract ends by which a renewal is due, when the authority says. */
    renewalDaysBeforePreviousEnd: z.number().int().nullable(),
    /** Template field keys this authority requires on every report, beyond the form's own. */
    requiredFields: z.array(z.string()),
    /** The authority counts visits from the contract's start date rather than evenly. */
    contractVisits: z.boolean(),
    /** Days within which a failed or low-chlorine report needs a retest report, when the authority says. */
    correctiveReportDays: z.number().int().nullable(),
    /** Where a report goes: the published inbox (`email`) or upload page (`portal`); null when prepared for the office to send. */
    destination: z.string().nullable(),
  }),
});
export type CoverageItem = z.infer<typeof coverageItem>;

export const publicOverview = z.object({
  coverage: z.array(coverageItem),
  pricing: z.object({
    designPartnerDays: z.number().int(),
    trialDays: z.number().int(),
    pricePerContractCents: z.number().int(),
    monthlyMinimumCents: z.number().int(),
    founderPricePerContractCents: z.number().int(),
    founderCompanyLimit: z.number().int(),
  }),
});
export type PublicOverview = z.infer<typeof publicOverview>;
