import { checkConfig, createDb, migrate, requireDatabaseUrl } from "@aerowise/db";
import { buildApp } from "./app.ts";
import { storeFromEnv } from "@aerowise/storage";
import { heartbeatFromEnv, providersFromEnv } from "@aerowise/tasks";

// In production, refuse to start without the secrets and providers it needs (names them all).
checkConfig();
const url = requireDatabaseUrl();
await migrate(url, (msg) => console.log(msg));

const db = createDb(url);
const production = process.env.NODE_ENV === "production";
// Cloudflare R2 when R2_* is set; local disk (FILE_STORAGE_DIR) otherwise.
const store = storeFromEnv(process.env);
// Email, Stripe, QuickBooks, Twilio and the geocoder: real with keys; without them, test stand-ins outside
// production (email: the outbox) and off in production. DEMO_MODE=true forces every one to its stand-in.
const providers = providersFromEnv({ db, store, env: process.env, production });
if (providers.demo) console.log("demo mode: every outside service is a test stand-in; nothing is sent");
const app = await buildApp({
  db,
  production,
  demo: providers.demo,
  logger: true,
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
  await db.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: "0.0.0.0", port: Number(process.env.API_PORT ?? 4000) });
