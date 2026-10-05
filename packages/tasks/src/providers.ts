import { emailFromEnv, OutboxTransport, type EmailProvider, type EmailTransport } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import { StripeProvider, TestPaymentProvider, type PaymentProvider } from "@aerowise/payments";
import { quickBooksFromEnv, TestQuickBooksProvider, TokenCipher, type QuickBooksProvider } from "@aerowise/quickbooks";
import { geocoderFromEnv, TestGeocoder, type Geocoder } from "@aerowise/routing";
import { smsFromEnv, TestSmsProvider, type SmsConfig } from "@aerowise/sms";
import type { ObjectStore } from "@aerowise/storage";

type Env = Record<string, string | undefined>;

/**
 * DEMO_MODE=true is for the hosted demo (staging): every outside service uses its test
 * stand-in whatever keys are set, so nothing leaves the system. It works with
 * NODE_ENV=production, which keeps production's cookies and secret checks.
 */
export function demoModeFromEnv(env: Env): boolean {
  const value = (env.DEMO_MODE ?? "").trim().toLowerCase();
  if (value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`DEMO_MODE must be true or false; got ${env.DEMO_MODE}`);
}

/** Every service outside Aerowise that the API and worker talk to. */
export interface Providers {
  demo: boolean;
  /** Email (filings, invoices, portal links, renewals, invitations): Resend with a key, else the outbox in file storage. */
  mail: EmailTransport;
  /** The mail provider behind `mail`, whose delivery webhooks the API receives; null for the outbox. */
  mailProvider: EmailProvider | null;
  /** Stripe Connect for homeowner payments; null means online payments are off. */
  payments: PaymentProvider | null;
  quickbooks: { provider: QuickBooksProvider; cipher: TokenCipher } | null;
  sms: SmsConfig | null;
  geocoder: Geocoder | null;
}

/**
 * Picks each outside service from the environment. Outside demo mode: the real service when
 * its keys are set; otherwise the test stand-in outside production, and off in production.
 * In demo mode: the test stand-in, always. New outside services belong here, with a stand-in.
 */
export function providersFromEnv(opts: { db: Database; store: ObjectStore; env: Env; production: boolean; now?: () => Date }): Providers {
  const { db, store, env, production, now = () => new Date() } = opts;
  const demo = demoModeFromEnv(env);
  if (demo) {
    return {
      demo,
      mail: new OutboxTransport(store, now),
      mailProvider: null,
      payments: new TestPaymentProvider(),
      quickbooks: { provider: new TestQuickBooksProvider(db, now), cipher: new TokenCipher(env.QUICKBOOKS_TOKEN_KEY || undefined) },
      sms: { provider: new TestSmsProvider(), webhookBaseUrl: smsWebhookBaseUrl(env) },
      geocoder: new TestGeocoder(),
    };
  }
  const stripeKey = env.STRIPE_SECRET_KEY;
  const email = emailFromEnv(db, store, env, now);
  return {
    demo,
    mail: email.transport,
    mailProvider: email.provider,
    // Without Stripe keys the built-in test provider runs outside production, and online payments are off in production.
    payments: stripeKey
      ? new StripeProvider({ secretKey: stripeKey, webhookSecrets: (env.STRIPE_WEBHOOK_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean) })
      : production
        ? null
        : new TestPaymentProvider(),
    quickbooks: quickBooksFromEnv(db, env, production, now),
    sms: smsFromEnv(env, production),
    geocoder: geocoderFromEnv(env, production),
  };
}

function smsWebhookBaseUrl(env: Env) {
  return env.SMS_WEBHOOK_BASE_URL ?? `${(env.PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api`;
}
