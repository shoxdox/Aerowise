// SW-12 browser rows 9, 10 and 16: one piece of the worker's work, run on demand, because the e2e
// harness runs no worker. It runs only the named step, never the rest of the task queue, with the
// same providers the e2e API uses (DEMO_MODE stand-ins: the test QuickBooks company, the email
// outbox). Test databases only.
//
//   DATABASE_URL=<e2e database> tsx test/sw12-run-once.ts quickbooks <organization id>
//       one QuickBooks sync of the company, as the sync task runs it
//   DATABASE_URL=<e2e database> tsx test/sw12-run-once.ts prepare-filing <organization id> <inspection id>
//       the inspection's reports, then its filing checked and made ready, as the report task does;
//       sending stays a queued task that this does not run
import { OutboxTransport, prepareFiling } from "@aerowise/compliance";
import { createDb } from "@aerowise/db";
import { syncOrganization } from "@aerowise/quickbooks";
import { storeFromEnv } from "@aerowise/storage";
import { enqueue, generateReports, providersFromEnv } from "@aerowise/tasks";

const url = process.env.DATABASE_URL ?? "";
const [step, organizationId, inspectionId] = process.argv.slice(2);
if (!/_e2e|_test/.test(url) || !organizationId || !["quickbooks", "prepare-filing"].includes(step ?? "") || (step === "prepare-filing" && !inspectionId)) {
  console.error("usage: DATABASE_URL=<e2e or test database> tsx test/sw12-run-once.ts quickbooks <org> | prepare-filing <org> <inspection>");
  process.exit(2);
}
const db = createDb(url);
const store = storeFromEnv(process.env);
const now = () => new Date();
try {
  if (step === "quickbooks") {
    const providers = providersFromEnv({ db, store, env: process.env, production: false });
    if (!providers.quickbooks) throw new Error("no QuickBooks provider");
    console.log(JSON.stringify(await syncOrganization({ db, now, ...providers.quickbooks }, organizationId)));
  } else {
    await generateReports(db, store, organizationId, inspectionId!, now());
    // What it queues (sending an email filing) goes on the real queue and waits there: nothing
    // here runs it, as a filing waits until the worker's next pass.
    await prepareFiling({ db, store, mail: new OutboxTransport(store, now), now, enqueue }, organizationId, inspectionId!);
    console.log(JSON.stringify({ prepared: inspectionId }));
  }
} finally {
  await db.destroy();
}
