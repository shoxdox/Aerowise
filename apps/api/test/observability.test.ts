import { Writable } from "node:stream";
import { TestReporter } from "@aerowise/observability";
import { SUBMIT_FILING } from "@aerowise/compliance";
import { AlertThrottle, checkQueue, claimNext, enqueue, extendLock, markDone, runNextTask } from "@aerowise/tasks";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { createOrg, createUser, login, PASSWORD, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();
const MIN = 60_000;

describe("error tracking and logs in the API", () => {
  it("reports an unexpected error with the organization and request id, and logs every line of the request with the organization", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({ write: (chunk, _e, done) => (lines.push(JSON.parse(String(chunk))), done()) });
    const reporter = new TestReporter();
    const app = await buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store, reporter, logger: { level: "info", stream } });
    app.get("/boom", { config: { permission: "self:read" } }, async () => {
      throw new Error("database exploded");
    });
    const org = await createOrg(ctx.db, "Org A");
    const user = await createUser(ctx.db, org.id, "owner");
    const cookie = await login(app, user.email, PASSWORD);

    const res = await app.inject({ method: "GET", url: "/boom", headers: { cookie } });
    expect(res.statusCode).toBe(500);
    const requestId = res.json().requestId;
    expect(reporter.reports).toEqual([
      { kind: "exception", message: "database exploded", level: "error", ctx: { organizationId: org.id, requestId, tags: { route: "GET /boom" } } },
    ]);
    const forRequest = lines.filter((l) => l.reqId === requestId);
    expect(forRequest.map((l) => l.msg)).toEqual(["incoming request", "unhandled error", "request completed"]);
    // Known once signed in: the error and the completion line carry the tenant.
    expect(forRequest.slice(1).every((l) => l.organizationId === org.id && l.userId === user.id)).toBe(true);

    // Expected failures (validation, 404, 401) are not reported.
    await app.inject({ method: "GET", url: "/customers" });
    await app.inject({ method: "GET", url: "/customers/not-a-uuid", headers: { cookie } });
    expect(reporter.reports).toHaveLength(1);
    await app.close();
  });
});

describe("queue alerts", () => {
  it("says the queue is stalled when due work waits past the limit, and answers the uptime check with 503", async () => {
    expect((await checkQueue(ctx.db, ctx.now)).ok).toBe(true);
    expect((await ctx.app.inject({ method: "GET", url: "/health/queue" })).json()).toEqual({ ok: true, waiting: 0, oldestWaitSeconds: 0, failingFilingTasks: 0 });

    await enqueue(ctx.db, { kind: "reports.generate", organizationId: null, payload: {}, runAt: new Date(ctx.now.getTime() - 10 * MIN) });
    expect((await checkQueue(ctx.db, ctx.now)).ok).toBe(true); // Not yet: 10 minutes is within the limit.
    await enqueue(ctx.db, { kind: "reports.generate", organizationId: null, payload: {}, runAt: new Date(ctx.now.getTime() - 40 * MIN) });
    const q = await checkQueue(ctx.db, ctx.now);
    expect(q).toMatchObject({ ok: false, waiting: 1, oldestWaitSeconds: 2400 });
    expect(q.alerts).toEqual([expect.objectContaining({ kind: "queue_stalled", message: "Worker queue stalled: 1 task due and not running, the oldest for 40 minutes" })]);
    const res = await ctx.app.inject({ method: "GET", url: "/health/queue" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, waiting: 1, oldestWaitSeconds: 2400, failingFilingTasks: 0 });

    // A task a live worker holds is not stalled.
    await ctx.db.updateTable("backgroundTasks").set({ lockedAt: ctx.now, lockedBy: "w1" }).execute();
    expect((await checkQueue(ctx.db, ctx.now)).ok).toBe(true);
  });

  it("raises an alert, with the organization, when a filing task fails repeatedly, and a failure is reported with it", async () => {
    const org = await createOrg(ctx.db, "Org A");
    // A filing task with a broken payload fails every time.
    await enqueue(ctx.db, { kind: SUBMIT_FILING, organizationId: org.id, payload: { filingId: "not-a-uuid" }, runAt: ctx.now });
    const failures: { kind: string; organizationId: string | null; gaveUp: boolean }[] = [];
    const observer = { failed: (t: { kind: string; organizationId: string | null }, _e: unknown, gaveUp: boolean) => failures.push({ kind: t.kind, organizationId: t.organizationId, gaveUp }) };
    for (let i = 0; i < 3; i++) {
      await ctx.db.updateTable("backgroundTasks").set({ runAt: ctx.now }).execute();
      expect(await runNextTask({ db: ctx.db, store: ctx.store, now: () => ctx.now }, "w1", observer)).toBe(true);
    }
    expect(failures).toEqual(Array(3).fill({ kind: SUBMIT_FILING, organizationId: org.id, gaveUp: false }));

    const q = await checkQueue(ctx.db, ctx.now);
    expect(q.failingFilingTasks).toBe(1);
    const alert = q.alerts.find((a) => a.kind === "filing_task_failing")!;
    expect(alert).toMatchObject({ organizationId: org.id, message: "Filing task filings.submit has failed 3 times, still retrying (of 8)" });

    // Sent once, not on every check; again after the repeat interval while still true.
    const throttle = new AlertThrottle(60 * MIN);
    expect(throttle.due(q.alerts, ctx.now)).toHaveLength(1);
    expect(throttle.due(q.alerts, new Date(ctx.now.getTime() + 5 * MIN))).toHaveLength(0);
    expect(throttle.due(q.alerts, new Date(ctx.now.getTime() + 61 * MIN))).toHaveLength(1);
  });
});

describe("task locks", () => {
  it("are renewed by the worker running the task, so a slow task is not taken by a second worker", async () => {
    await enqueue(ctx.db, { kind: "email.send", organizationId: null, payload: {}, runAt: ctx.now });
    const task = await claimNext(ctx.db, "w1", ctx.now);
    expect(task).not.toBeNull();
    // Eleven minutes on, the lock would have timed out; the heartbeat kept it fresh.
    const later = new Date(ctx.now.getTime() + 11 * 60_000);
    expect(await extendLock(ctx.db, task!.id, "w1", later)).toBe(true);
    expect(await claimNext(ctx.db, "w2", later)).toBeNull();
    // Only the worker holding the lock can renew it, and a finished task is not renewed.
    expect(await extendLock(ctx.db, task!.id, "w2", later)).toBe(false);
    await markDone(ctx.db, task!.id, later);
    expect(await extendLock(ctx.db, task!.id, "w1", later)).toBe(false);
  });
});
