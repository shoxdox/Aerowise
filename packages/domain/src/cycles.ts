import { z } from "zod";
import { SERVICE_TYPES } from "./contracts.ts";
import { id } from "./crm.ts";
import { addDays, addMonths, termEndOn, type VisitWindow } from "./schedule.ts";

// Service cycles (SW-9, service workflows plan §4.4). A plan version lists its cycles: the
// 'aerobic' one for inspections (today's schedule, authority rules and all) and any pumping
// or maintenance cycles. A contract freezes them when it is made. A pumping or maintenance
// visit is done as one work order of the cycle's kind of work, never as an inspection job,
// so it never reaches a filing or report.

/** Kinds of visit a cycle other than the aerobic one can be. */
export const CYCLE_SERVICE_TYPES = ["pumping", "maintenance"] as const;
export type CycleServiceType = (typeof CYCLE_SERVICE_TYPES)[number];
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  aerobic_inspection: "Aerobic inspection",
  pumping: "Pumping",
  maintenance: "Maintenance",
};

export const AEROBIC_CYCLE_KEY = "aerobic";

/**
 * Visits every `everyMonths` from the contract's start, each due the day before the next
 * interval begins (as aerobic visits fall due), within `windowDays` either side.
 */
export const intervalSchedule = z.object({
  kind: z.literal("every_months"),
  everyMonths: z.number().int().min(1).max(120),
  windowDays: z.number().int().min(0).max(180).default(30),
});
export type IntervalSchedule = z.infer<typeof intervalSchedule>;

/** A pumping or maintenance cycle, as the plan builder saves it and a plan version keeps it. */
export const serviceCycle = z.object({
  cycleKey: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Use lowercase letters, digits, - and _ (up to 64)")
    .refine((k) => k !== AEROBIC_CYCLE_KEY, { message: `"${AEROBIC_CYCLE_KEY}" is the inspection cycle's key` }),
  label: z.string().trim().min(1).max(120),
  serviceType: z.enum(CYCLE_SERVICE_TYPES),
  /** The kind of work its visits are booked as. */
  workTypeId: id,
  schedule: intervalSchedule,
  /** The office accepted that a term can pass with no visit (every 36 months on a 12-month plan). */
  allowNoVisit: z.boolean().default(false),
});
export type ServiceCycle = z.infer<typeof serviceCycle>;

/** The inspection cycle every aerobic plan version has, from its own visits. */
export const aerobicCycle = z.object({
  cycleKey: z.literal(AEROBIC_CYCLE_KEY),
  serviceType: z.literal("aerobic_inspection"),
  schedule: z.object({ kind: z.literal("visits_per_term"), visitsPerTerm: z.number().int().min(1) }),
});
export type AerobicCycle = z.infer<typeof aerobicCycle>;

/** Stored cycles, read again strictly so a value that no longer fits is an error, never a silent visit. */
export function parseServiceCycles(v: unknown): { aerobic: AerobicCycle | null; cycles: ServiceCycle[] } {
  const items = z.array(z.unknown()).parse(v ?? []);
  let aerobic: AerobicCycle | null = null;
  const cycles: ServiceCycle[] = [];
  for (const it of items) {
    if ((it as { cycleKey?: unknown })?.cycleKey === AEROBIC_CYCLE_KEY) aerobic = aerobicCycle.parse(it);
    else cycles.push(serviceCycle.parse(it));
  }
  return { aerobic, cycles };
}

/**
 * The visits of an interval cycle in one term: due the day before start + k × everyMonths
 * (k = 1, 2, …) while that falls in the term, each window `windowDays` either side of its
 * due date, clipped to the term. Numbered from 1. Empty when no due date falls in the term.
 */
export function buildIntervalSchedule(startOn: string, termMonths: number, schedule: IntervalSchedule): VisitWindow[] {
  const endOn = termEndOn(startOn, termMonths);
  const visits: VisitWindow[] = [];
  for (let k = 1; ; k++) {
    const dueOn = addDays(addMonths(startOn, k * schedule.everyMonths), -1);
    if (dueOn > endOn) break;
    const from = addDays(dueOn, -schedule.windowDays);
    const to = addDays(dueOn, schedule.windowDays);
    visits.push({ sequence: k, windowStart: from < startOn ? startOn : from, windowEnd: to > endOn ? endOn : to, dueOn });
  }
  return visits;
}

/** Why a cycle has no visit in a term of this length, or null when it has one or the office accepted none. */
export function cycleWithoutVisit(c: ServiceCycle, termMonths: number): string | null {
  if (c.allowNoVisit || c.schedule.everyMonths <= termMonths) return null;
  return `"${c.label}" comes every ${c.schedule.everyMonths} months, so a ${termMonths}-month term has no visit. Accept "no visit this term" to keep it.`;
}

/** One line for agreements and the office. */
export function cycleSummary(c: { serviceType: string; schedule: unknown }): string {
  const s = c.schedule as { kind?: string; everyMonths?: number; visitsPerTerm?: number; windowDays?: number };
  if (s.kind === "every_months") return `Every ${s.everyMonths} month${s.everyMonths === 1 ? "" : "s"}, within ${s.windowDays ?? 30} days of the due date`;
  return `${s.visitsPerTerm} visit${s.visitsPerTerm === 1 ? "" : "s"} per term`;
}
