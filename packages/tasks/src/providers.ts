import { billingFromEnv, TestBillingProvider, type BillingProvider } from "@aerowise/billing";
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

/** Outside services that DEMO_LIVE_SERVICES may switch back to their real (test-mode) accounts. */
export const DEMO_LIVE_SERVICE_NAMES = ["stripe"] as const;
export type DemoLiveService = (typeof DEMO_LIVE_SERVICE_NAMES)[number];

/** A Stripe key that can only move test-mode money. */
export const isStripeTestKey = (key: string | undefined) => /^(sk|rk)_test_/.test((key ?? "").trim());

/**
 * DEMO_LIVE_SERVICES (comma-separated, staging only) lets the named services use their real
 * accounts in demo mode, so they can be tried end to end on staging. Each must be in a mode
 * where nothing real happens: Stripe only with a test-mode key. Anything else refuses to start.
 */
export function demoLiveServicesFromEnv(env: Env): Set<DemoLiveService> {
  const names = (env.DEMO_LIVE_SERVICES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const live = new Set<DemoLiveService>();
  for (const name of names) {
    if (!(DEMO_LIVE_SERVICE_NAMES as readonly string[]).includes(name)) {
      throw new Error(`DEMO_LIVE_SERVICES: unknown service "${name}"; it may list ${DEMO_LIVE_SERVICE_NAMES.join(", ")}`);
    }
    live.add(name as DemoLiveService);
  }
  if (live.has("stripe") && !isStripeTestKey(env.STRIPE_SECRET_KEY)) {
    throw new Error("DEMO_LIVE_SERVICES lists stripe, so STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_)");
  }
  return live;
}

/** Every service outside Aerowise that the API and worker talk to. */
export interface Providers {
  demo: boolean;
  /** In demo mode, the services DEMO_LIVE_SERVICES switched to their real test-mode accounts. */
  demoLive: DemoLiveService[];
  /** Email (filings, invoices, portal links, renewals, invitations): Resend with a key, else the outbox in file storage. */
  mail: EmailTransport;
  /** The mail provider behind `mail`, whose delivery webhooks the API receives; null for the outbox. */
  mailProvider: EmailProvider | null;
  /** Stripe Connect for homeowner payments; null means online payments are off. */
  payments: PaymentProvider | null;
  quickbooks: { provider: QuickBooksProvider; cipher: TokenCipher } | null;
  sms: SmsConfig | null;
  geocoder: Geocoder | null;
  /** Stripe Billing, for what companies pay Aerowise (not homeowner payments); null means months are counted but not invoiced. */
  billing: BillingProvider | null;
}

/**
 * Picks each outside service from the environment. Outside demo mode: the real service when
 * its keys are set; otherwise the test stand-in outside production, and off in production.
 * In demo mode: the test stand-in, unless DEMO_LIVE_SERVICES names the service (test mode only).
 * New outside services belong here, with a stand-in.
 */
export function providersFromEnv(opts: { db: Database; store: ObjectStore; env: Env; production: boolean; now?: () => Date }): Providers {
  const { db, store, env, production, now = () => new Date() } = opts;
  const demo = demoModeFromEnv(env);
  if (demo) {
    const live = demoLiveServicesFromEnv(env);
    return {
      demo,
      demoLive: [...live],
      mail: new OutboxTransport(store, now),
      mailProvider: null,
      payments: live.has("stripe") ? stripeFromEnv(env) : new TestPaymentProvider(),
      quickbooks: { provider: new TestQuickBooksProvider(db, now), cipher: new TokenCipher(env.QUICKBOOKS_TOKEN_KEY || undefined) },
      sms: { provider: new TestSmsProvider(), webhookBaseUrl: smsWebhookBaseUrl(env) },
      geocoder: new TestGeocoder(),
      billing: new TestBillingProvider(),
    };
  }
  const stripeKey = env.STRIPE_SECRET_KEY;
  const email = emailFromEnv(db, store, env, now);
  return {
    demo,
    demoLive: [],
    mail: email.transport,
    mailProvider: email.provider,
    // Without Stripe keys the built-in test provider runs outside production, and online payments are off in production.
    payments: stripeKey
      ? stripeFromEnv(env)
      : production
        ? null
        : new TestPaymentProvider(),
    quickbooks: quickBooksFromEnv(db, env, production, now),
    sms: smsFromEnv(env, production),
    geocoder: geocoderFromEnv(env, production),
    billing: billingFromEnv(env) ?? (production ? null : new TestBillingProvider()),
  };
}

function stripeFromEnv(env: Env) {
  const webhookSecrets = (env.STRIPE_WEBHOOK_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return new StripeProvider({ secretKey: env.STRIPE_SECRET_KEY!.trim(), webhookSecrets });
}

function smsWebhookBaseUrl(env: Env) {
  return env.SMS_WEBHOOK_BASE_URL ?? `${(env.PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api`;
}
