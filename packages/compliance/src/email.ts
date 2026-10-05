import { createHash } from "node:crypto";
import type { ObjectStore } from "@aerowise/storage";

export interface EmailMessage {
  /** Null for email to Aerowise itself, which belongs to no organization (demo request alerts). */
  organizationId: string | null;
  /**
   * The same key always means the same message. A transport must deliver a key at most
   * once and answer a repeat with the first result; this is what makes a retried filing
   * safe. It is also the Message-ID, so a duplicate that slipped through is recognizable.
   */
  idempotencyKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

export interface EmailResult {
  messageId: string;
  acceptedAt: string;
  /** What the provider said, kept on the filing attempt. */
  response: Record<string, unknown>;
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailResult>;
}

export const messageIdFor = (idempotencyKey: string) => `<${idempotencyKey.replace(/[^a-zA-Z0-9.-]/g, ".")}@aerowise.invalid>`;

/** RFC 5322 text with the attachments base64-encoded: a file any mail client can open. */
export function toEml(m: EmailMessage, messageId: string, date: Date): string {
  const boundary = `aw-${createHash("sha256").update(messageId).digest("hex").slice(0, 24)}`;
  const lines = [
    `Message-ID: ${messageId}`,
    `Date: ${date.toUTCString()}`,
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${m.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    m.text,
  ];
  for (const a of m.attachments) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${a.filename}"`,
      "",
      ...(a.content.toString("base64").match(/.{1,76}/g) ?? []),
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

/**
 * Where the outbox keeps email that belongs to no organization. Storage keys start with an
 * organization id; the nil UUID is never one (ids are random v4 UUIDs).
 */
const PLATFORM_OUTBOX = "00000000-0000-0000-0000-000000000000";

/**
 * Development transport: writes each message as an .eml file to the organization's
 * outbox in file storage instead of sending it. Idempotent by key like a real provider
 * must be. Production needs a real provider behind the same interface (see README).
 */
export class OutboxTransport implements EmailTransport {
  readonly name = "outbox";
  constructor(
    private readonly store: ObjectStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private key(m: EmailMessage) {
    return `${m.organizationId ?? PLATFORM_OUTBOX}/outbox/${createHash("sha256").update(m.idempotencyKey).digest("hex")}`;
  }

  async send(m: EmailMessage): Promise<EmailResult> {
    const receiptKey = `${this.key(m)}.json`;
    const previous = await this.store.get(receiptKey);
    if (previous) return JSON.parse(previous.toString("utf8")) as EmailResult;
    const messageId = messageIdFor(m.idempotencyKey);
    const at = this.now();
    await this.store.put(`${this.key(m)}.eml`, Buffer.from(toEml(m, messageId, at)), "message/rfc822");
    const result: EmailResult = { messageId, acceptedAt: at.toISOString(), response: { transport: this.name, to: m.to } };
    await this.store.put(receiptKey, Buffer.from(JSON.stringify(result)), "application/json");
    return result;
  }
}
