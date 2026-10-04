import { hostname } from "node:os";
import { syncRulesets } from "@aerowise/compliance";
import { createDb, migrate, requireDatabaseUrl } from "@aerowise/db";
import { LocalDiskStore } from "@aerowise/storage";
import { runNextTask } from "@aerowise/tasks";

// Runs background tasks (report PDFs, filing submissions) from the Postgres queue.
const url = requireDatabaseUrl();
await migrate(url, (msg) => console.log(msg));
const db = createDb(url);
await syncRulesets(db);
// Filing and invoice emails go to the development outbox in file storage; see README for production.
const ctx = {
  db,
  store: new LocalDiskStore(process.env.FILE_STORAGE_DIR ?? ".data/files"),
  now: () => new Date(),
  mailFrom: process.env.FILING_EMAIL_FROM,
  invoiceMailFrom: process.env.INVOICE_EMAIL_FROM,
  appUrl: process.env.PUBLIC_APP_URL,
};
const workerId = `${hostname()}:${process.pid}`;
const idleMs = Number(process.env.WORKER_POLL_MS ?? 2000);

let stopping = false;
const stop = () => {
  stopping = true;
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

console.log(`worker ${workerId} started`);
while (!stopping) {
  let worked = false;
  try {
    worked = await runNextTask(ctx, workerId, console.log);
  } catch (err) {
    console.error("worker loop error", err);
  }
  if (!worked) await new Promise((r) => setTimeout(r, idleMs));
}
await db.destroy();
console.log("worker stopped");
