import { TestSmsProvider } from "./test-provider.ts";
import { TwilioSmsProvider } from "./twilio.ts";
import type { SmsConfig } from "./messaging.ts";

/**
 * Texting as the environment configures it: Twilio when TWILIO_ACCOUNT_SID and
 * TWILIO_AUTH_TOKEN are set, the built-in test provider otherwise (never in production),
 * or off. Twilio calls back at `<PUBLIC_APP_URL>/api/webhooks/sms/...` through the web app.
 */
export function smsFromEnv(env: Record<string, string | undefined>, production: boolean): SmsConfig | null {
  const webhookBaseUrl = env.SMS_WEBHOOK_BASE_URL ?? `${(env.PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api`;
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    return { provider: new TwilioSmsProvider({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN }), webhookBaseUrl };
  }
  if (production) return null;
  return { provider: new TestSmsProvider(), webhookBaseUrl };
}
