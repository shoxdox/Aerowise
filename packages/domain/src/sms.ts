import { z } from "zod";
import { id } from "./crm.ts";

// Text messages to homeowners: on-the-way, inspection done, report ready, renewal and
// payment reminders. Only to contacts who agreed to texts, never to a number that replied
// STOP, and automatic texts only during the day.

export const SMS_KINDS = ["on_the_way", "inspection_completed", "report_ready", "renewal_reminder", "payment_reminder"] as const;
export type SmsKind = (typeof SMS_KINDS)[number];
export const SMS_KIND_LABELS: Record<SmsKind, string> = {
  on_the_way: "Technician on the way",
  inspection_completed: "Inspection completed",
  report_ready: "Report ready",
  renewal_reminder: "Renewal reminder",
  payment_reminder: "Payment reminder",
};
/**
 * Which texts go once texting is turned on. "Inspection completed" is off by default: the
 * report-ready text follows a minute later and says the same and more.
 */
export const DEFAULT_SMS_KINDS: SmsKind[] = ["on_the_way", "report_ready", "renewal_reminder", "payment_reminder"];

export const SMS_STATUSES = ["sending", "sent", "delivered", "failed", "skipped", "received"] as const;
export type SmsStatus = (typeof SMS_STATUSES)[number];
export const SMS_SKIP_REASONS = ["no_phone", "no_consent", "opted_out"] as const;
export type SmsSkipReason = (typeof SMS_SKIP_REASONS)[number];
export const SMS_SKIP_LABELS: Record<SmsSkipReason, string> = {
  no_phone: "No mobile number on file",
  no_consent: "No contact agreed to texts",
  opted_out: "Replied STOP",
};

/**
 * Automatic texts go between these local hours (8 am to 9 pm), as US texting rules expect;
 * one due earlier or later waits for the morning. "On the way" is exempt: a technician sends
 * it, about a visit happening now.
 */
export const SMS_QUIET_END_HOUR = 8;
export const SMS_QUIET_START_HOUR = 21;
/** Overdue invoices get a payment reminder this many days after the due date. */
export const PAYMENT_REMINDER_DAYS = [3, 14] as const;
/** A reminder that was missed (texting was off) is not sent more than this many days late. */
export const PAYMENT_REMINDER_GRACE_DAYS = 7;
/** The office can text one payment reminder per invoice this often. */
export const MANUAL_REMINDER_HOURS = 24;
/** A text the provider keeps refusing for a temporary reason is given up after this many tries. */
export const SMS_MAX_ATTEMPTS = 5;

/** Replies that stop and restart texts, as carriers define them. */
export const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"];
export const START_WORDS = ["START", "UNSTOP", "YES"];
export const HELP_WORDS = ["HELP", "INFO"];
export type SmsKeyword = "stop" | "start" | "help";

/** What a reply means, if it is one of the carrier keywords (the whole message, any case). */
export function smsKeyword(body: string): SmsKeyword | null {
  const word = body.trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (STOP_WORDS.includes(word)) return "stop";
  if (START_WORDS.includes(word)) return "start";
  if (HELP_WORDS.includes(word)) return "help";
  return null;
}

/**
 * A phone number in E.164 form (+15125550123), or null when it cannot be one. Ten digits
 * are taken as a US number; anything else must already start with + and a country code.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // An extension is never part of a mobile number.
  const main = trimmed.split(/\s*(?:x|ext\.?|extension)\s*\d+$/i)[0]!;
  const digits = main.replace(/\D/g, "");
  if (main.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10 && /^[2-9]\d{2}[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && /^1[2-9]\d{2}[2-9]/.test(digits)) return `+${digits}`;
  return null;
}

/** +15125550123 as (512) 555-0123; other countries as given. */
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

function localClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { hour: n("hour"), minute: n("minute"), second: n("second") };
}

/** Whether a text may go now: between 8 am and 9 pm where the provider works. */
export function smsAllowedAt(at: Date, timeZone: string): boolean {
  const { hour } = localClock(at, timeZone);
  return hour >= SMS_QUIET_END_HOUR && hour < SMS_QUIET_START_HOUR;
}

/** The first moment at or after `at` when a text may go. */
export function nextSmsTime(at: Date, timeZone: string): Date {
  if (smsAllowedAt(at, timeZone)) return at;
  const { hour, minute, second } = localClock(at, timeZone);
  const sinceMidnight = hour * 3600 + minute * 60 + second;
  const opens = SMS_QUIET_END_HOUR * 3600;
  const wait = (opens - sinceMidnight + 86_400) % 86_400;
  const next = new Date(at.getTime() + wait * 1000);
  next.setUTCMilliseconds(0);
  // A daylight saving change overnight moves the clock by an hour; land on 8 am itself.
  const drift = localClock(next, timeZone).hour - SMS_QUIET_END_HOUR;
  return drift === 0 ? next : new Date(next.getTime() - drift * 3600_000);
}

const datetime = z.iso.datetime({ offset: true });
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, "Use the full number with country code, like +15125550123");

/** Live: a real provider. Test: the built-in stand-in, nothing leaves Aerowise. Off: not configured. */
export const SMS_MODES = ["live", "test", "off"] as const;

export const smsSettings = z.object({
  mode: z.enum(SMS_MODES),
  enabled: z.boolean(),
  kinds: z.array(z.enum(SMS_KINDS)),
  /** The number texts come from and replies go to. */
  fromNumber: z.string().nullable(),
  /** Where the provider sends replies and delivery receipts (set these on the number). */
  webhooks: z.object({ inbound: z.string(), status: z.string() }).nullable(),
});
export type SmsSettings = z.infer<typeof smsSettings>;

export const smsSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  kinds: z.array(z.enum(SMS_KINDS)).max(SMS_KINDS.length).optional(),
  fromNumber: e164.nullish(),
});

export const smsMessage = z.object({
  id,
  direction: z.enum(["outbound", "inbound"]),
  kind: z.enum(SMS_KINDS).nullable(),
  status: z.enum(SMS_STATUSES),
  skipReason: z.enum(SMS_SKIP_REASONS).nullable(),
  /** The customer's number: who it went to, or who it came from. */
  phone: z.string().nullable(),
  body: z.string(),
  error: z.string().nullable(),
  customer: z.object({ id, displayName: z.string() }).nullable(),
  contactName: z.string().nullable(),
  /** For a reply: when someone in the office dealt with it. */
  handledAt: datetime.nullable(),
  createdAt: datetime,
  sentAt: datetime.nullable(),
  deliveredAt: datetime.nullable(),
});
export type SmsMessage = z.infer<typeof smsMessage>;

export const SMS_MESSAGE_FILTERS = ["all", "replies", "problems"] as const;

export const smsOptOut = z.object({
  phone: z.string(),
  source: z.enum(["reply", "carrier"]),
  optedOutAt: datetime,
  customers: z.array(z.object({ id, displayName: z.string() })),
});
export type SmsOptOut = z.infer<typeof smsOptOut>;

/** What happened when someone asked for a text: queued, or why it will not go. */
export const SMS_QUEUE_OUTCOMES = ["queued", "off", ...SMS_SKIP_REASONS] as const;
export type SmsQueueOutcome = (typeof SMS_QUEUE_OUTCOMES)[number];
export const smsQueueResult = z.object({ outcome: z.enum(SMS_QUEUE_OUTCOMES), to: z.string().nullable() });
export type SmsQueueResult = z.infer<typeof smsQueueResult>;

export const smsTestInbound = z.object({ from: z.string().trim().min(7).max(40), body: z.string().trim().min(1).max(1600) });
