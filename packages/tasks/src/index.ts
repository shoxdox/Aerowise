import { OutboxTransport, prepareFiling, SUBMIT_FILING, submitFiling, type ComplianceContext, type EmailTransport } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import type { ObjectStore } from "@aerowise/storage";
import { claimNext, enqueue, markDone, markFailed, type Task } from "./queue.ts";
import { GENERATE_REPORTS, generateReports } from "./report-task.ts";
import { RENDER_INVOICE, renderInvoicePdf, SEND_INVOICE, sendInvoice } from "./invoice-task.ts";
import { syncOrganization, type QuickBooksProvider, type TokenCipher } from "@aerowise/quickbooks";
import { queueQuickBooksSync, SYNC_QUICKBOOKS } from "./quickbooks-task.ts";
import { PORTAL_LINK_EMAIL, sendPortalLink, type PortalLinkEmail } from "./portal-task.ts";
import { PASSWORD_RESET_EMAIL, sendPasswordReset } from "./account-task.ts";
import type { SmsConfig, SmsRequest } from "@aerowise/sms";
import { runSmsSweep, SEND_SMS, sendSms, SMS_SWEEP } from "./sms-task.ts";
import type { Geocoder } from "@aerowise/routing";
import { LOCATE_SITES, locateSites } from "./routing-task.ts";
import { RENEWAL_AGREEMENT, RENEWAL_EMAIL, RENEWAL_SWEEP, renderSignedAgreement, runRenewalSweep, sendRenewalEmail } from "./renewal-task.ts";
import { runMonthlyBilling, type BillingProvider } from "@aerowise/billing";
import { DEFAULT_SUBSCRIPTION_CONFIG, type SubscriptionConfig } from "@aerowise/domain";
import { BILLING_RUN } from "./billing-task.ts";
import { CONTRACT_FILINGS, prepareContractFilingsFor, runContractFilings, SEND_CUSTOMER_REPORT, sendCustomerReport } from "./filing-task.ts";

