import { hostname } from "node:os";
import { emailFromEnv, syncRulesets } from "@aerowise/compliance";
import { checkConfig, createDb, migrate, requireDatabaseUrl } from "@aerowise/db";
import { storeFromEnv } from "@aerowise/storage";
import { quickBooksFromEnv } from "@aerowise/quickbooks";
import { geocoderFromEnv } from "@aerowise/routing";
import { smsFromEnv } from "@aerowise/sms";
import { createLogger, reporterFromEnv } from "@aerowise/observability";
import { AlertThrottle, checkQueue, heartbeatFromEnv, runNextTask, scheduleContractFilingSweeps, scheduleQuickBooksSyncs, scheduleRenewalSweeps, scheduleSiteLocating, scheduleSmsSweeps, writeHeartbeat } from "@aerowise/tasks";

// Runs background tasks (report PDFs, filing submissions, contract filings, invoices, QuickBooks sync, renewal campaigns, texts, site locations) from the Postgres queue.
// In production, refuse to start without the secrets and providers it needs (names them all).
checkConfig();
// JSON log lines; errors and alerts also go to error tracking (Sentry when SENTRY_DSN is set).
const log = createLogger("worker");
const reporter = reporterFromEnv(process.env, (err) => log.warn({ err }, "could not send an error report"));
const url = requireDatabaseUrl();
await migrate(url, (msg) => log.info(msg));
const db = createDb(url);
// Fictional rules (the example county) are for development and tests only.
await syncRulesets(db, undefined, { includeFictional: process.env.NODE_ENV !== "production" });
// Cloudflare R2 when R2_* is set; local disk (FILE_STORAGE_DIR) otherwise.
const store = storeFromEnv(process.env);
// Emails go through Resend when RESEND_API_KEY is set, and to the outbox in file storage otherwise.
const email = emailFromEnv(db, store, process.env);
log.info({ email: email.transport.name, redirected: !!(process.env.EMAIL_REDIRECT_TO && email.provider), errorTracking: reporter.name }, "providers");
const ctx = {
  db,
  store,
  mail: email.transport,
  now: () => new Date(),
  mailFrom: process.env.FILING_EMAIL_FROM,
  invoiceMailFrom: process.env.INVOICE_EMAIL_FROM,
  appUrl: process.env.PUBLIC_APP_URL,
  quickbooks: quickBooksFromEnv(db, process.env, process.env.NODE_ENV === "production"),
  sms: smsFromEnv(process.env, process.env.NODE_ENV === "production"),
  geocoder: geocoderFromEnv(process.env, process.env.NODE_ENV === "production"),
};
// Every connected QuickBooks company is synced at least this often (and soon after each change).
const quickbooksEveryMs = Number(process.env.QUICKBOOKS_SYNC_INTERVAL_MS ?? 5 * 60_000);
let nextSweep = 0;
// Each organization's renewal campaign (new renewals, emails, reminders, expiry) runs this often.
const renewalsEveryMs = Number(process.env.RENEWAL_SWEEP_INTERVAL_MS ?? 60 * 60_000);
let nextRenewalSweep = 0;
// Payment reminder texts are looked for this often.
const smsEveryMs = Number(process.env.SMS_SWEEP_INTERVAL_MS ?? 60 * 60_000);
let nextSmsSweep = 0;
// Sites not yet on the map are looked for this often (and soon after each change).
const locateEveryMs = Number(process.env.SITE_LOCATE_INTERVAL_MS ?? 15 * 60_000);
let nextLocateSweep = 0;
// Contracts needing a filing with their authority are looked for this often.
const contractFilingsEveryMs = Number(process.env.CONTRACT_FILING_SWEEP_INTERVAL_MS ?? 15 * 60_000);
let nextContractFilingSweep = 0;
// The queue is checked this often for stalled work and filing tasks that keep failing.
const queueCheckEveryMs = Number(process.env.QUEUE_CHECK_INTERVAL_MS ?? 5 * 60_000);
let nextQueueCheck = 0;
const alerts = new AlertThrottle();
const workerId = `${hostname()}:${process.pid}`;
const idleMs = Number(process.env.WORKER_POLL_MS ?? 2000);
// Touched after every pass of the loop; `pnpm --filter @aerowise/worker health` reads it.
const heartbeat = heartbeatFromEnv(process.env);

let stopping = false;
const stop = () => {
  stopping = true;
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

const observer = {
  done: (task: { id: string; kind: string; organizationId: string | null }, ms: number) =>
    log.info({ taskId: task.id, kind: task.kind, organizationId: task.organizationId, ms }, "task done"),
  failed: (task: { id: string; kind: string; organizationId: string | null; attempts: number }, err: unknown, gaveUp: boolean) => {
    log.error({ taskId: task.id, kind: task.kind, organizationId: task.organizationId, attempt: task.attempts, gaveUp, err }, "task failed");
    reporter.captureException(err, { organizationId: task.organizationId, tags: { task_kind: task.kind }, extra: { taskId: task.id, attempt: task.attempts, gaveUp } });
  },
};

log.info({ workerId }, "worker started");
while (!stopping) {
  let worked = false;
  try {
    if (ctx.quickbooks && Date.now() >= nextSweep) {
      nextSweep = Date.now() + quickbooksEveryMs;
      await scheduleQuickBooksSyncs(db, new Date(), quickbooksEveryMs);
    }
    if (Date.now() >= nextRenewalSweep) {
      nextRenewalSweep = Date.now() + renewalsEveryMs;
      await scheduleRenewalSweeps(db, new Date(), renewalsEveryMs);
    }
    if (ctx.sms && Date.now() >= nextSmsSweep) {
      nextSmsSweep = Date.now() + smsEveryMs;
      await scheduleSmsSweeps(db, new Date(), smsEveryMs);
    }
    if (ctx.geocoder && Date.now() >= nextLocateSweep) {
      nextLocateSweep = Date.now() + locateEveryMs;
      await scheduleSiteLocating(db, new Date(), locateEveryMs);
    }
    if (Date.now() >= nextContractFilingSweep) {
      nextContractFilingSweep = Date.now() + contractFilingsEveryMs;
      await scheduleContractFilingSweeps(db, new Date(), contractFilingsEveryMs);
    }
    if (Date.now() >= nextQueueCheck) {
      nextQueueCheck = Date.now() + queueCheckEveryMs;
      const health = await checkQueue(db, new Date());
      for (const a of alerts.due(health.alerts, new Date())) {
        log.error({ alert: a.kind, organizationId: a.organizationId, ...a.details }, a.message);
        reporter.captureMessage(a.message, "error", { organizationId: a.organizationId, tags: { alert: a.kind }, extra: a.details });
      }
    }
    worked = await runNextTask(ctx, workerId, observer);
    // Only a clean pass counts: a worker that keeps failing (say, the database is gone) goes unhealthy.
    await writeHeartbeat(heartbeat.file);
  } catch (err) {
    log.error({ err }, "worker loop error");
    reporter.captureException(err, { tags: { where: "worker_loop" } });
  }
  if (!worked) await new Promise((r) => setTimeout(r, idleMs));
}
await reporter.flush();
await db.destroy();
log.info("worker stopped");
