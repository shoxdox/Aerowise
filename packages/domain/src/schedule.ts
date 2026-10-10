// Calendar arithmetic for contract terms and visit windows. Dates are plain
// YYYY-MM-DD strings (a provider's calendar day), computed in UTC so the server's
// timezone never shifts them.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(date: string): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

const format = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return format(d);
}

/** Whole days from one date to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}

/** Today's calendar date (YYYY-MM-DD) in a timezone. */
export function dateInZone(now: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Adds calendar months, clamping to the last day of the month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date: string, months: number): string {
  const d = parse(date);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return format(target);
}

export interface VisitWindow {
  sequence: number;
  windowStart: string;
  windowEnd: string;
  /** The last day the visit can happen without being overdue. */
  dueOn: string;
}

export interface TermSchedule {
  endOn: string;
  visits: VisitWindow[];
}

/**
 * Splits a contract term into equal visit windows. With a 12-month term and 3 visits,
 * a contract starting 2026-01-15 has windows Jan 15–May 14, May 15–Sep 14 and
 * Sep 15–Jan 14; each visit is due on its window's last day.
 */
export function buildTermSchedule(startOn: string, termMonths: number, visitsPerTerm: number): TermSchedule {
  if (!Number.isInteger(termMonths) || termMonths < 1) throw new Error("termMonths must be a positive integer");
  if (!Number.isInteger(visitsPerTerm) || visitsPerTerm < 1) throw new Error("visitsPerTerm must be a positive integer");
  if (termMonths % visitsPerTerm !== 0) throw new Error("termMonths must divide evenly into visitsPerTerm");
  const interval = termMonths / visitsPerTerm;
  const visits: VisitWindow[] = [];
  for (let k = 1; k <= visitsPerTerm; k++) {
    const windowStart = addMonths(startOn, (k - 1) * interval);
    const windowEnd = addDays(addMonths(startOn, k * interval), -1);
    visits.push({ sequence: k, windowStart, windowEnd, dueOn: windowEnd });
  }
  return { endOn: addDays(addMonths(startOn, termMonths), -1), visits };
}

/** The last day of a term starting on `startOn`. */
/**
 * The last day of a term: the day before the start date `termMonths` on. When that date does
 * not exist (a term from Jan 31 or Feb 29), the term runs to the end of the month it lands in
 * instead of stopping a day short of it: Jan 31 + 1 month ends Feb 28, not Feb 27, and Feb 29,
 * 2024 + 12 months ends Feb 28, 2025, so the renewal starts Mar 1 and the chain never drifts.
 */
export function termEndOn(startOn: string, termMonths: number): string {
  const d = parse(startOn);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + termMonths, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  if (d.getUTCDate() > lastDay) return format(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), lastDay)));
  return addDays(addMonths(startOn, termMonths), -1);
}

/** Visits counted from the contract's start, for authorities that set them that way (Hays 10.V.2). */
export interface ContractVisitRule {
  /** The first visit is due within this many days of the start. */
  firstWithinDays: number;
  /** The last visit falls in this many days before the end. */
  lastWithinDaysOfEnd: number;
}

/**
 * The fewest visits, at least `visitsPerTerm`, for a schedule counted from the contract's
 * start: one at the start, one every whole number of months no more than
 * `maxIntervalMonths` apart, and one at the end. A 12-month contract under a 4-month rule
 * has 4 (start, +4, +8, end); a 24-month one has 7.
 */
export function anchoredVisitsWithin(termMonths: number, visitsPerTerm: number, maxIntervalMonths: number): number {
  let visits = Math.max(visitsPerTerm, 2);
  // Always ends: termMonths + 1 visits are one a month.
  while (termMonths % (visits - 1) !== 0 || termMonths / (visits - 1) > maxIntervalMonths) visits++;
  return visits;
}

/**
 * A term's visits counted from its start (Hays 10.V.2): the first due within
 * `firstWithinDays` of the start, the middle ones due every `termMonths / (visits - 1)`
 * months from the start, and the last in the `lastWithinDaysOfEnd` days before the end.
 * A 12-month contract starting 2026-01-15 with 4 visits is due 2026-01-29, 2026-05-15,
 * 2026-09-15, and in 2027-01-01 to 2027-01-14.
 */
export function buildAnchoredSchedule(startOn: string, termMonths: number, visitsPerTerm: number, rule: ContractVisitRule): TermSchedule {
  if (!Number.isInteger(termMonths) || termMonths < 1) throw new Error("termMonths must be a positive integer");
  if (!Number.isInteger(visitsPerTerm) || visitsPerTerm < 2) throw new Error("a schedule counted from the start has at least 2 visits");
  if (termMonths % (visitsPerTerm - 1) !== 0) throw new Error("termMonths must divide evenly into visitsPerTerm - 1");
  const step = termMonths / (visitsPerTerm - 1);
  const endOn = termEndOn(startOn, termMonths);
  const lastStart = addDays(endOn, -rule.lastWithinDaysOfEnd);
  const firstDue = addDays(startOn, rule.firstWithinDays);
  if (firstDue >= lastStart) throw new Error("the term is too short for a first and a last visit");
  const visits: VisitWindow[] = [{ sequence: 1, windowStart: startOn, windowEnd: firstDue, dueOn: firstDue }];
  for (let k = 1; k <= visitsPerTerm - 2; k++) {
    const dueOn = addMonths(startOn, k * step);
    visits.push({ sequence: k + 1, windowStart: addDays(visits[k - 1]!.dueOn, 1), windowEnd: dueOn, dueOn });
  }
  visits.push({ sequence: visitsPerTerm, windowStart: lastStart, windowEnd: endOn, dueOn: endOn });
  return { endOn, visits };
}

/**
 * The fewest visits, at least `visitsPerTerm`, that split the term into equal whole-month
 * windows no longer than `maxIntervalMonths`. A 12-month plan with 3 visits stays at 3
 * under a 4-month rule, becomes 4 under a quarterly rule and 12 under a monthly one.
 */
export function visitsWithin(termMonths: number, visitsPerTerm: number, maxIntervalMonths: number): number {
  let visits = visitsPerTerm;
  // Always ends: one visit a month splits any term into 1-month windows.
  while (visits < termMonths && (termMonths % visits !== 0 || termMonths / visits > maxIntervalMonths)) visits++;
  return visits;
}

export type ContractState = "upcoming" | "active" | "expired" | "cancelled";

/** A contract's state is derived from its dates, so nothing has to flip it at midnight. */
export function contractState(c: { status: "active" | "cancelled"; startOn: string; endOn: string; serviceEndsOn?: string | null }, today: string): ContractState {
  if (c.status === "cancelled") return "cancelled";
  if (today < c.startOn) return "upcoming";
  if (today > c.endOn) return "expired";
  // Past its last day of service but not yet closed by the daily sweep.
  if (c.serviceEndsOn && today > c.serviceEndsOn) return "cancelled";
  return "active";
}
