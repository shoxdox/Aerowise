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
//   DATABASE_URL=<e2e database> tsx test/sw12-run-once.ts submit-filing-failing <organization id> <filing id>
//       the queued email send, run once with a mail provider that is down: the filing fails as it
//       would in an outage (a forced failure for the CSV fallback path; nothing is sent)
import { OutboxTransport, prepareFiling, submitFiling, type EmailTransport } from "@aerowise/compliance";
import { createDb } from "@aerowise/db";
import { syncOrganization } from "@aerowise/quickbooks";
import { storeFromEnv } from "@aerowise/storage";
import { enqueue, generateReports, providersFromEnv } from "@aerowise/tasks";

const url = process.env.DATABASE_URL ?? "";
const [step, organizationId, recordId] = process.argv.slice(2);
/** The database's own name from the URL (never the user, password or host), as test/db-url.ts reads it. */
function databaseName(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
    const name = decodeURIComponent(u.pathname.replace(/^\//, ""));
    return /^[A-Za-z0-9_]+$/.test(name) ? name : null;
  } catch {
    return null;
  }
}
const name = databaseName(url);
if (!name || !/(_e2e|test)/.test(name)) {
  console.error("DATABASE_URL must be a well-formed postgres URL whose database name contains _e2e or test");
  process.exit(2);
}
// Test stand-ins only: demo mode on, and no real service switched back on.
if (process.env.DEMO_MODE !== "true" || (process.env.DEMO_LIVE_SERVICES ?? "").trim() !== "") {
  console.error("run with DEMO_MODE=true and DEMO_LIVE_SERVICES unset, so every outside service is a test stand-in");
  process.exit(2);
}
if (!organizationId || !["quickbooks", "prepare-filing", "submit-filing-failing"].includes(step ?? "") || (step !== "quickbooks" && !recordId)) {
  console.error("usage: DATABASE_URL=<e2e or test database> tsx test/sw12-run-once.ts quickbooks <org> | prepare-filing <org> <inspection> | submit-filing-failing <org> <filing>");
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
  } else if (step === "submit-filing-failing") {
    const down: EmailTransport = {
      name: "sw12-down",
      send: async () => {
        throw new Error("Mail provider unavailable (SW-12 forced failure)");
      },
    };
    // submitFiling records the failure, then rethrows it for the worker's retry bookkeeping.
    const error = await submitFiling({ db, store, mail: down, now, enqueue }, organizationId, recordId!).then(
      () => null,
      (err: Error) => err.message,
    );
    if (error !== "Mail provider unavailable (SW-12 forced failure)") throw new Error(`expected the forced send failure, got ${error}`);
    console.log(JSON.stringify({ failed: recordId }));
  } else {
    await generateReports(db, store, organizationId, recordId!, now());
    // What it queues (sending an email filing) goes on the real queue and waits there: nothing
    // here runs it, as a filing waits until the worker's next pass.
    await prepareFiling({ db, store, mail: new OutboxTransport(store, now), now, enqueue }, organizationId, recordId!);
    console.log(JSON.stringify({ prepared: recordId }));
  }
} finally {
  await db.destroy();
}
