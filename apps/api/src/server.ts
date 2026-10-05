import { createDb, migrate, requireDatabaseUrl } from "@aerowise/db";
import { buildApp } from "./app.ts";
import { LocalDiskStore } from "@aerowise/storage";
import { heartbeatFromEnv, providersFromEnv } from "@aerowise/tasks";

const url = requireDatabaseUrl();
await migrate(url, (msg) => console.log(msg));

const db = createDb(url);
const production = process.env.NODE_ENV === "production";
const store = new LocalDiskStore(process.env.FILE_STORAGE_DIR ?? ".data/files");
// Stripe, QuickBooks, Twilio and the geocoder: real with keys, test stand-ins without them outside
// production, off in production. DEMO_MODE=true forces every one to its stand-in.
const providers = providersFromEnv({ db, store, env: process.env, production });
if (providers.demo) console.log("demo mode: every outside service is a test stand-in; nothing is sent");
const app = await buildApp({
  db,
  production,
  demo: providers.demo,
  logger: true,
  store,
  fileSigningSecret: process.env.FILE_SIGNING_SECRET,
  mail: providers.mail,
  payments: providers.payments,
  quickbooks: providers.quickbooks,
  appUrl: process.env.PUBLIC_APP_URL,
  sms: providers.sms,
  geocoder: providers.geocoder,
  // Set where the worker shares this machine (see docs/engineering/DEPLOY.md).
  workerHeartbeat: process.env.HEALTH_INCLUDES_WORKER === "true" ? heartbeatFromEnv(process.env) : undefined,
});

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: "0.0.0.0", port: Number(process.env.API_PORT ?? 4000) });
