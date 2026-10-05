import type { Database, EmailDeliveryStatus, EmailEventType } from "@aerowise/db";
import { sql } from "kysely";
import { messageIdFor, type EmailMessage, type EmailResult, type EmailTransport } from "./email.ts";
import { recordFilingDeliveryProblem } from "./filings.ts";

/**
 * A real mail provider (Resend today). It sends, can look a message up afterwards, and
 * verifies its webhooks. `ProviderTransport` wraps it with the bookkeeping that makes a
 * send safe to retry, so providers stay thin.
 */
export interface EmailProvider {
  readonly name: string;
  /** How long the provider remembers an idempotency key and answers a repeat with the first result. */
  readonly idempotencyWindowMs: number;
  /** Sends under the idempotency key. Throws `EmailProviderError` when it fails. */
  send(m: EmailMessage, sendId: string): Promise<{ providerMessageId: string; response: Record<string, unknown> }>;
  /**
   * Looks for a message an earlier attempt may have sent, since `since`. `isKnown` says
   * whether a provider id already belongs to another recorded send, so it is not claimed twice.
   */
  find(q: { sendId: string; from: string; to: string; subject: string; since: Date; isKnown: (providerMessageId: string) => Promise<boolean> }): Promise<FindResult>;
  /** Verifies a webhook request and reads the event. Throws `EmailWebhookSignatureError` when it does not verify. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now: Date): EmailWebhookEvent;
}

export type FindResult =
  | { kind: "found"; providerMessageId: string; response: Record<string, unknown> }
  | { kind: "not_found" }
  /** The provider could not say for sure (several candidates, or too far back to search). */
  | { kind: "unknown"; reason: string };

export interface EmailWebhookEvent {
  /** The provider's id for this delivery of the event; repeats are ignored. */
  id: string;
  type: EmailEventType | null;
  occurredAt: Date;
  providerMessageId: string;
  /** Our email_sends id, when the provider echoes the tag we sent it. */
  sendId: string | null;
  detail: string | null;
  payload: Record<string, unknown>;
}

/**
 * A failed send. `definite` means the provider certainly did not send it (it refused the
 * request); otherwise it may have gone out (a timeout, a dropped connection, a 5xx).
 */
export class EmailProviderError extends Error {
  constructor(
    message: string,
    readonly definite: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class EmailWebhookSignatureError extends Error {}

/** A send that may already have gone out and could not be matched at the provider: a person decides. */
export class EmailNeedsReviewError extends Error {}

/** Checks reconciliation this long before the provider's idempotency window closes, to allow for clock skew. */
const WINDOW_MARGIN_MS = 60 * 60_000;

/**
 * Sends through a real provider and keeps one email_sends row per idempotency key:
 * - a key already accepted is answered from the row, without calling the provider;
 * - inside the provider's idempotency window a retry is sent again with the same key, and
 *   the provider answers with the first result instead of sending twice;
 * - past the window, a send whose earlier attempt may have gone out is looked up at the
 *   provider first. Found: it is recorded as accepted. Not found: it is sent. Unsure: it
 *   is held for a person (needs_review) and never sent automatically.
 * `redirectTo` (for staging) sends everything to one test inbox instead of the real recipient.
 */
export class ProviderTransport implements EmailTransport {
  readonly name: string;
  constructor(
    private readonly db: Database,
    private readonly provider: EmailProvider,
    private readonly now: () => Date = () => new Date(),
    private readonly opts: { redirectTo?: string } = {},
  ) {
    this.name = provider.name;
  }

  async send(original: EmailMessage): Promise<EmailResult> {
    const m = this.opts.redirectTo
      ? { ...original, to: this.opts.redirectTo, subject: `[for ${original.to}] ${original.subject}` }
      : original;
    const at = this.now();
    await this.db
      .insertInto("emailSends")
      .values({
        organizationId: m.organizationId,
        idempotencyKey: m.idempotencyKey,
        provider: this.provider.name,
        recipient: m.to,
        subject: m.subject,
        status: "sending",
        firstAttemptAt: at,
        lastAttemptAt: at,
      })
      .onConflict((oc) =>
        m.organizationId === null
          ? oc.column("idempotencyKey").where("organizationId", "is", null).doNothing()
          : oc.columns(["organizationId", "idempotencyKey"]).doNothing(),
      )
      .execute();
    const row = await this.db
      .selectFrom("emailSends")
      .selectAll()
      .where("organizationId", m.organizationId === null ? "is" : "=", m.organizationId)
      .where("idempotencyKey", "=", m.idempotencyKey)
      .executeTakeFirstOrThrow();
    if (row.status === "accepted") return resultOf(row);
    if (row.status === "needs_review") throw new EmailNeedsReviewError(row.error ?? needsReview("an earlier attempt"));

    let uncertainSince = row.uncertainSince;
    if (uncertainSince && at.getTime() - uncertainSince.getTime() >= this.provider.idempotencyWindowMs - WINDOW_MARGIN_MS) {
      const found = await this.provider.find({
        sendId: row.id,
        from: m.from,
        to: m.to,
        subject: m.subject,
        since: new Date(uncertainSince.getTime() - 5 * 60_000),
        isKnown: async (providerMessageId) =>
          !!(await this.db.selectFrom("emailSends").select("id").where("provider", "=", this.provider.name).where("providerMessageId", "=", providerMessageId).where("id", "<>", row.id).executeTakeFirst()),
      });
      if (found.kind === "found") return this.accept(row.id, found.providerMessageId, { ...found.response, reconciled: true }, at);
      if (found.kind === "unknown") {
        const error = needsReview(`the attempt at ${uncertainSince.toISOString()}`, found.reason);
        await this.db.updateTable("emailSends").set({ status: "needs_review", error }).where("id", "=", row.id).execute();
        throw new EmailNeedsReviewError(error);
      }
      // The provider has no such message: nothing went out, and a fresh window starts now.
      uncertainSince = null;
    }

    // Until the provider answers, this attempt may or may not have gone out.
    await this.db
      .updateTable("emailSends")
      .set({ status: "sending", attempts: sql`attempts + 1`, lastAttemptAt: at, uncertainSince: uncertainSince ?? at, recipient: m.to, subject: m.subject })
      .where("id", "=", row.id)
      .execute();
    let sent;
    try {
      sent = await this.provider.send(m, row.id);
    } catch (err) {
      const definite = err instanceof EmailProviderError && err.definite;
      await this.db
        .updateTable("emailSends")
        .set({ status: "failed", error: ((err as Error).message || String(err)).slice(0, 2000), uncertainSince: definite ? uncertainSince : (uncertainSince ?? at) })
        .where("id", "=", row.id)
        .execute();
      throw err;
    }
    return this.accept(row.id, sent.providerMessageId, sent.response, this.now());
  }

  private async accept(id: string, providerMessageId: string, response: Record<string, unknown>, at: Date) {
    const row = await this.db
      .updateTable("emailSends")
      .set({ status: "accepted", providerMessageId, acceptedAt: at, response: JSON.stringify(response), error: null, uncertainSince: null })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return resultOf(row);
  }
}

const needsReview = (what: string, reason?: string) =>
  `Not sent again: ${what} may have reached the mail provider${reason ? ` (${reason})` : ""}. Check the provider's sending log before sending it another way.`;

function resultOf(row: { providerMessageId: string | null; acceptedAt: Date | null; idempotencyKey: string; provider: string; recipient: string; response: unknown }): EmailResult {
  return {
    // The provider's id, which is what its dashboard and webhooks use.
    messageId: row.providerMessageId ?? messageIdFor(row.idempotencyKey),
    acceptedAt: row.acceptedAt!.toISOString(),
    response: { ...(row.response as Record<string, unknown>), transport: row.provider, to: row.recipient },
  };
}

/** Later events never undo worse news: a bounce stays a bounce when a "delivered" arrives late. */
const RANK: Record<EmailDeliveryStatus, number> = { delayed: 0, delivered: 1, bounced: 2, complained: 2, failed: 2, suppressed: 2 };
export const EMAIL_PROBLEMS = ["bounced", "complained", "failed", "suppressed"] as const;
const isProblem = (s: EmailDeliveryStatus): s is (typeof EMAIL_PROBLEMS)[number] => (EMAIL_PROBLEMS as readonly string[]).includes(s);

/**
 * Records a verified webhook event on the send it is about. Returns what happened, for the
 * log. An event for a send we do not know (another environment on the same account) is ignored.
 */
export async function applyEmailEvent(db: Database, provider: string, e: EmailWebhookEvent, now: Date): Promise<"applied" | "duplicate" | "unknown" | "ignored"> {
  const type = e.type;
  if (!type) return "ignored";
  return db.transaction().execute(async (trx) => {
    let send = await trx.selectFrom("emailSends").selectAll().where("provider", "=", provider).where("providerMessageId", "=", e.providerMessageId).forUpdate().executeTakeFirst();
    if (!send && e.sendId && /^[0-9a-f-]{36}$/.test(e.sendId)) {
      send = await trx.selectFrom("emailSends").selectAll().where("provider", "=", provider).where("id", "=", e.sendId).where("providerMessageId", "is", null).forUpdate().executeTakeFirst();
      // The provider took a send whose answer we never got: the event settles it.
      if (send) {
        send = await trx
          .updateTable("emailSends")
          .set({ providerMessageId: e.providerMessageId, status: "accepted", acceptedAt: send.acceptedAt ?? e.occurredAt, uncertainSince: null, error: null, response: JSON.stringify({ reconciledBy: "webhook", event: e.id }) })
          .where("id", "=", send.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
    }
    if (!send) return "unknown";
    const inserted = await trx
      .insertInto("emailEvents")
      .values({ organizationId: send.organizationId, emailSendId: send.id, provider, providerEventId: e.id, type, occurredAt: e.occurredAt, receivedAt: now, detail: e.detail, payload: JSON.stringify(e.payload) })
      .onConflict((oc) => oc.columns(["provider", "providerEventId"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!inserted) return "duplicate";
    if (type === "sent") return "applied";
    const status = type;
    if (send.deliveryStatus && RANK[send.deliveryStatus] > RANK[status]) return "applied";
    await trx.updateTable("emailSends").set({ deliveryStatus: status, deliveryDetail: e.detail, deliveryUpdatedAt: e.occurredAt }).where("id", "=", send.id).execute();
    // Platform email (no organization) has no filing behind it to flag.
    if (isProblem(status) && send.deliveryStatus !== status && send.organizationId) {
      await recordFilingDeliveryProblem(trx, { organizationId: send.organizationId, idempotencyKey: send.idempotencyKey, recipient: send.recipient, status, detail: e.detail, at: e.occurredAt });
    }
    return "applied";
  });
}
