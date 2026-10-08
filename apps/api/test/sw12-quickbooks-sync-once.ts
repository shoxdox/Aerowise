// SW-12 browser rows 9 and 10: one QuickBooks sync of one company, as the worker's task would run
// it, with the same providers the e2e API uses (DEMO_MODE stand-ins, the built-in test company).
// The e2e harness runs no worker, so the specs call this instead of waiting for a schedule. It
// runs nothing else on the task queue. Test databases only.
//
//   DATABASE_URL=<e2e database> tsx test/sw12-quickbooks-sync-once.ts <organization id>
import { createDb } from "@aerowise/db";
import { syncOrganization } from "@aerowise/quickbooks";
import { storeFromEnv } from "@aerowise/storage";
import { providersFromEnv } from "@aerowise/tasks";

const url = process.env.DATABASE_URL ?? "";
const organizationId = process.argv[2];
if (!/_e2e|_test/.test(url) || !organizationId) {
  console.error("usage: DATABASE_URL=<e2e or test database> tsx test/sw12-quickbooks-sync-once.ts <organization id>");
  process.exit(2);
}
const db = createDb(url);
try {
  const providers = providersFromEnv({ db, store: storeFromEnv(process.env), env: process.env, production: false });
  if (!providers.quickbooks) throw new Error("no QuickBooks provider");
  const result = await syncOrganization({ db, now: () => new Date(), ...providers.quickbooks }, organizationId);
  console.log(JSON.stringify(result));
} finally {
  await db.destroy();
}
