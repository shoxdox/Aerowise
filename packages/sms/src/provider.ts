import { createHmac, timingSafeEqual } from "node:crypto";

export interface SmsSendInput {
  from: string;
  to: string;
  body: string;
  /** Where the provider reports delivery (or failure) later. */
  statusCallback: string | null;
}

export interface SmsSendResult {
  providerMessageId: string;
  /** `delivered` only from the test provider, which has no carrier to wait for. */
  status: "sent" | "delivered";
}

export interface SmsProvider {
  /** `twilio` sends real texts; `test` is the built-in stand-in and sends nothing. */
  readonly kind: "twilio" | "test";
  send(input: SmsSendInput): Promise<SmsSendResult>;
  /** Checks a webhook's signature against the exact URL the provider called. */
  verifyWebhook(url: string, params: Record<string, string>, signature: string): boolean;
}

/**
 * A send the provider refused. `permanent` means trying again cannot help (a landline,
 * an invalid number, a number that replied STOP); otherwise it is retried.
 */
export class SmsSendError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

/** The carrier says this number unsubscribed (replied STOP to us at some point). */
export const UNSUBSCRIBED_CODE = "21610";

/**
 * Twilio's request signature: HMAC-SHA1 of the URL followed by every form field (name then
 * value, sorted by name), keyed with the account's auth token, base64-encoded.
 */
export function webhookSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function signatureMatches(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const expected = Buffer.from(webhookSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
