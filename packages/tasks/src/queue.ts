import type { Database, DB } from "@aerowise/db";
import { sql, type Transaction } from "kysely";

type Executor = Database | Transaction<DB>;

export interface Task {
  id: string;
  organizationId: string | null;
  kind: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/**
 * Queues a task. Call it inside the transaction that makes the task necessary, so the
 * task exists exactly when the change does. A repeated `dedupeKey` is ignored.
 */
export async function enqueue(
  db: Executor,
  task: { kind: string; organizationId: string | null; payload: Record<string, unknown>; dedupeKey?: string; runAt?: Date; maxAttempts?: number },
) {
  await db
    .insertInto("backgroundTasks")
    .values({
      kind: task.kind,
      organizationId: task.organizationId,
      payload: JSON.stringify(task.payload),
      dedupeKey: task.dedupeKey ?? null,
      runAt: task.runAt ?? new Date(),
      ...(task.maxAttempts ? { maxAttempts: task.maxAttempts } : {}),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      completedAt: null,
      failedAt: null,
    })
    .onConflict((oc) => oc.column("dedupeKey").doNothing())
    .execute();
}

/** A task locked longer than this is assumed to belong to a crashed worker and is retried. */
const LOCK_TIMEOUT = "10 minutes";

/** Claims the next due task, or returns null. Safe to call from several workers at once. */
export async function claimNext(db: Database, workerId: string, now: Date = new Date()): Promise<Task | null> {
  const row = await sql<Task>`
    update background_tasks set locked_at = ${now}, locked_by = ${workerId}, attempts = attempts + 1
    where id = (
      select id from background_tasks
      where completed_at is null and failed_at is null and run_at <= ${now}
        and (locked_at is null or locked_at < ${now}::timestamptz - ${LOCK_TIMEOUT}::interval)
      order by run_at
      for update skip locked
      limit 1
    )
    returning id, organization_id as "organizationId", kind, payload, attempts, max_attempts as "maxAttempts"`.execute(db);
  return row.rows[0] ?? null;
}

export async function markDone(db: Database, taskId: string, now: Date = new Date()) {
  await db.updateTable("backgroundTasks").set({ completedAt: now, lockedAt: null, lockedBy: null, lastError: null }).where("id", "=", taskId).execute();
}

/** Schedules a retry with exponential backoff, or gives up after the last attempt. */
export async function markFailed(db: Database, task: Task, error: string, now: Date = new Date()) {
  const giveUp = task.attempts >= task.maxAttempts;
  const delaySeconds = Math.min(3600, 15 * 2 ** (task.attempts - 1));
  await db
    .updateTable("backgroundTasks")
    .set({
      lockedAt: null,
      lockedBy: null,
      lastError: error.slice(0, 2000),
      ...(giveUp ? { failedAt: now } : { runAt: new Date(now.getTime() + delaySeconds * 1000) }),
    })
    .where("id", "=", task.id)
    .execute();
  return giveUp;
}
