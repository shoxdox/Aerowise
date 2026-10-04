import type { Database, DB } from "@aerowise/db";
import type { Transaction } from "kysely";
import { enqueue } from "./queue.ts";

export const SYNC_QUICKBOOKS = "quickbooks.sync";

type Executor = Database | Transaction<DB>;

/**
 * Asks for a QuickBooks sync run, if the organization syncs and no run is already waiting
 * (a waiting run will see this change too). Safe to call inside the transaction that made
 * the change.
 */
export async function queueQuickBooksSync(db: Executor, organizationId: string, now: Date) {
  const conn = await db.selectFrom("quickbooksConnections").select(["status", "setupState"]).where("organizationId", "=", organizationId).executeTakeFirst();
  if (conn?.status !== "connected" || conn.setupState !== "active") return;
  const waiting = await db
    .selectFrom("backgroundTasks")
    .select("id")
    .where("kind", "=", SYNC_QUICKBOOKS)
    .where("organizationId", "=", organizationId)
    .where("completedAt", "is", null)
    .where("failedAt", "is", null)
    .where("lockedAt", "is", null)
    .executeTakeFirst();
  if (waiting) return;
  await enqueue(db, { kind: SYNC_QUICKBOOKS, organizationId, payload: { organizationId }, runAt: now, maxAttempts: 1 });
}

/** The worker's regular sweep: one run per synced company per interval. */
export async function scheduleQuickBooksSyncs(db: Database, now: Date, intervalMs: number) {
  const orgs = await db.selectFrom("quickbooksConnections").select("organizationId").where("status", "=", "connected").where("setupState", "=", "active").execute();
  for (const { organizationId } of orgs) {
    await enqueue(db, {
      kind: SYNC_QUICKBOOKS,
      organizationId,
      payload: { organizationId },
      dedupeKey: `qbo-sync:${organizationId}:sweep:${Math.floor(now.getTime() / intervalMs)}`,
      runAt: now,
      maxAttempts: 1,
    });
  }
}
