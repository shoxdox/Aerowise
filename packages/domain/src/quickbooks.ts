import { z } from "zod";
import { id } from "./crm.ts";

// QuickBooks Online sync. Aerowise sends customers, invoices and payments to the
// provider's QuickBooks company. Nothing in QuickBooks is overwritten without a person
// choosing to: anything Aerowise cannot settle on its own becomes a conflict to decide.

export const QUICKBOOKS_ENTITY_TYPES = ["customer", "plan", "invoice", "payment"] as const;
export type QuickBooksEntityType = (typeof QUICKBOOKS_ENTITY_TYPES)[number];

/** Per record. "Not connected" is not stored: it is the absence of a connection. */
export const QUICKBOOKS_SYNC_STATUSES = ["new", "queued", "syncing", "synced", "conflict", "failed", "ignored"] as const;
export type QuickBooksSyncStatus = (typeof QUICKBOOKS_SYNC_STATUSES)[number];

export const QUICKBOOKS_SYNC_STATUS_LABELS: Record<QuickBooksSyncStatus, string> = {
  new: "Not sent yet",
  queued: "Waiting to send",
  syncing: "Sending",
  synced: "In QuickBooks",
  conflict: "Needs a decision",
  failed: "Failed",
  ignored: "Not synced",
};

export const QUICKBOOKS_CONFLICT_KINDS = [
  "ambiguous_match",
  "changed_in_both",
  "deleted_in_quickbooks",
  "item_missing",
  "tax_mapping_missing",
  "payment_mismatch",
  "duplicate_number",
] as const;
export type QuickBooksConflictKind = (typeof QUICKBOOKS_CONFLICT_KINDS)[number];

export const QUICKBOOKS_ACTIONS = ["match", "create", "use_aerowise", "keep_quickbooks", "recreate", "send_anyway", "retry", "ignore"] as const;
export type QuickBooksAction = (typeof QUICKBOOKS_ACTIONS)[number];

export const QUICKBOOKS_ACTION_LABELS: Record<QuickBooksAction, string> = {
  match: "Link to this QuickBooks record",
  create: "Create a new customer in QuickBooks",
  use_aerowise: "Send the Aerowise version",
  keep_quickbooks: "Keep the QuickBooks version",
  recreate: "Send it to QuickBooks again",
  send_anyway: "Send the payment anyway",
  retry: "Try again",
  ignore: "Stop syncing this record",
};

/** What each kind of problem means, what to do, and which choices fix it. The first choice is recommended. */
export const QUICKBOOKS_CONFLICT_GUIDE: Record<QuickBooksConflictKind | "failed", { title: string; explanation: string; actions: QuickBooksAction[] }> = {
  ambiguous_match: {
    title: "Possible match in QuickBooks",
    explanation: "QuickBooks has one or more customers that could be this one. Pick the right one so the customer is not added twice, or create a new customer if none of them is.",
    actions: ["match", "create", "ignore"],
  },
  changed_in_both: {
    title: "Changed in both places",
    explanation: "This record was edited in Aerowise and in QuickBooks since the last sync: a customer's details, or a payment refunded in Aerowise and changed in QuickBooks. Choose which version QuickBooks should keep. Aerowise keeps its own details either way.",
    actions: ["keep_quickbooks", "use_aerowise"],
  },
  deleted_in_quickbooks: {
    title: "Deleted or made inactive in QuickBooks",
    explanation: "Someone deleted this record in QuickBooks (or made the customer inactive). Send it again only if that was a mistake.",
    actions: ["ignore", "recreate"],
  },
  item_missing: {
    title: "QuickBooks item missing",
    explanation: "An invoice line maps to a QuickBooks product or service that is missing, archived, or not chosen yet. Pick an item for it on the QuickBooks page, then try again.",
    actions: ["retry", "ignore"],
  },
  tax_mapping_missing: {
    title: "Sales tax not mapped",
    explanation: "This invoice charges sales tax, and Aerowise does not send tax to QuickBooks yet, so the totals would not agree. Enter this invoice in QuickBooks yourself and stop syncing it.",
    actions: ["ignore"],
  },
  payment_mismatch: {
    title: "Payment does not match QuickBooks",
    explanation: "QuickBooks shows less owed on this invoice than the payment, so the payment may already be recorded there. Check QuickBooks before sending it.",
    actions: ["ignore", "send_anyway"],
  },
  duplicate_number: {
    title: "Invoice number already used in QuickBooks",
    explanation: "QuickBooks already has an invoice with this number for a different customer or amount. Link to it only if it is the same invoice.",
    actions: ["ignore", "match"],
  },
  failed: {
    title: "Could not send to QuickBooks",
    explanation: "QuickBooks did not accept this record. Fix what the message says, then try again.",
    actions: ["retry", "ignore"],
  },
};

