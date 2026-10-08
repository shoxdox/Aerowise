import { checkConfig, createDb, ensureBuiltInForms, migrate, requireDatabaseUrl } from "@aerowise/db";
import { buildApp } from "./app.ts";
import { subscriptionConfigFromEnv } from "@aerowise/domain";
import { reporterFromEnv } from "@aerowise/observability";
import { storeFromEnv } from "@aerowise/storage";
import { heartbeatFromEnv, providersFromEnv } from "@aerowise/tasks";

// In production, refuse to start without the secrets and providers it needs (names them all).
checkConfig();
const url = requireDatabaseUrl();
await migrate(url, (msg) => console.log(msg));

const db = createDb(url);
// The built-in forms (inspection and starter work forms) exist from the first request on.
await ensureBuiltInForms(db);
const production = process.env.NODE_ENV === "production";
// Cloudflare R2 when R2_* is set; local disk (FILE_STORAGE_DIR) otherwise.
const store = storeFromEnv(process.env);
// Email, Stripe, QuickBooks, Twilio and the geocoder: real with keys; without them, test stand-ins outside
// production (email: the outbox) and off in production. DEMO_MODE=true forces every one to its stand-in,
// except those DEMO_LIVE_SERVICES switches to their real test-mode accounts (staging).
const providers = providersFromEnv({ db, store, env: process.env, production });
if (providers.demo) {
  const live = providers.demoLive.length ? `, except ${providers.demoLive.join(", ")} (real account, test mode)` : "";
  console.log(`demo mode: every outside service is a test stand-in${live}; nothing real is sent or charged`);
}
// Unexpected errors go to Sentry when SENTRY_DSN is set (tagged with the organization).
const reporter = reporterFromEnv(process.env);
const app = await buildApp({
  db,
  production,
  // Sign-ins per minute per address and email (default 10). The e2e suite raises it: it signs the same demo users in from one address.
  loginRateLimit: process.env.LOGIN_RATE_LIMIT ? Number(process.env.LOGIN_RATE_LIMIT) : undefined,
  demo: providers.demo,
  // JSON lines: each request's lines carry its reqId, and organizationId and userId once signed in.
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  reporter,
  trustProxy: trustProxyFrom(process.env.TRUST_PROXY),
  store,
  fileSigningSecret: process.env.FILE_SIGNING_SECRET,
  mail: providers.mail,
  mailProvider: providers.mailProvider,
  payments: providers.payments,
  quickbooks: providers.quickbooks,
  appUrl: process.env.PUBLIC_APP_URL,
  accountMailFrom: process.env.ACCOUNT_EMAIL_FROM || undefined,
  sms: providers.sms,
  geocoder: providers.geocoder,
  subscription: subscriptionConfigFromEnv(process.env),
  demoRequestNotifyTo: (process.env.DEMO_REQUEST_NOTIFY_TO ?? "").split(",").map((a) => a.trim()).filter(Boolean),
  billing: providers.billing,
  // Set where the worker shares this container (Render; see docs/engineering/DEPLOY-RENDER.md).
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
