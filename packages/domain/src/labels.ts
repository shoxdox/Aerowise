import type { BILLING_FREQUENCIES, CONTRACT_STATES, OBLIGATION_STATUSES } from "./contracts.ts";
import type { CONTACT_TYPES, CUSTOMER_STATUSES, CUSTOMER_TYPES } from "./crm.ts";
import { ESTIMATE_STATUS_LABELS, type EstimateStatus } from "./estimates.ts";
import type { EXCEPTION_SEVERITIES } from "./inbox.ts";
import type { IMPORT_ROW_STATUSES, IMPORT_STATUSES } from "./imports.ts";
import { PAYMENT_STATUS_LABELS, type InvoicePaymentStatus, type InvoiceStatus, type PaymentRecordStatus } from "./invoices.ts";
import type { TemplateDefinition } from "./inspections.ts";
import type { JobStatus } from "./jobs.ts";
import { RENEWAL_STATUS_LABELS, type RenewalStatus } from "./renewals.ts";
import type { Role } from "./roles.ts";
import type { InvitationStatus } from "./users.ts";
import { WORK_ORDER_STATUS_LABELS, type WORK_ORDER_PRIORITIES, type WorkOrderStatus } from "./work.ts";

// What people read for a stored value. Screens show these, never the value itself, so a new
// enum value shows as words (humanized) until it gets its own label here.

export const ROLE_LABELS: Record<Role, string> = { owner: "Owner", office: "Office", technician: "Technician", read_only: "Read-only" };

/** How a status reads at a glance. The web app turns each tone into one badge style. */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "muted" | "struck";
export interface StatusLabel {
  label: string;
  tone: Tone;
}

const s = (label: string, tone: Tone = "neutral"): StatusLabel => ({ label, tone });
const withTones = <K extends string>(labels: Record<K, string>, tones: Partial<Record<K, Tone>>): Record<K, StatusLabel> =>
  Object.fromEntries(Object.entries(labels).map(([k, label]) => [k, s(label as string, tones[k as K])])) as Record<K, StatusLabel>;

type Values<T extends readonly string[]> = T[number];

/** Every status the office screens show, by what it is the status of. */
export const STATUS_LABELS = {
  customer: { active: s("Active", "success"), inactive: s("Inactive", "muted"), prospect: s("Prospect", "info") } satisfies Record<Values<typeof CUSTOMER_STATUSES>, StatusLabel>,
  contact: { primary: s("Primary"), billing: s("Billing"), site: s("At the site"), other: s("Other") } satisfies Record<Values<typeof CONTACT_TYPES>, StatusLabel>,
  contract: { upcoming: s("Starts soon", "info"), active: s("Active", "success"), expired: s("Expired", "danger"), cancelled: s("Cancelled", "struck") } satisfies Record<Values<typeof CONTRACT_STATES>, StatusLabel>,
  /** A contract's visit: still to do, done, or no longer owed. */
  obligation: { open: s("To do"), completed: s("Done", "success"), cancelled: s("Cancelled", "struck") } satisfies Record<Values<typeof OBLIGATION_STATUSES>, StatusLabel>,
  job: { scheduled: s("Scheduled", "info"), in_progress: s("In progress", "info"), completed: s("Completed", "success"), cancelled: s("Cancelled", "struck") } satisfies Record<JobStatus, StatusLabel>,
  workOrder: withTones<WorkOrderStatus>(WORK_ORDER_STATUS_LABELS, { draft: "muted", scheduled: "info", in_progress: "info", completed: "success", cancelled: "struck" }),
  priority: { normal: s("Normal"), urgent: s("Urgent", "danger") } satisfies Record<Values<typeof WORK_ORDER_PRIORITIES>, StatusLabel>,
  estimate: withTones<EstimateStatus>(ESTIMATE_STATUS_LABELS, { draft: "muted", sent: "info", viewed: "info", accepted: "success", declined: "danger", expired: "danger", void: "struck", cancelled: "struck" }),
  renewal: withTones<RenewalStatus>(RENEWAL_STATUS_LABELS, { sent: "info", viewed: "info", signed: "warning", payment_pending: "warning", paid: "warning", activated: "success", declined: "muted", expired: "muted", needs_review: "danger" }),
  /** Where an invoice stands before payment: a draft, issued, or voided. */
  invoice: { draft: s("Draft", "muted"), open: s("Issued", "info"), void: s("Void", "struck") } satisfies Record<InvoiceStatus, StatusLabel>,
  /** How far an invoice is paid. */
  payment: withTones<InvoicePaymentStatus>(PAYMENT_STATUS_LABELS, { processing: "info", partial: "warning", paid: "success", overpaid: "warning", refunded: "muted" }),
  /** One payment taken against an invoice. */
  paymentRecord: { pending: s("Clearing", "info"), succeeded: s("Received", "success"), failed: s("Failed", "danger") } satisfies Record<PaymentRecordStatus, StatusLabel>,
  membership: { active: s("Active", "success"), deactivated: s("Deactivated", "muted") },
  invitation: { pending: s("Pending", "info"), expired: s("Expired", "danger"), accepted: s("Accepted", "success"), revoked: s("Withdrawn", "struck") } satisfies Record<InvitationStatus, StatusLabel>,
  import: { preview: s("Preview", "info"), committed: s("Imported", "success"), failed: s("Failed", "danger"), discarded: s("Discarded", "struck"), undone: s("Undone", "struck") } satisfies Record<Values<typeof IMPORT_STATUSES>, StatusLabel>,
  importRow: { ready: s("Ready", "success"), warning: s("Check", "warning"), duplicate: s("Duplicate", "info"), error: s("Error", "danger") } satisfies Record<Values<typeof IMPORT_ROW_STATUSES>, StatusLabel>,
  severity: { high: s("High", "danger"), medium: s("Medium", "warning"), low: s("Low") } satisfies Record<Values<typeof EXCEPTION_SEVERITIES>, StatusLabel>,
  plan: { offered: s("Offered", "success"), retired: s("Retired", "muted") },
  active: { on: s("On", "success"), off: s("Off", "struck") },
} as const;

