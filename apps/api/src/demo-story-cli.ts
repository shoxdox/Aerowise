import { createDb, requireDatabaseUrl } from "@aerowise/db";
import { storeFromEnv } from "@aerowise/storage";
import { playDemoStory } from "./demo-story.ts";

// `pnpm db:seed` and `pnpm db:reseed-demo` run this after the seed: the demo's inspections,
// filings, renewal and invoices (see demo-story.ts). Like the seed, never on a real
// production database.
if (process.env.NODE_ENV === "production" && process.env.DEMO_MODE !== "true") {
  console.error("refusing to play the demo story: NODE_ENV is production and DEMO_MODE is not true");
  process.exit(1);
}
const db = createDb(requireDatabaseUrl());
try {
  await playDemoStory({ db, store: storeFromEnv(process.env), log: console.log });
} finally {
  await db.destroy();
}
