import { z } from "zod";
import { id } from "./crm.ts";

// The office home screen: only what needs a person, most urgent first.

export const EXCEPTION_KINDS = [
  "inspection_overdue",
  "inspection_incomplete",
  "filing_failed",
  "filing_rejected",
  "filing_needs_review",
  "filing_deadline",
  "filing_unconfirmed",
  "next_visit_late",
  "issue_open",
  "contract_expiring",
  "contract_expired",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const EXCEPTION_SEVERITIES = ["high", "medium", "low"] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number];

/** A sent filing with no confirmation after this many days needs chasing. */
export const UNCONFIRMED_AFTER_DAYS = 14;
/** Contracts ending within this many days without a renewal show up. */
export const CONTRACT_EXPIRING_DAYS = 30;
/** Expired contracts stop showing this many days after they ended. */
export const CONTRACT_EXPIRED_WINDOW_DAYS = 60;

export const inboxException = z.object({
  /** Stable for as long as the cause lasts: kind plus the record it is about. */
  key: z.string(),
  kind: z.enum(EXCEPTION_KINDS),
  severity: z.enum(EXCEPTION_SEVERITIES),
  title: z.string(),
  detail: z.string().nullable(),
  /** The date that makes it urgent (due, deadline, contract end), if any. */
  dueOn: z.iso.date().nullable(),
  site: z.object({ id, addressLine1: z.string(), city: z.string() }),
  customer: z.object({ id, displayName: z.string() }),
  /** The record to open to deal with it. */
  target: z.object({ type: z.enum(["filing", "inspection", "issue", "obligation", "contract", "site"]), id }),
});
export type InboxException = z.infer<typeof inboxException>;

export const inbox = z.object({
  today: z.iso.date(),
  counts: z.object({
    dueThisWeek: z.number().int(),
    overdue: z.number().int(),
    filingsAtRisk: z.number().int(),
    contractsExpiring: z.number().int(),
  }),
  items: z.array(inboxException),
  routes: z.array(z.object({ technicianId: id, name: z.string(), stops: z.number().int(), done: z.number().int() })),
});
export type Inbox = z.infer<typeof inbox>;

export const issueResolveInput = z.object({ resolution: z.string().trim().min(1).max(2000) });

const SEVERITY_ORDER: Record<ExceptionSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Most severe first, then the earliest date, then undated. */
export function sortExceptions<T extends Pick<InboxException, "severity" | "dueOn" | "key">>(items: T[]): T[] {
  return [...items].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.dueOn ?? "9999-12-31").localeCompare(b.dueOn ?? "9999-12-31") ||
      a.key.localeCompare(b.key),
  );
}
