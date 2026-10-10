import { createHash, randomBytes } from "node:crypto";
import { signatureMatches, SmsSendError, UNSUBSCRIBED_CODE, webhookSignature, type SmsProvider, type SmsSendInput } from "./provider.ts";

const TEST_AUTH_TOKEN = "aerowise_test_sms_auth_token";

/**
 * Twilio's magic test numbers, answered the way Twilio answers them, so the failure paths
 * can be tried without a real phone.
 */
export const TEST_NUMBERS = {
  invalid: "+15005550001",
  notMobile: "+15005550009",
  unsubscribed: "+15005550004",
} as const;

/**
 * Stands in for Twilio in development and tests: nothing is sent and nothing costs money.
 * Every other number is delivered at once. Webhooks are signed exactly as Twilio signs
 * them, so replies go through the same verification and handling. Never used in production.
 */
export class TestSmsProvider implements SmsProvider {
  readonly kind = "test";
  /** Every text "sent", newest last. Tests read it. */
  readonly sent: (SmsSendInput & { providerMessageId: string })[] = [];
  private readonly authToken: string;

  /**
   * `secret`: the deployment's signing secret, when it has one. The webhook token is derived
   * from it, so on a hosted demo a reply cannot be forged from a constant in this source.
   * Without one (tests, local development) the constant is used.
   */
  constructor(opts: { secret?: string | null } = {}) {
    this.authToken = opts.secret ? createHash("sha256").update(`sms-webhook:${opts.secret}`).digest("hex") : TEST_AUTH_TOKEN;
  }

  async send(input: SmsSendInput) {
    if (input.to === TEST_NUMBERS.invalid) throw new SmsSendError(`The 'To' number ${input.to} is not a valid phone number.`, "21211", true);
    if (input.to === TEST_NUMBERS.notMobile) throw new SmsSendError(`The 'To' phone number ${input.to} is not capable of receiving SMS.`, "21614", true);
    if (input.to === TEST_NUMBERS.unsubscribed) throw new SmsSendError("Attempt to send to unsubscribed recipient", UNSUBSCRIBED_CODE, true);
    const providerMessageId = `SMtest${randomBytes(13).toString("hex")}`;
    this.sent.push({ ...input, providerMessageId });
    return { providerMessageId, status: "delivered" as const };
  }

  verifyWebhook(url: string, params: Record<string, string>, signature: string) {
    return signatureMatches(this.authToken, url, params, signature);
  }

  /** The signature header Twilio would send with this webhook. */
  sign(url: string, params: Record<string, string>) {
    return webhookSignature(this.authToken, url, params);
  }

  /** A made-up sending number for an organization trying texts out (555 numbers ring nowhere). */
  static fakeNumber() {
    return `+1512555${String(randomBytes(3).readUIntBE(0, 3) % 10_000).padStart(4, "0")}`;
  }
}
