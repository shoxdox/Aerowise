import { z } from "zod";
import { id } from "./crm.ts";
import { addDays, contractState } from "./schedule.ts";

// The onboarding summary: a provider's book at a glance right after import. What is
// active, what renews soon, which visits are late, and what still needs filling in.

export const EXPIRING_WINDOWS = [30, 60, 90] as const;

export interface SummaryInput {
  today: string;
  contracts: { status: "active" | "cancelled"; startOn: string; endOn: string; serviceEndsOn: string | null }[];
  /** Open visits only. */
  visits: { dueOn: string }[];
  sites: { hasAuthority: boolean; permitNumber: string | null }[];
}

/** The last day of the month `date` falls in. */
function monthEnd(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

export function onboardingCounts({ today, contracts, visits, sites }: SummaryInput) {
  const active = contracts.filter((c) => contractState(c, today) === "active");
  const expiring = Object.fromEntries(EXPIRING_WINDOWS.map((days) => [`within${days}`, active.filter((c) => c.endOn <= addDays(today, days)).length])) as Record<
    `within${(typeof EXPIRING_WINDOWS)[number]}`,
    number
  >;
  const lastOfMonth = monthEnd(today);
  return {
    activeContracts: active.length,
    expiring,
    overdueVisits: visits.filter((v) => v.dueOn < today).length,
    dueThisMonth: visits.filter((v) => v.dueOn >= today && v.dueOn <= lastOfMonth).length,
    sitesWithoutAuthority: sites.filter((s) => !s.hasAuthority).length,
    sitesWithoutPermit: sites.filter((s) => !s.permitNumber).length,
  };
}

const siteRef = z.object({ id, addressLine1: z.string(), city: z.string(), customerName: z.string() });

export const onboardingSummary = z.object({
  /** The whole organization, or one import's records. */
  importId: id.nullable(),
  today: z.iso.date(),
  customers: z.number().int(),
  sites: z.number().int(),
  activeContracts: z.number().int(),
  /** Active contracts ending within 30, 60 and 90 days (each count includes the shorter windows). */
  expiring: z.object({ within30: z.number().int(), within60: z.number().int(), within90: z.number().int() }),
  overdueVisits: z.number().int(),
  /** Open visits due from today to the end of this month. */
  dueThisMonth: z.number().int(),
  sitesWithoutAuthority: z.number().int(),
  sitesWithoutPermit: z.number().int(),
  /** The first few sites behind the last two counts, to fix from the summary. */
  examples: z.object({ withoutAuthority: z.array(siteRef), withoutPermit: z.array(siteRef) }),
});
export type OnboardingSummary = z.infer<typeof onboardingSummary>;

export const onboardingSummaryQuery = z.object({ importId: id.optional() });