/** Automatic retries after a temporary failure, in minutes. After the last, a person retries. */
export const QUICKBOOKS_RETRY_MINUTES = [1, 5, 30, 120, 360] as const;

// ---- Matching customers (first sync, and new customers later) ----

export interface MatchableCustomer {
  name: string;
  email: string | null;
  phone: string | null;
}
export interface RemoteCustomer extends MatchableCustomer {
  id: string;
}

/** "Smith, John", "john  smith" and "JOHN SMITH." all become "john smith". */
export function normalizeName(name: string): string {
  let n = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const comma = n.split(",");
  // "Last, First" (but not "Smith, Inc.")
  if (comma.length === 2 && !/\b(inc|llc|ltd|co|corp|company)\b/.test(comma[1]!)) n = `${comma[1]} ${comma[0]}`;
  return n
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export const emailKey = (e: string | null | undefined) => (e ? e.trim().toLowerCase() || null : null);
/** The last ten digits, so "+1 (512) 555-0100" and "512.555.0100" agree. */
export function phoneKey(p: string | null | undefined): string | null {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

function bigrams(s: string): string[] {
  const t = s.replace(/ /g, "");
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** How alike two names are, 0 to 1, ignoring word order (Dice coefficient on letter pairs). */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a).split(" ").sort().join(" ");
  const y = normalizeName(b).split(" ").sort().join(" ");
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  if (!bx.length || !by.length) return 0;
  const pool = new Map<string, number>();
  for (const g of by) pool.set(g, (pool.get(g) ?? 0) + 1);
  let common = 0;
  for (const g of bx) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      common++;
      pool.set(g, n - 1);
    }
  }
  return (2 * common) / (bx.length + by.length);
}

/** Names at least this alike are offered as possible matches. */
export const FUZZY_NAME_THRESHOLD = 0.8;

export const MATCH_REASONS = ["same_name", "similar_name", "same_email", "same_phone"] as const;
export type MatchReason = (typeof MATCH_REASONS)[number];
export const MATCH_REASON_LABELS: Record<MatchReason, string> = { same_name: "Same name", similar_name: "Similar name", same_email: "Same email", same_phone: "Same phone" };

export interface MatchCandidate<R extends RemoteCustomer = RemoteCustomer> {
  customer: R;
  score: number;
  reasons: MatchReason[];
}

export type MatchResult<R extends RemoteCustomer = RemoteCustomer> =
  | { kind: "exact"; match: MatchCandidate<R> }
  | { kind: "review"; candidates: MatchCandidate<R>[] }
  | { kind: "none" };

/**
 * Finds the QuickBooks customer an Aerowise customer already is. Only an exact match is
 * taken without asking: exactly one QuickBooks customer with the same name and the same
 * email or phone. Anything weaker (a shared name alone, a similar name, a shared email or
 * phone under another name, or two exact matches) goes to a person.
 */
export function matchCustomer<R extends RemoteCustomer>(local: MatchableCustomer, remote: R[]): MatchResult<R> {
  const name = normalizeName(local.name);
  const email = emailKey(local.email);
  const phone = phoneKey(local.phone);
  const candidates: MatchCandidate<R>[] = [];
  for (const r of remote) {
    const reasons: MatchReason[] = [];
    const sim = nameSimilarity(local.name, r.name);
    if (normalizeName(r.name) === name) reasons.push("same_name");
    else if (sim >= FUZZY_NAME_THRESHOLD) reasons.push("similar_name");
    if (email && emailKey(r.email) === email) reasons.push("same_email");
    if (phone && phoneKey(r.phone) === phone) reasons.push("same_phone");
    if (!reasons.length) continue;
    const score = Math.round((sim * 0.6 + (reasons.includes("same_email") ? 0.25 : 0) + (reasons.includes("same_phone") ? 0.15 : 0)) * 100) / 100;
    candidates.push({ customer: r, score, reasons });
  }
  candidates.sort((a, b) => b.score - a.score || a.customer.name.localeCompare(b.customer.name));
  const exact = candidates.filter((c) => c.reasons.includes("same_name") && (c.reasons.includes("same_email") || c.reasons.includes("same_phone")));
  if (exact.length === 1) return { kind: "exact", match: exact[0]! };
  if (candidates.length) return { kind: "review", candidates: candidates.slice(0, 5) };
  return { kind: "none" };
}

// ---- API shapes ----

export const quickbooksCandidate = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  score: z.number(),
  reasons: z.array(z.enum(MATCH_REASONS)),
});
export type QuickBooksCandidate = z.infer<typeof quickbooksCandidate>;

const statusCounts = z.partialRecord(z.enum(QUICKBOOKS_SYNC_STATUSES), z.number().int());

