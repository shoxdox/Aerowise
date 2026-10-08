import { sql, type Transaction } from "kysely";
import type { DB } from "@aerowise/db";
import { describe, expect, it } from "vitest";
import { setupTestApp } from "./helpers.ts";
import { setup, type Setup } from "./inspection-helpers.ts";

// A work visit can be changed from two places: the schedule (move, unschedule) and the work
// order (complete, cancel). Both lock the work order before the visit, and the schedule
// routes re-check the visit's status under its lock. These tests hold real competing
// transactions open at the moment that matters, not sequential requests.

const ctx = setupTestApp({ features: ["work_orders"] });

async function scheduledWorkVisit(s: Setup) {
  const type = ((await s.api.get("/work-types")).json().items as { id: string; key: string }[]).find((t) => t.key === "repair")!;
  const wo = (await s.api.post("/work-orders", { siteId: s.site.id, workTypeId: type.id })).json() as { id: string };
  const visit = (await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-05" })).json().visits[0] as { jobId: string };
  return { workOrderId: wo.id, jobId: visit.jobId };
}

/** Resolves once `n` other backends in this database are waiting on a row lock. */
async function lockWaiters(n: number) {
  for (let i = 0; i < 200; i++) {
    const r = await sql<{ n: string }>`select count(*) as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(ctx.db);
    if (Number(r.rows[0]!.n) >= n) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("no request ever waited on the lock");
}

/**
 * Runs `office` as the office closing the order would: work order locked first, then the
 * visit. While the work order lock is held, `request` is started and allowed to reach its
 * lock wait; then the office takes the visit's lock (which a request holding it would turn
 * into a deadlock), finishes and commits.
 */
async function raceWithOffice(ids: { workOrderId: string; jobId: string }, request: () => Promise<{ statusCode: number; body: string }>, office: (trx: Transaction<DB>) => Promise<void>) {
  let pending!: Promise<{ statusCode: number; body: string }>;
  await ctx.db.transaction().execute(async (trx) => {
    await sql`set local lock_timeout = '5s'`.execute(trx);
    await sql`select id from work_orders where id = ${ids.workOrderId} for update`.execute(trx);
    pending = request();
    await lockWaiters(1);
    await sql`select id from jobs where id = ${ids.jobId} for update`.execute(trx);
    await office(trx);
  });
  return pending;
}

const officeCompletes = (ids: { workOrderId: string; jobId: string }) => async (trx: Transaction<DB>) => {
  await sql`update jobs set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Completed by the office' where id = ${ids.jobId}`.execute(trx);
  await sql`update work_orders set status = 'completed', completed_at = now(), completed_without_record_reason = 'Paper ticket' where id = ${ids.workOrderId}`.execute(trx);
};

const state = async (ids: { workOrderId: string; jobId: string }) => ({
  order: (await ctx.db.selectFrom("workOrders").select("status").where("id", "=", ids.workOrderId).executeTakeFirstOrThrow()).status,
  job: await ctx.db.selectFrom("jobs").select(["status", "scheduledDate", "cancelReason"]).where("id", "=", ids.jobId).executeTakeFirstOrThrow(),
  events: (await ctx.db.selectFrom("workOrderEvents").select("eventType").where("workOrderId", "=", ids.workOrderId).orderBy("seq").execute()).map((e) => e.eventType),
});

describe("work visit locking", () => {
  it("a move waits for the office completing the order, then refuses the closed visit instead of deadlocking", async () => {
    const s = await setup(ctx);
    const ids = await scheduledWorkVisit(s);
    const res = await raceWithOffice(ids, () => s.api.patch(`/jobs/${ids.jobId}`, { scheduledDate: "2026-03-09" }), officeCompletes(ids));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toMatch(/cancelled job cannot be moved/);
    expect(await state(ids)).toEqual({
      order: "completed",
      job: { status: "cancelled", scheduledDate: "2026-03-05", cancelReason: "Completed by the office" },
      events: ["created", "visit_scheduled"],
    });
  });

  it("an unschedule waits for the office completing the order, then refuses instead of cancelling twice", async () => {
    const s = await setup(ctx);
    const ids = await scheduledWorkVisit(s);
    const res = await raceWithOffice(ids, () => s.api.post(`/jobs/${ids.jobId}/cancel`, { reason: "Customer called" }), officeCompletes(ids));
    expect(res.statusCode, res.body).toBe(409);
    expect(await state(ids)).toEqual({
      order: "completed",
      job: { status: "cancelled", scheduledDate: "2026-03-05", cancelReason: "Completed by the office" },
      events: ["created", "visit_scheduled"],
    });
  });

  it("a move that wins the race still lands, and the office then sees the moved visit", async () => {
    const s = await setup(ctx);
    const ids = await scheduledWorkVisit(s);
    // The office only reads, so the move proceeds once the order is released.
    const res = await raceWithOffice(ids, () => s.api.patch(`/jobs/${ids.jobId}`, { scheduledDate: "2026-03-09" }), async () => {});
    expect(res.statusCode, res.body).toBe(200);
    expect(await state(ids)).toMatchObject({ order: "scheduled", job: { status: "scheduled", scheduledDate: "2026-03-09" }, events: ["created", "visit_scheduled", "visit_moved"] });
  });

  it("re-checks an inspection visit's status under its lock, as before for its kind", async () => {
    const s = await setup(ctx);
    let pending!: Promise<{ statusCode: number; body: string }>;
    await ctx.db.transaction().execute(async (trx) => {
      await sql`select id from jobs where id = ${s.job.jobId} for update`.execute(trx);
      await sql`update jobs set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Other dispatcher' where id = ${s.job.jobId}`.execute(trx);
      pending = s.api.patch(`/jobs/${s.job.jobId}`, { scheduledDate: "2026-03-09" });
      await lockWaiters(1);
    });
    const res = await pending;
    expect(res.statusCode, res.body).toBe(409);
    expect(await ctx.db.selectFrom("jobs").select(["status", "cancelReason"]).where("id", "=", s.job.jobId).executeTakeFirstOrThrow()).toEqual({ status: "cancelled", cancelReason: "Other dispatcher" });
  });

  it("real requests racing a move, an unschedule and the office completing never fail with a server error", async () => {
    const s = await setup(ctx);
    for (let round = 0; round < 8; round++) {
      const ids = await scheduledWorkVisit(s);
      const results = await Promise.all([
        s.api.patch(`/jobs/${ids.jobId}`, { scheduledDate: "2026-03-09" }),
        s.api.post(`/work-orders/${ids.workOrderId}/complete`, { reason: "Paper ticket" }),
        s.api.post(`/jobs/${ids.jobId}/cancel`, { reason: "Customer called" }),
      ]);
      for (const r of results) expect(r.statusCode, r.body).toBeLessThan(500);
      const after = await state(ids);
      // The order always ends completed, with its only visit ended.
      expect(after.order).toBe("completed");
      expect(after.job.status).toBe("cancelled");
      expect(after.events.at(-1)).toBe("completed");
    }
  });
});
