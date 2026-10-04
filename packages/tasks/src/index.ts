import { OutboxTransport, prepareFiling, SUBMIT_FILING, submitFiling, type ComplianceContext, type EmailTransport } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import type { ObjectStore } from "@aerowise/storage";
import { claimNext, enqueue, markDone, markFailed, type Task } from "./queue.ts";
import { GENERATE_REPORTS, generateReports } from "./report-task.ts";
import { RENDER_INVOICE, renderInvoicePdf, SEND_INVOICE, sendInvoice } from "./invoice-task.ts";

export * from "./queue.ts";
export { GENERATE_REPORTS, generateReports } from "./report-task.ts";
export { billingEmail, payUrlFor, RENDER_INVOICE, renderInvoicePdf, SEND_INVOICE, sendInvoice } from "./invoice-task.ts";

export interface TaskContext {
  db: Database;
  store: ObjectStore;
  now: () => Date;
  /** How filings are emailed. Defaults to the development outbox in file storage. */
  mail?: EmailTransport;
  /** From address on filing emails. */
  mailFrom?: string;
  /** From address on invoice emails; the provider's name is shown with it. */
  invoiceMailFrom?: string;
  /** Where customers open pay links: the web app's public address. */
  appUrl?: string;
}

export const DEFAULT_APP_URL = "http://localhost:3000";

export function complianceContext(ctx: TaskContext): ComplianceContext {
  return { db: ctx.db, store: ctx.store, mail: ctx.mail ?? new OutboxTransport(ctx.store, ctx.now), now: ctx.now, enqueue, from: ctx.mailFrom };
}

async function run(ctx: TaskContext, task: Task) {
  const payload = task.payload as Record<string, string>;
  switch (task.kind) {
    case GENERATE_REPORTS:
      await generateReports(ctx.db, ctx.store, task.organizationId!, payload.inspectionId!, ctx.now());
      // With the authority copy made, the inspection's filing can be checked and sent.
      await prepareFiling(complianceContext(ctx), task.organizationId!, payload.inspectionId!);
      return;
    case RENDER_INVOICE:
      await renderInvoicePdf(ctx.db, ctx.store, task.organizationId!, payload.invoiceId!, ctx.appUrl ?? DEFAULT_APP_URL);
      return;
    case SEND_INVOICE:
      await sendInvoice(
        { db: ctx.db, store: ctx.store, mail: ctx.mail ?? new OutboxTransport(ctx.store, ctx.now), now: ctx.now, appUrl: ctx.appUrl ?? DEFAULT_APP_URL, from: ctx.invoiceMailFrom },
        task.organizationId!,
        payload.invoiceId!,
        Number(payload.sendNo),
      );
      return;
    case SUBMIT_FILING:
      await submitFiling(complianceContext(ctx), task.organizationId!, payload.filingId!);
      return;
    default:
      throw new Error(`unknown task kind ${task.kind}`);
  }
}

/**
 * Claims and runs one due task. Returns false when nothing was due. Errors are recorded
 * on the task and retried later; they never escape.
 */
export async function runNextTask(ctx: TaskContext, workerId: string, log: (msg: string) => void = () => {}): Promise<boolean> {
  const task = await claimNext(ctx.db, workerId, ctx.now());
  if (!task) return false;
  try {
    await run(ctx, task);
    await markDone(ctx.db, task.id, ctx.now());
    log(`${task.kind} ${task.id} done`);
  } catch (err) {
    const gaveUp = await markFailed(ctx.db, task, (err as Error).stack ?? String(err), ctx.now());
    log(`${task.kind} ${task.id} failed (attempt ${task.attempts}${gaveUp ? ", giving up" : ""}): ${(err as Error).message}`);
  }
  return true;
}

/** Runs every task that is due now. Tests use this in place of a running worker. */
export async function drainTasks(ctx: TaskContext, workerId = "inline") {
  let n = 0;
  while (await runNextTask(ctx, workerId)) n++;
  return n;
}
