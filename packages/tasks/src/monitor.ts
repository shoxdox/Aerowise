import { SUBMIT_FILING } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import { sql } from "kysely";
import { CONTRACT_FILINGS } from "./filing-task.ts";
import { GENERATE_REPORTS } from "./report-task.ts";

/**
 * Tasks on the way to an authority filing (the report it needs, preparing contract
 * filings, sending); their failures are compliance risks.
 */
export const FILING_TASK_KINDS = [GENERATE_REPORTS, CONTRACT_FILINGS, SUBMIT_FILING];

export interface QueueAlert {
  /** Stable for as long as the cause lasts, so the same alert is not sent over and over. */
  key: string;
  kind: "queue_stalled" | "filing_task_failing";
  message: string;
  organizationId: string | null;
  details: Record<string, unknown>;
}

export interface QueueHealth {
  ok: boolean;
  /** Tasks due but not picked up, and how long the oldest has waited. */
  waiting: number;
  oldestWaitSeconds: number;
  /** Filing tasks that have failed `filingFailures` times or more and are not done. */
  failingFilingTasks: number;
  alerts: QueueAlert[];
}

/**
 * Looks at the task queue for two problems: work that is due but nobody is running (the
 * worker is down or stuck), and filing tasks that keep failing (or gave up). The worker
 * calls this on a timer and reports the alerts; /health/queue answers it for the uptime check.
 */
export async function checkQueue(db: Database, now: Date, opts: { stallAfterMs?: number; filingFailures?: number } = {}): Promise<QueueHealth> {
  const stallAfterMs = opts.stallAfterMs ?? 15 * 60_000;
  const filingFailures = opts.filingFailures ?? 3;
  const stalledBefore = new Date(now.getTime() - stallAfterMs);
  // Due and unclaimed (or claimed by a worker whose lock has run out, see claimNext).
  const waiting = await db
    .selectFrom("backgroundTasks")
    .select([sql<number>`count(*)::int`.as("n"), sql<Date | null>`min(run_at)`.as("oldest")])
    .where("completedAt", "is", null)
    .where("failedAt", "is", null)
    .where("runAt", "<=", stalledBefore)
    .where((eb) => eb.or([eb("lockedAt", "is", null), eb("lockedAt", "<", sql<Date>`${now}::timestamptz - interval '10 minutes'`)]))
    // An ended visitor demo's tasks are never run (claimNext), so they are not a stall.
    .where(sql<boolean>`not exists (select 1 from organizations o where o.id = background_tasks.organization_id and o.demo_expires_at <= ${now})`)
    .executeTakeFirstOrThrow();
  const failing = await db
    .selectFrom("backgroundTasks")
    .select(["id", "kind", "organizationId", "attempts", "maxAttempts", "lastError", "failedAt"])
    .where("kind", "in", FILING_TASK_KINDS)
    .where("completedAt", "is", null)
    .where("attempts", ">=", filingFailures)
    .orderBy("createdAt")
    .limit(50)
    .execute();

  const alerts: QueueAlert[] = [];
  const oldestWaitSeconds = waiting.oldest ? Math.round((now.getTime() - new Date(waiting.oldest).getTime()) / 1000) : 0;
  if (waiting.n > 0) {
    alerts.push({
      key: "queue_stalled",
      kind: "queue_stalled",
      message: `Worker queue stalled: ${waiting.n} task${waiting.n === 1 ? "" : "s"} due and not running, the oldest for ${Math.round(oldestWaitSeconds / 60)} minutes`,
      organizationId: null,
      details: { waiting: waiting.n, oldestWaitSeconds },
    });
  }
  for (const t of failing) {
    const gaveUp = !!t.failedAt;
    alerts.push({
      key: `filing_task_failing:${t.id}:${gaveUp ? "gave_up" : "retrying"}`,
      kind: "filing_task_failing",
      message: `Filing task ${t.kind} has failed ${t.attempts} times${gaveUp ? " and gave up" : `, still retrying (of ${t.maxAttempts})`}`,
      organizationId: t.organizationId,
      details: { taskId: t.id, kind: t.kind, attempts: t.attempts, lastError: (t.lastError ?? "").split("\n")[0]!.slice(0, 300) },
    });
  }
  return { ok: alerts.length === 0, waiting: waiting.n, oldestWaitSeconds, failingFilingTasks: failing.length, alerts };
}

/**
 * Sends each alert once, then again only after `repeatMs` if it is still true. Kept in
 * memory: a restarted worker reports what is still wrong once more, which is fine.
 */
export class AlertThrottle {
  private readonly sent = new Map<string, number>();
  constructor(private readonly repeatMs = 6 * 60 * 60_000) {}

  due(alerts: QueueAlert[], now: Date): QueueAlert[] {
    const live = new Set(alerts.map((a) => a.key));
    for (const key of this.sent.keys()) if (!live.has(key)) this.sent.delete(key);
    return alerts.filter((a) => {
      const last = this.sent.get(a.key);
      if (last !== undefined && now.getTime() - last < this.repeatMs) return false;
      this.sent.set(a.key, now.getTime());
      return true;
    });
  }
}
