import type { Database, DB } from "@aerowise/db";
import type { Transaction } from "kysely";
import { enqueue } from "./queue.ts";

type Executor = Database | Transaction<DB>;

/** Counts an organization's active contracts for the month and invoices it (Aerowise billing). */
export const BILLING_RUN = "billing.monthly_run";

/**
 * Queues the monthly billing run for every organization. The run itself only counts once a
 * month and only invoices once, so running it every interval also retries a month whose
 * invoice could not be issued.
 */
export async function scheduleBillingRuns(db: Executor, now: Date, intervalMs: number) {
  const orgs = await db.selectFrom("organizations").select("id").execute();
  for (const { id } of orgs) {
    await enqueue(db, {
      kind: BILLING_RUN,
      organizationId: id,
      payload: { organizationId: id },
      dedupeKey: `billing-run:${id}:${Math.floor(now.getTime() / intervalMs)}`,
      runAt: now,
      maxAttempts: 1,
    });
  }
}
