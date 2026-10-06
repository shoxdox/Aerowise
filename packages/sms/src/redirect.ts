import type { SmsProvider, SmsSendInput } from "./provider.ts";

/** A US or international number in E.164 form, as SMS_REDIRECT_TO must be. */
export const isE164 = (s: string) => /^\+[1-9]\d{7,14}$/.test(s);

/**
 * Staging's texting: every text goes to one test phone (SMS_REDIRECT_TO) instead of the
 * customer, starting with who it was for, so real texts can be tried without reaching anyone.
 */
export class RedirectingSmsProvider implements SmsProvider {
  constructor(
    private readonly inner: SmsProvider,
    readonly redirectTo: string,
  ) {
    if (!isE164(redirectTo)) throw new Error(`SMS_REDIRECT_TO must be one phone number like +15125550123; got ${redirectTo}`);
  }

  get kind() {
    return this.inner.kind;
  }

  send(input: SmsSendInput) {
    return this.inner.send({ ...input, to: this.redirectTo, body: `[Test, for ${input.to}] ${input.body}` });
  }

  verifyWebhook(url: string, params: Record<string, string>, signature: string) {
    return this.inner.verifyWebhook(url, params, signature);
  }
}
