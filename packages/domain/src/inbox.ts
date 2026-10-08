import { z } from "zod";
import { id } from "./crm.ts";
import { workOrderLink } from "./work.ts";

// The office home screen: only what needs a person, most urgent first.

export const EXCEPTION_KINDS = [
  "inspection_overdue",
  "inspection_incomplete",
  "filing_failed",
  "filing_rejected",
  "filing_needs_review",
  "filing_deadline",
  "filing_unconfirmed",
  "filing_bounced",
  "next_visit_late",
  "lab_test_late",
  "lab_result_over_limit",
  "corrective_report_due",
  "issue_open",
  "contract_expiring",
  "contract_expired",
  "renewal_needs_review",
  "service_request",
  "complaint_unresolved",
  "report_unsigned",
  "discontinuation_notice_due",
  "visit_after_service_end",
  "sms_reply",
  "invoice_overdue",
  "payment_failed",
  "invoice_overpaid",
  "quickbooks_conflict",
  "quickbooks_failed",
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
/** A failed bank payment stays in the inbox this long, while the invoice is still owed. */
export const PAYMENT_FAILED_WINDOW_DAYS = 30;
/** Invoices this many days past due are medium severity; before that, low. */
export const INVOICE_LATE_DAYS = 30;

export const inboxException = z.object({
  /** Stable for as long as the cause lasts: kind plus the record it is about. */
  key: z.string(),
  kind: z.enum(EXCEPTION_KINDS),
  severity: z.enum(EXCEPTION_SEVERITIES),
  title: z.string(),
  detail: z.string().nullable(),
  /** The date that makes it urgent (due, deadline, contract end), if any. */
  dueOn: z.iso.date().nullable(),
  /** Null only for an invoice that is not for a particular site. */
  site: z.object({ id, addressLine1: z.string(), city: z.string() }).nullable(),
  customer: z.object({ id, displayName: z.string() }),
  /** The record to open to deal with it. */
  target: z.object({ type: z.enum(["filing", "inspection", "issue", "obligation", "contract", "site", "invoice", "quickbooks", "renewal", "service_request", "sms_message"]), id }),
  /** An issue or request already turned into a work order: its link instead of "Turn into work order". */
  workOrder: workOrderLink.nullable().optional(),
});
export type InboxException = z.infer<typeof inboxException>;

export const inbox = z.object({
  today: z.iso.date(),
  counts: z.object({
    dueThisWeek: z.number().int(),
    overdue: z.number().int(),
    filingsAtRisk: z.number().int(),
    contractsExpiring: z.number().int(),
    /** Issued invoices not fully paid, and what is left on them. */
    unpaidInvoices: z.number().int(),
    unpaidCents: z.number().int(),
  }),
  items: z.array(inboxException),
  /** QuickBooks sync health, when the organization has connected QuickBooks. */
  quickbooks: z.object({ status: z.enum(["connected", "needs_reauth", "disconnected"]), setupState: z.enum(["review", "active"]), attention: z.number().int() }).nullable(),
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