export * from "./queue.ts";
export * from "./heartbeat.ts";
export * from "./monitor.ts";
export * from "./providers.ts";
export { GENERATE_REPORTS, generateReports } from "./report-task.ts";
export { queueQuickBooksSync, scheduleQuickBooksSyncs, SYNC_QUICKBOOKS } from "./quickbooks-task.ts";
export {
  queueRenewalEmail,
  RENEWAL_AGREEMENT,
  RENEWAL_EMAIL,
  RENEWAL_SWEEP,
  renderSignedAgreement,
  renewUrlFor,
  runRenewalSweep,
  scheduleRenewalSweeps,
  sendRenewalEmail,
  type SweepResult,
} from "./renewal-task.ts";
export { hashResetToken, PASSWORD_RESET_EMAIL, resetUrlFor, sendPasswordReset } from "./account-task.ts";
export { createPortalLink, hashPortalToken, PORTAL_LINK_EMAIL, portalUrlFor, sendPortalLink, type PortalLinkEmail } from "./portal-task.ts";
export { queueSms, runSmsSweep, scheduleSmsSweeps, SEND_SMS, sendSms, SMS_SWEEP } from "./sms-task.ts";
export { LOCATE_SITES, locateSites, queueSiteLocating, scheduleSiteLocating } from "./routing-task.ts";
export { cancelOpenVisits, serviceEndForVisit } from "./contract-end.ts";
export { CONTRACT_FILINGS, prepareContractFilingsFor, runContractFilings, scheduleContractFilingSweeps, SEND_CUSTOMER_REPORT, sendCustomerReport } from "./filing-task.ts";
export { BILLING_RUN, scheduleBillingRuns } from "./billing-task.ts";
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
  /** From address on account emails (password resets). */
  accountMailFrom?: string;
  /** Where customers open pay links: the web app's public address. */
  appUrl?: string;
  /** QuickBooks Online; without it, sync tasks do nothing. */
  quickbooks?: { provider: QuickBooksProvider; cipher: TokenCipher } | null;
  /** Text messages; without it, queued texts are dropped. */
  sms?: SmsConfig | null;
  /** Finds sites on the map; without it, sites wait unlocated. */
  geocoder?: Geocoder | null;
  /** What companies pay Aerowise: Stripe Billing (or its stand-in) and the prices. Without a provider, months are counted but not invoiced. */
  billing?: { provider: BillingProvider | null; config: SubscriptionConfig } | null;
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
    case SYNC_QUICKBOOKS: {
      if (!ctx.quickbooks) return;
      const r = await syncOrganization({ db: ctx.db, now: ctx.now, ...ctx.quickbooks }, payload.organizationId!);
      // A big backlog goes in several runs, one after another.
      if (r.more) await queueQuickBooksSync(ctx.db, payload.organizationId!, ctx.now());
      return;
    }
    case RENEWAL_EMAIL:
      await sendRenewalEmail(
        { db: ctx.db, mail: ctx.mail ?? new OutboxTransport(ctx.store, ctx.now), appUrl: ctx.appUrl ?? DEFAULT_APP_URL, from: ctx.invoiceMailFrom },
        task.organizationId!,
        payload.renewalId!,
        Number(payload.sendNo),
        (task.payload as { reminder?: boolean }).reminder === true,
      );
      return;
    case RENEWAL_AGREEMENT:
      await renderSignedAgreement({ db: ctx.db, store: ctx.store, mail: ctx.mail ?? new OutboxTransport(ctx.store, ctx.now), from: ctx.invoiceMailFrom }, task.organizationId!, payload.documentId!);
      // A contract filing may be waiting for this signed PDF.
      await prepareContractFilingsFor(complianceContext(ctx), task.organizationId!, payload.documentId!);
      return;
    case CONTRACT_FILINGS:
      await runContractFilings(complianceContext(ctx), payload.organizationId!);
      return;
    case SEND_CUSTOMER_REPORT:
      await sendCustomerReport(
        { db: ctx.db, store: ctx.store, mail: ctx.mail ?? new OutboxTransport(ctx.store, ctx.now), now: ctx.now, from: ctx.invoiceMailFrom },
        task.organizationId!,
        task.payload as unknown as { reportId: string; to: string; requestKey: string; requestedBy: string | null },
      );
      return;
    case RENEWAL_SWEEP:
      await runRenewalSweep(ctx.db, payload.organizationId!, ctx.now());
      return;
    case PORTAL_LINK_EMAIL:
      await sendPortalLink(
        { db: ctx.db, mail: ctx.mail ?? new OutboxTransport(ctx.store, ctx.now), appUrl: ctx.appUrl ?? DEFAULT_APP_URL, now: ctx.now, from: ctx.invoiceMailFrom },
        task.organizationId!,
        task.id,
        task.payload as unknown as PortalLinkEmail,
      );
      return;
    case PASSWORD_RESET_EMAIL:
      await sendPasswordReset(
        { db: ctx.db, mail: ctx.mail ?? new OutboxTransport(ctx.store, ctx.now), appUrl: ctx.appUrl ?? DEFAULT_APP_URL, now: ctx.now, from: ctx.accountMailFrom },
        task.organizationId!,
        task.id,
        task.payload as { userId: string },
      );
      return;
    case SEND_SMS:
      // Texting was configured when this was queued and is not now.
      if (!ctx.sms) return;
      await sendSms({ db: ctx.db, sms: ctx.sms, now: ctx.now, appUrl: ctx.appUrl ?? DEFAULT_APP_URL }, task.organizationId!, task.payload as unknown as SmsRequest);
      return;
    case SMS_SWEEP:
      await runSmsSweep(ctx.db, payload.organizationId!, ctx.now());
      return;
    case LOCATE_SITES:
      if (!ctx.geocoder) return;
      await locateSites(ctx.db, ctx.geocoder, payload.organizationId!, ctx.now());
      return;
    case SUBMIT_FILING:
      await submitFiling(complianceContext(ctx), task.organizationId!, payload.filingId!);
      return;
    case BILLING_RUN:
      await runMonthlyBilling(
        ctx.db,
        { provider: ctx.billing?.provider ?? null, config: ctx.billing?.config ?? DEFAULT_SUBSCRIPTION_CONFIG, now: ctx.now() },
        payload.organizationId!,
      );
      return;
    default:
      throw new Error(`unknown task kind ${task.kind}`);
  }
}

/** What the worker hears about each task it runs: for logs, error reports and alerts. */
export interface TaskObserver {
  done?(task: Task, ms: number): void;
  failed?(task: Task, err: unknown, gaveUp: boolean): void;
}

/**
 * Claims and runs one due task. Returns false when nothing was due. Errors are recorded
 * on the task and retried later; they never escape.
 */
export async function runNextTask(ctx: TaskContext, workerId: string, observer: TaskObserver = {}): Promise<boolean> {
  const task = await claimNext(ctx.db, workerId, ctx.now());
  if (!task) return false;
  const started = Date.now();
  try {
    await run(ctx, task);
    await markDone(ctx.db, task.id, ctx.now());
    observer.done?.(task, Date.now() - started);
  } catch (err) {
    const gaveUp = await markFailed(ctx.db, task, (err as Error).stack ?? String(err), ctx.now());
    observer.failed?.(task, err, gaveUp);
  }
  return true;
}

/** Runs every task that is due now. Tests use this in place of a running worker. */
export async function drainTasks(ctx: TaskContext, workerId = "inline") {
  let n = 0;
  while (await runNextTask(ctx, workerId)) n++;
  return n;
}