export const quickbooksStatus = z.object({
  /** Which QuickBooks this server talks to: Intuit, the built-in test company, or none. */
  provider: z.enum(["intuit", "test", "none"]),
  connection: z
    .object({
      environment: z.enum(["test", "sandbox", "production"]),
      companyName: z.string().nullable(),
      status: z.enum(["connected", "needs_reauth", "disconnected"]),
      setupState: z.enum(["review", "active"]),
      syncFrom: z.iso.date(),
      defaultItem: z.object({ id: z.string(), name: z.string() }).nullable(),
      connectedAt: z.iso.datetime(),
      lastSyncStartedAt: z.iso.datetime().nullable(),
      lastSyncFinishedAt: z.iso.datetime().nullable(),
      lastSyncError: z.string().nullable(),
    })
    .nullable(),
  counts: z.object({ customer: statusCounts, plan: statusCounts, invoice: statusCounts, payment: statusCounts }),
  /** Records in conflict, or failed with no retry left: what the conflict center shows. */
  attention: z.number().int(),
});
export type QuickBooksStatus = z.infer<typeof quickbooksStatus>;

export const quickbooksItem = z.object({ id: z.string(), name: z.string(), type: z.string(), active: z.boolean() });
export type QuickBooksItem = z.infer<typeof quickbooksItem>;

export const quickbooksMapping = z.object({
  syncFrom: z.iso.date(),
  defaultItem: z.object({ id: z.string(), name: z.string() }).nullable(),
  plans: z.array(
    z.object({
      planId: id,
      planName: z.string(),
      active: z.boolean(),
      item: z.object({ id: z.string(), name: z.string() }).nullable(),
      status: z.enum(QUICKBOOKS_SYNC_STATUSES).nullable(),
    }),
  ),
});
export type QuickBooksMapping = z.infer<typeof quickbooksMapping>;

export const quickbooksMappingInput = z.object({
  syncFrom: z.iso.date().optional(),
  defaultItemId: z.string().min(1).max(40).nullable().optional(),
  /** A null item means plan lines use the default item. */
  plans: z.array(z.object({ planId: id, itemId: z.string().min(1).max(40).nullable() })).max(500).optional(),
});
export type QuickBooksMappingInput = z.infer<typeof quickbooksMappingInput>;

export const REVIEW_PROPOSALS = ["match", "review", "create", "skip"] as const;

export const quickbooksReviewRow = z.object({
  customer: z.object({ id, displayName: z.string(), email: z.string().nullable(), phone: z.string().nullable() }),
  /** What Aerowise found: an exact match, candidates to choose from, or nothing. */
  found: z.enum(["exact", "review", "none"]),
  decision: z.enum(["match", "create", "skip"]).nullable(),
  /** The QuickBooks customer chosen or matched. */
  match: quickbooksCandidate.nullable(),
  candidates: z.array(quickbooksCandidate),
});
export type QuickBooksReviewRow = z.infer<typeof quickbooksReviewRow>;

export const quickbooksReview = z.object({
  fetchedAt: z.iso.datetime().nullable(),
  remoteCustomers: z.number().int(),
  counts: z.object({ exact: z.number().int(), review: z.number().int(), none: z.number().int(), undecided: z.number().int() }),
  rows: z.array(quickbooksReviewRow),
});
export type QuickBooksReview = z.infer<typeof quickbooksReview>;

export const quickbooksReviewDecision = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("match"), externalId: z.string().min(1).max(40) }),
  z.object({ decision: z.literal("create") }),
  z.object({ decision: z.literal("skip") }),
]);

export const quickbooksRecord = z.object({
  id,
  entityType: z.enum(QUICKBOOKS_ENTITY_TYPES),
  entityId: id,
  /** What the record is, for people: a customer's name, "INV-1001", "$120.00 on INV-1001". */
  label: z.string(),
  customer: z.object({ id, displayName: z.string() }).nullable(),
  status: z.enum(QUICKBOOKS_SYNC_STATUSES),
  conflictKind: z.enum(QUICKBOOKS_CONFLICT_KINDS).nullable(),
  title: z.string().nullable(),
  explanation: z.string().nullable(),
  actions: z.array(z.enum(QUICKBOOKS_ACTIONS)),
  details: z.record(z.string(), z.unknown()).nullable(),
  candidates: z.array(quickbooksCandidate),
  externalId: z.string().nullable(),
  syncError: z.string().nullable(),
  retryCount: z.number().int(),
  nextAttemptAt: z.iso.datetime().nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type QuickBooksRecord = z.infer<typeof quickbooksRecord>;

export const quickbooksResolveInput = z.object({
  action: z.enum(QUICKBOOKS_ACTIONS),
  /** For "match": the QuickBooks record to link to. */
  externalId: z.string().min(1).max(40).optional(),
});
export type QuickBooksResolveInput = z.infer<typeof quickbooksResolveInput>;

/** Whether a record needs a person: a conflict, or a failure with no automatic retry left. */
export const needsAttention = (r: { status: QuickBooksSyncStatus; nextAttemptAt: Date | string | null }) =>
  r.status === "conflict" || (r.status === "failed" && !r.nextAttemptAt);
