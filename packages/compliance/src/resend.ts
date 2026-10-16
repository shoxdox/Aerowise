import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { EmailEventType } from "@aerowise/db";
import type { EmailMessage } from "./email.ts";
import { EmailProviderError, EmailWebhookSignatureError, type EmailProvider, type EmailWebhookEvent, type FindResult } from "./email-provider.ts";

type Fetch = typeof fetch;

/** Resend keeps idempotency keys for 24 hours (resend.com/docs/dashboard/emails/idempotency-keys, read 2026-10-05). */
const RESEND_IDEMPOTENCY_MS = 24 * 60 * 60_000;
/** Webhooks older or newer than this are refused (replay protection). */
const WEBHOOK_TOLERANCE_S = 5 * 60;
/** Reconciling reads at most this many pages of 100 sent emails before giving up. */
const MAX_PAGES = 20;

const EVENT_TYPES: Record<string, EmailEventType> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
};

/**
 * Resend's keys are account-wide, ours are per organization: prefix the organization. Resend
 * allows 256 characters; a longer key is hashed.
 */
function providerKey(m: EmailMessage) {
  const key = `${m.organizationId}/${m.idempotencyKey}`;
  return key.length <= 256 ? key : createHash("sha256").update(key).digest("hex");
}

/**
 * Resend (resend.com) over its HTTP API. Every send carries the idempotency key in the
 * `Idempotency-Key` header, and a tag with our send id so webhooks can be matched even when
 * the send's answer was lost. Webhooks are signed the Svix way.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  readonly idempotencyWindowMs = RESEND_IDEMPOTENCY_MS;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;
  private readonly webhookSecrets: Buffer[];

  constructor(opts: { apiKey: string; webhookSecrets?: string[]; baseUrl?: string; fetch?: Fetch; timeoutMs?: number }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.resend.com").replace(/\/$/, "");
    this.fetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.webhookSecrets = (opts.webhookSecrets ?? []).map((s) => Buffer.from(s.replace(/^whsec_/, ""), "base64"));
  }

  private async call(method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // No answer: the request may or may not have been taken.
      throw new EmailProviderError(`Resend did not answer: ${(err as Error).message}`, false);
    }
    const text = await res.text().catch(() => "");
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    if (!res.ok) {
      // Refused requests (bad input, auth, rate limit) were not sent. 409 means the key is
      // in use or was used for another payload, and 5xx may have sent: neither is certain.
      const definite = res.status < 500 && res.status !== 409;
      throw new EmailProviderError(`Resend answered ${res.status}: ${String(body.message ?? body.name ?? text).slice(0, 300)}`, definite, res.status);
    }
    return body;
  }

  async send(m: EmailMessage, sendId: string) {
    const body = await this.call("POST", "/emails", {
      headers: { "idempotency-key": providerKey(m) },
      body: {
        from: m.from,
        to: [m.to],
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
        subject: m.subject,
        text: m.text,
        attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64"), content_type: a.contentType })),
        tags: [
          { name: "aw_send", value: sendId },
          { name: "aw_org", value: m.organizationId ?? "platform" },
        ],
        headers: { "X-Aerowise-Key": m.idempotencyKey.slice(0, 200) },
      },
    });
    if (typeof body.id !== "string") throw new EmailProviderError("Resend accepted the request but returned no email id", false);
    return { providerMessageId: body.id, response: { id: body.id } };
  }

  /**
   * Resend cannot search by tag, so this pages through recent sends (newest first) back to
   * `since` and matches sender, recipient and subject, skipping ids already recorded for
   * another send. One match is the message; none means it was not sent; more than one, or
   * too many pages, is unknown.
   */
  async find(q: Parameters<EmailProvider["find"]>[0]): Promise<FindResult> {
    const matches: Record<string, unknown>[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.call("GET", `/emails?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      const items = (Array.isArray(body.data) ? body.data : []) as Record<string, unknown>[];
      let reachedSince = false;
      for (const e of items) {
        if (new Date(String(e.created_at)).getTime() < q.since.getTime()) {
          reachedSince = true;
          continue;
        }
        const to = Array.isArray(e.to) ? e.to.map(String) : [String(e.to)];
        if (e.from === q.from && e.subject === q.subject && to.length === 1 && to[0]!.toLowerCase() === q.to.toLowerCase() && !(await q.isKnown(String(e.id)))) matches.push(e);
      }
      if (reachedSince || body.has_more !== true || items.length === 0) {
        if (matches.length === 0) return { kind: "not_found" };
        if (matches.length === 1) return { kind: "found", providerMessageId: String(matches[0]!.id), response: { id: matches[0]!.id, lastEvent: matches[0]!.last_event ?? null } };
        return { kind: "unknown", reason: `${matches.length} sent emails match its sender, recipient and subject` };
      }
      after = String(items[items.length - 1]!.id);
    }
    return { kind: "unknown", reason: `more than ${MAX_PAGES * 100} emails were sent since then` };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now: Date): EmailWebhookEvent {
    const header = (n: string) => {
      const v = headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    const id = header("svix-id");
    const timestamp = header("svix-timestamp");
    const signatures = header("svix-signature");
    if (!id || !timestamp || !signatures || this.webhookSecrets.length === 0) throw new EmailWebhookSignatureError("Missing webhook signature");
    if (!/^\d+$/.test(timestamp) || Math.abs(now.getTime() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_S) throw new EmailWebhookSignatureError("Webhook timestamp is too old or too new");
    const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), rawBody]);
    const given = signatures
      .split(" ")
      .map((s) => s.split(","))
      .filter(([v, sig]) => v === "v1" && sig)
      .map(([, sig]) => Buffer.from(sig!, "base64"));
    const ok = this.webhookSecrets.some((secret) => {
      const expected = createHmac("sha256", secret).update(signed).digest();
      return given.some((g) => g.length === expected.length && timingSafeEqual(g, expected));
    });
    if (!ok) throw new EmailWebhookSignatureError("Webhook signature did not verify");

    const event = JSON.parse(rawBody.toString("utf8")) as { type?: string; created_at?: string; data?: Record<string, unknown> };
    const data = event.data ?? {};
    const tags = (data.tags ?? {}) as Record<string, unknown> | { name: string; value: string }[];
    const sendId = Array.isArray(tags) ? (tags.find((t) => t.name === "aw_send")?.value ?? null) : typeof tags.aw_send === "string" ? tags.aw_send : null;
    const bounce = data.bounce as { message?: string; type?: string; subType?: string } | undefined;
    const failed = data.failed as { reason?: string } | undefined;
    const detail = bounce ? [bounce.type, bounce.subType, bounce.message].filter(Boolean).join(" / ") : (failed?.reason ?? null);
    return {
      id,
      type: EVENT_TYPES[event.type ?? ""] ?? null,
      occurredAt: new Date(event.created_at ?? now.toISOString()),
      providerMessageId: String(data.email_id ?? ""),
      sendId,
      detail: detail || null,
      payload: event as Record<string, unknown>,
    };
  }
}

/** Signs a webhook body the way Resend (Svix) does. For tests and the local webhook check. */
export function signResendWebhook(secret: string, id: string, timestamp: number, body: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${sig}` };
}
