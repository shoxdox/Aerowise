import { createDb, migrate, requireDatabaseUrl } from "@aerowise/db";
import { buildApp } from "./app.ts";
import { LocalDiskStore } from "@aerowise/storage";
import { StripeProvider } from "@aerowise/payments";

const url = requireDatabaseUrl();
await migrate(url, (msg) => console.log(msg));

const db = createDb(url);
// With Stripe keys, payments are real (or Stripe test mode); without them the built-in test
// provider runs outside production, and online payments are off in production.
const stripeKey = process.env.STRIPE_SECRET_KEY;
const payments = stripeKey
  ? new StripeProvider({ secretKey: stripeKey, webhookSecrets: (process.env.STRIPE_WEBHOOK_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean) })
  : undefined;
const app = await buildApp({
  db,
  production: process.env.NODE_ENV === "production",
  logger: true,
  store: new LocalDiskStore(process.env.FILE_STORAGE_DIR ?? ".data/files"),
  fileSigningSecret: process.env.FILE_SIGNING_SECRET,
  payments,
  appUrl: process.env.PUBLIC_APP_URL,
});

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: "0.0.0.0", port: Number(process.env.API_PORT ?? 4000) });