export type StatusDomain = keyof typeof STATUS_LABELS;
export type StatusValue<D extends StatusDomain> = keyof (typeof STATUS_LABELS)[D] & string;

/** How often a plan is billed, as it reads after "billed" ("billed twice a year"). */
export const BILLING_FREQUENCY_LABELS: Record<Values<typeof BILLING_FREQUENCIES>, string> = { annual: "once a year", semiannual: "twice a year", quarterly: "every quarter", monthly: "every month" };

export const CUSTOMER_TYPE_LABELS: Record<Values<typeof CUSTOMER_TYPES>, string> = { residential: "Residential", commercial: "Commercial" };

/** A system's disposal and chlorination, recorded as short words ("spray", "tablet"). */
export const DISPOSAL_TYPE_LABELS: Record<string, string> = { spray: "Spray irrigation", drip: "Drip irrigation", other: "Other" };
export const CHLORINATION_LABELS: Record<string, string> = { tablet: "Tablet chlorinator", liquid: "Liquid chlorinator", none: "No chlorinator" };

/** "in_progress" as "In progress": the fallback for a value with no label yet. */
export function humanize(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : value;
}

/** The label and tone for a stored status. An unknown value reads as words, never as the raw value. */
export function statusLabel<D extends StatusDomain>(domain: D, value: StatusValue<D> | (string & {})): StatusLabel {
  const known = (STATUS_LABELS[domain] as Record<string, StatusLabel>)[value];
  return known ?? s(humanize(value));
}

/**
 * A recorded answer as its form words it: an option's label ("Good", not "good"), Pass or
 * Fail, Yes or No, a number with its unit. The office reads what the customer signed.
 */
export function formatAnswer(def: Pick<TemplateDefinition, "fields"> | undefined, key: string, value: unknown): string {
  const field = def?.fields.find((f) => f.key === key);
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value === null || value === undefined || value === "") return "—";
  if (field?.type === "pass_fail") return value === "pass" ? "Pass" : value === "fail" ? "Fail" : String(value);
  if (field?.type === "select") return field.options.find((o) => o.value === value)?.label ?? humanize(String(value));
  if (field?.type === "number" && field.unit) return `${value} ${field.unit}`;
  return String(value);
}

/** "Oct 25, 2026" for a YYYY-MM-DD calendar date, whatever zone the code runs in. */
export function formatDate(date: string): string {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "Oct 25, 2026" for the calendar day a moment falls on in a time zone (the company's, not UTC). */
export function formatDateOf(at: Date, timeZone: string): string {
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone });
}
