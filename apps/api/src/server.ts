import { emailFromEnv } from "@aerowise/compliance";
import { checkConfig, createDb, migrate, requireDatabaseUrl } from "@aerowise/db";
import { buildApp } from "./app.ts";
import { subscriptionConfigFromEnv } from "./lib/subscription.ts";
import { reporterFromEnv } from "@aerowise/observability";
import { storeFromEnv } from "@aerowise/storage";
import { StripeProvider } from "@aerowise/payments";
import { quickBooksFromEnv } from "@aerowise/quickbooks";
import { geocoderFromEnv } from "@aerowise/routing";
import { smsFromEnv } from "@aerowise/sms";
import { heartbeatFromEnv } from "@aerowise/tasks";

// In production, refuse to start without the secrets and providers it needs (names them all).
checkConfig();
const url = requireDatabaseUrl();
await migrate(url, (msg) => console.log(msg));

const db = createDb(url);
// With Stripe keys, payments are real (or Stripe test mode); without them the built-in test
// provider runs outside production, and online payments are off in production.
const stripeKey = process.env.STRIPE_SECRET_KEY;
const payments = stripeKey
  ? new StripeProvider({ secretKey: stripeKey, webhookSecrets: (process.env.STRIPE_WEBHOOK_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean) })
  : undefined;
const production = process.env.NODE_ENV === "production";
// Cloudflare R2 when R2_* is set; local disk (FILE_STORAGE_DIR) otherwise.
const store = storeFromEnv(process.env);
// With a Resend key, email is really sent; without one it goes to the outbox in file storage.
const email = emailFromEnv(db, store, process.env);
// Unexpected errors go to Sentry when SENTRY_DSN is set (tagged with the organization).
const reporter = reporterFromEnv(process.env);
const app = await buildApp({
  db,
  production,
  // JSON lines: each request's lines carry its reqId, and organizationId and userId once signed in.
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  reporter,
  trustProxy: trustProxyFrom(process.env.TRUST_PROXY),
  store,
  mail: email.transport,
  mailProvider: email.provider,
  fileSigningSecret: process.env.FILE_SIGNING_SECRET,
  payments,
  // Intuit keys connect real QuickBooks companies; without them, a test company outside production.
  quickbooks: quickBooksFromEnv(db, process.env, production),
  appUrl: process.env.PUBLIC_APP_URL,
  accountMailFrom: process.env.ACCOUNT_EMAIL_FROM || undefined,
  // Twilio keys send real texts; without them, a test provider outside production.
  sms: smsFromEnv(process.env, production),
  geocoder: geocoderFromEnv(process.env, production),
  subscription: subscriptionConfigFromEnv(process.env),
  demoRequestNotifyTo: (process.env.DEMO_REQUEST_NOTIFY_TO ?? "").split(",").map((a) => a.trim()).filter(Boolean),
  // Set where the worker shares this machine (see docs/engineering/DEPLOY.md).
  workerHeartbeat: process.env.HEALTH_INCLUDES_WORKER === "true" ? heartbeatFromEnv(process.env) : undefined,
});

/** TRUST_PROXY: "true", or the proxies' comma-separated addresses or ranges; unset means none. */
function trustProxyFrom(v: string | undefined): boolean | string {
  if (!v) return false;
  return v === "true" ? true : v;
}

const shutdown = async () => {
  await app.close();
  await reporter.flush();
  await db.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: "0.0.0.0", port: Number(process.env.API_PORT ?? 4000) });
