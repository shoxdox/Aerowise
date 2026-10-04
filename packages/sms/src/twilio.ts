import { signatureMatches, SmsSendError, type SmsProvider, type SmsSendInput, type SmsSendResult } from "./provider.ts";

type Fetch = typeof fetch;

/** Twilio refusals that no retry can fix: bad or unreachable numbers, opted-out recipients. */
const PERMANENT_CODES = new Set(["21211", "21408", "21610", "21612", "21614", "21617", "21635", "30003", "30004", "30005", "30006", "30007"]);

/** Sends texts through Twilio's Messages API. */
export class TwilioSmsProvider implements SmsProvider {
  readonly kind = "twilio";
  constructor(
    private readonly opts: { accountSid: string; authToken: string; baseUrl?: string },
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const form = new URLSearchParams({ To: input.to, From: input.from, Body: input.body });
    if (input.statusCallback) form.set("StatusCallback", input.statusCallback);
    const base = this.opts.baseUrl ?? "https://api.twilio.com";
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}/2010-04-01/Accounts/${encodeURIComponent(this.opts.accountSid)}/Messages.json`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new SmsSendError(`Could not reach Twilio: ${(err as Error).message}`, "network", false);
    }
    const body = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
    if (!res.ok || !body.sid) {
      const code = body.code ? String(body.code) : `http_${res.status}`;
      // Throttling and Twilio's own errors pass; anything else it refused will be refused again.
      const permanent = PERMANENT_CODES.has(code) || (res.status >= 400 && res.status < 500 && res.status !== 429);
      throw new SmsSendError(body.message ?? `Twilio answered ${res.status}`, code, permanent);
    }
    return { providerMessageId: body.sid, status: "sent" };
  }

  verifyWebhook(url: string, params: Record<string, string>, signature: string) {
    return signatureMatches(this.opts.authToken, url, params, signature);
  }
}
