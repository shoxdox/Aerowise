import type { Database } from "@aerowise/db";
import type { ObjectStore } from "@aerowise/storage";
import { claimNext, markDone, markFailed, type Task } from "./queue.ts";
import { GENERATE_REPORTS, generateReports } from "./report-task.ts";

export * from "./queue.ts";
export { GENERATE_REPORTS, generateReports } from "./report-task.ts";

export interface TaskContext {
  db: Database;
  store: ObjectStore;
  now: () => Date;
}

async function run(ctx: TaskContext, task: Task) {
  const payload = task.payload as Record<string, string>;
  switch (task.kind) {
    case GENERATE_REPORTS:
      await generateReports(ctx.db, ctx.store, task.organizationId!, payload.inspectionId!, ctx.now());
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
