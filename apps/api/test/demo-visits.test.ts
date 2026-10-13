import { DEMO_PASSWORD, seedDemoCompany } from "@aerowise/db";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { buildApp, type App } from "../src/app.ts";
import { DEMO_VISIT_HOURS } from "../src/routes/demo-visits.ts";
import { claimNext, checkQueue, runNextTask } from "@aerowise/tasks";
import { setTimeout as pause } from "node:timers/promises";
import { createOrg, createUser, login, setupTestApp } from "./helpers.ts";

// The demo story plays a year of inspections, reports and filings (about 25 seconds); tests that play it need longer than the default.
vi.setConfig({ testTimeout: 180_000 });

// "Try the demo" (W10.2): each visitor gets a demo company of their own, signed in as its
// owner, with no password anyone could share; limits per visitor and overall; gone after a day.
const ctx = setupTestApp();

let demoApp: App | undefined;
async function app(limits = { perHour: 2, maxLive: 3 }) {
  // The seed dates the demo from the real today, so the story plays on the real clock.
  ctx.now = new Date();
  await demoApp?.close();
  demoApp = await buildApp({ db: ctx.db, demo: true, now: () => ctx.now, store: ctx.store, sms: ctx.sms, demoVisitLimits: limits });
  return demoApp;
}

async function start(a: App, ip = "203.0.113.7") {
  const res = await a.inject({ method: "POST", url: "/demo/start", payload: {}, remoteAddress: ip });
  return res;
}

const cookieOf = (res: Awaited<ReturnType<typeof start>>) => {
  const c = res.cookies.find((c) => c.name === "aw_session");
  if (!c) throw new Error("no session cookie");
  return `aw_session=${c.value}`;
};

describe("visitor demos", () => {
  it("finishes the story when the deployed worker has already claimed its first report", async () => {
    const a = await app();
    const put = ctx.store.put.bind(ctx.store);
    let competing: Promise<boolean> | undefined;
    ctx.store.put = async (key, body, contentType) => {
      if (contentType === "application/pdf") await pause(1000);
      // The first photo uploaded while a report is waiting to be made (yesterday's second
      // inspection, after the first one completed): the deployed worker grabs that report.
      const waiting =
        contentType === "image/jpeg" && !competing
          ? await ctx.db.selectFrom("backgroundTasks").select("id").where("kind", "=", "reports.generate").where("completedAt", "is", null).where("lockedAt", "is", null).executeTakeFirst()
          : undefined;
      if (waiting) {
        competing = runNextTask({ db: ctx.db, store: ctx.store, now: () => ctx.now }, "competing-worker");
        for (let n = 0; n < 100; n++) {
          const locked = await ctx.db.selectFrom("backgroundTasks").select("id").where("lockedBy", "=", "competing-worker").executeTakeFirst();
          if (locked) break;
          await pause(10);
        }
        expect(await ctx.db.selectFrom("backgroundTasks").select("kind").where("lockedBy", "=", "competing-worker").executeTakeFirst()).toMatchObject({ kind: "reports.generate" });
      }
      await put(key, body, contentType);
    };
    try {
      const res = await start(a);
      expect(res.statusCode, res.body).toBe(200);
      const filings = await ctx.db.selectFrom("filings").select("status").where("organizationId", "=", res.json().organizationId).where("inspectionId", "is not", null).execute();
      expect(filings.length).toBeGreaterThan(2);
      expect(new Set(filings.map((f) => f.status))).toEqual(new Set(["confirmed", "sent"]));
      expect(await competing).toBe(true);
    } finally {
      await competing;
      ctx.store.put = put;
    }
  });

  it("is not offered outside the demo deployment", async () => {
    expect((await start(ctx.app)).statusCode).toBe(404);
  });

  it("gives the visitor their own demo company, with the story played, signed in as its owner until it ends", async () => {
    const a = await app();
    const res = await start(a);
    expect(res.statusCode).toBe(200);
    const { organizationId, expiresAt } = res.json();
    expect(new Date(expiresAt).getTime() - ctx.now.getTime()).toBe(DEMO_VISIT_HOURS * 3600_000);
    const session = res.cookies.find((c) => c.name === "aw_session")!;
    expect(session.httpOnly).toBe(true);
    expect(Math.abs(new Date(session.expires!).getTime() - new Date(expiresAt).getTime())).toBeLessThan(1000);

    const org = await ctx.db.selectFrom("organizations").select(["demo", "demoExpiresAt", "name"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
    expect(org).toMatchObject({ demo: true, name: "Hill Country Aerobic Services (your demo)" });
    // Nobody can sign in with a password: not the shared one, not any.
    const people = await ctx.db
      .selectFrom("memberships")
      .innerJoin("users", "users.id", "memberships.userId")
      .select(["users.email", "users.passwordHash", "memberships.role"])
      .where("memberships.organizationId", "=", organizationId)
      .execute();
    expect(people.map((p) => p.role).sort()).toEqual(["office", "owner", "technician"]);
    for (const p of people) {
      expect(p.passwordHash).toBeNull();
      expect(p.email).toMatch(/@demo\.example\.com$/);
      const login = await a.inject({ method: "POST", url: "/auth/login", payload: { email: p.email, password: DEMO_PASSWORD } });
      expect(login.statusCode).toBe(401);
    }
    expect(await ctx.db.selectFrom("platformAdmins").select("id").execute()).toEqual([]);

    // Signed in as the owner, with the five-minute path already done.
    const cookie = cookieOf(res);
    const me = (await a.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).json();
    expect(me.role).toBe("owner");
    expect(me.organization.id).toBe(organizationId);
    expect(me.legalDue).toEqual([]);
    const filings = await ctx.db.selectFrom("filings").select("status").where("organizationId", "=", organizationId).where("inspectionId", "is not", null).execute();
    expect(filings.length).toBeGreaterThan(2);
    expect(new Set(filings.map((f) => f.status))).toEqual(new Set(["confirmed", "sent"]));
    expect((await a.inject({ method: "GET", url: "/app-info", headers: { cookie } })).json()).toEqual({ demo: true, demoCompany: true, demoVisitor: true, demoRole: "owner", demoExpiresAt: expiresAt, features: [] });

    const journey = await a.inject({ method: "GET", url: "/demo/journey", headers: { cookie } });
    expect(journey.statusCode, journey.body).toBe(200);
    const j = journey.json();
    expect(j.expiresAt).toBe(expiresAt);
    expect(j.case.customerName).toBeTruthy();
    expect(j.job).toBeTruthy();
    expect(j.invoice.paymentStatus).toBe("unpaid");
    const moved = await a.inject({ method: "PATCH", url: `/jobs/${j.job.id}`, payload: { scheduledDate: new Date(ctx.now.getTime() + 86_400_000).toISOString().slice(0, 10) }, headers: { cookie } });
    expect(moved.statusCode, moved.body).toBe(200);
    const changedJourney = (await a.inject({ method: "GET", url: "/demo/journey", headers: { cookie } })).json();
    expect(changedJourney.job).toBeNull();
    expect(changedJourney.case.filingId).toBe(j.case.filingId);
    const otherTechnician = await createUser(ctx.db, organizationId, "technician");
    const reassigned = await a.inject({ method: "PATCH", url: `/jobs/${j.job.id}`, payload: { scheduledDate: j.job.scheduledDate, technicianId: otherTechnician.id }, headers: { cookie } });
    expect(reassigned.statusCode, reassigned.body).toBe(200);
    expect((await a.inject({ method: "GET", url: "/demo/journey", headers: { cookie } })).json().job).toBeNull();


    const link = await a.inject({ method: "POST", url: "/demo/homeowner", payload: { customerId: j.case.customerId }, headers: { cookie } });
    expect(link.statusCode, link.body).toBe(200);
    expect(link.json().expiresAt).toBe(expiresAt);
    const homeowner = await a.inject({ method: "GET", url: link.json().href, headers: {} });
    expect(homeowner.statusCode, homeowner.body).toBe(200);
    expect(homeowner.body).toContain(j.case.addressLine1);
    expect(await ctx.db.selectFrom("portalLinks").select("expiresAt").where("organizationId", "=", organizationId).where("customerId", "=", j.case.customerId).orderBy("createdAt", "desc").executeTakeFirst()).toMatchObject({ expiresAt: new Date(expiresAt) });

    // A second visitor gets a different company and cannot see the first.
    const other = await start(a, "198.51.100.9");
    expect(other.json().organizationId).not.toBe(organizationId);
    const site = await ctx.db.selectFrom("sites").select("id").where("organizationId", "=", organizationId).executeTakeFirstOrThrow();
    expect((await a.inject({ method: "GET", url: `/sites/${site.id}`, headers: { cookie: cookieOf(other) } })).statusCode).toBe(404);
    expect((await a.inject({ method: "GET", url: `/sites/${site.id}`, headers: { cookie } })).statusCode).toBe(200);

    const wrongHomeowner = await a.inject({ method: "POST", url: "/demo/homeowner", payload: { customerId: j.case.customerId }, headers: { cookie: cookieOf(other) } });
    expect(wrongHomeowner.statusCode).toBe(404);

    // The session ends with the demo.
    const sessions = await ctx.db.selectFrom("sessions").select("expiresAt").where("organizationId", "=", organizationId).execute();
    expect(sessions.map((x) => x.expiresAt.toISOString())).toEqual([expiresAt]);
    await sql`update sessions set expires_at = now() - interval '1 second' where organization_id = ${organizationId}`.execute(ctx.db);
    expect((await a.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode).toBe(401);
    expect((await a.inject({ method: "GET", url: "/demo/journey", headers: { cookie } })).statusCode).toBe(401);
  });

  it("never replays a future-start contract past a private demo's real expiry", async () => {
    const fixed = new Date("2026-10-13T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixed);
    try {
      const a = await app();
      const started = await start(a);
      expect(started.statusCode, started.body).toBe(200);
      const organizationId = started.json().organizationId;
      const future = await ctx.db.selectFrom("contracts").select("id").where("organizationId", "=", organizationId).where("startOn", ">", "2026-10-13").execute();
      expect(future.length).toBeGreaterThan(0);
      expect(await ctx.db.selectFrom("filings").select("id").where("organizationId", "=", organizationId).where("contractId", "in", future.map((c) => c.id)).execute()).toEqual([]);
      const expiry = new Date(started.json().expiresAt);
      expect(expiry.getTime()).toBe(fixed.getTime() + 24 * 3600_000);
      const pending = await ctx.db.selectFrom("backgroundTasks").select(["kind", "runAt"]).where("organizationId", "=", organizationId).where("completedAt", "is", null).where("runAt", "<=", fixed).where("failedAt", "is", null).execute();
      expect(pending).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("lets the visitor look around as the office manager or technician, only in their own demo", async () => {
    const a = await app();
    const cookie = cookieOf(await start(a));
    for (const role of ["office", "technician", "owner"] as const) {
      const res = await a.inject({ method: "POST", url: "/demo/switch", payload: { role }, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const me = (await a.inject({ method: "GET", url: "/auth/me", headers: { cookie: cookieOf(res) } })).json();
      expect(me.role).toBe(role);
    }

    // The shared demo company (signed in with its password) cannot switch people.
    await seedDemoCompany(ctx.db, { password: DEMO_PASSWORD });
    const login = await a.inject({ method: "POST", url: "/auth/login", payload: { email: "office@example.com", password: DEMO_PASSWORD } });
    expect(login.statusCode).toBe(200);
    const shared = await a.inject({ method: "POST", url: "/demo/switch", payload: { role: "owner" }, headers: { cookie: cookieOf(login) } });
    expect(shared.statusCode).toBe(403);
    expect(shared.json().error).toBe("not_a_visitor_demo");
  });

  it("limits starts per visitor per hour, and how many visitor demos exist at once", async () => {
    const a = await app({ perHour: 2, maxLive: 3 });
    expect((await start(a)).statusCode).toBe(200);
    expect((await start(a)).statusCode).toBe(200);
    const limited = await start(a);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe("demo_limit");
    // The address is kept only as a keyed hash.
    const visits = await ctx.db.selectFrom("demoVisits").select("requesterHash").execute();
    expect(visits.every((v) => /^[0-9a-f]{64}$/.test(v.requesterHash) && !v.requesterHash.includes("203.0.113.7"))).toBe(true);

    expect((await start(a, "198.51.100.1")).statusCode).toBe(200);
    const busy = await start(a, "198.51.100.2");
    expect(busy.statusCode).toBe(503);
    expect(busy.json().error).toBe("demo_busy");

    // An hour on, the visitor may start again; a day on, the old demos are gone and make room.
    await sql`update demo_visits set created_at = now() - interval '61 minutes'`.execute(ctx.db);
    await sql`update organizations set demo_expires_at = now() - interval '1 hour' where demo_expires_at is not null`.execute(ctx.db);
    expect((await start(a)).statusCode).toBe(200);
    const live = await ctx.db.selectFrom("organizations").select("id").where("demoExpiresAt", ">", new Date()).execute();
    expect(live).toHaveLength(1);
    const erased = await ctx.db.selectFrom("organizations").select(["id", "subscriptionState"]).where("demoExpiresAt", "<=", new Date()).execute();
    expect(erased).toHaveLength(3);
    for (const { id, subscriptionState } of erased) {
      expect(subscriptionState).toBe("read_only");
      expect(await ctx.db.selectFrom("customers").select("id").where("organizationId", "=", id).execute()).toEqual([]);
      expect(await ctx.db.selectFrom("memberships").select("userId").where("organizationId", "=", id).execute()).toEqual([]);
    }
    expect(await ctx.db.selectFrom("demoVisits").select("id").execute()).toHaveLength(1);
  });

  it("ending visitor A's demo touches only A: not visitor B, nor a separate sandbox company, nor their queued work", async () => {
    const a = await app({ perHour: 2, maxLive: 3 });
    const visitorA = await start(a, "203.0.113.10");
    const visitorB = await start(a, "203.0.113.11");
    const [orgA, orgB] = [visitorA.json().organizationId as string, visitorB.json().organizationId as string];
    const [cookieA, cookieB] = [cookieOf(visitorA), cookieOf(visitorB)];
    // A company made by hand on the same server (as staging's sandbox is): not a visitor demo.
    const sandbox = await createOrg(ctx.db, "Sandbox company");
    const sandboxOwner = await createUser(ctx.db, sandbox.id, "owner");
    const sandboxCookie = await login(a, sandboxOwner.email);

    const queue = async (organizationId: string) =>
      ctx.db
        .insertInto("backgroundTasks")
        .values({ organizationId, kind: "email.send", payload: "{}", dedupeKey: null, runAt: new Date(0), lockedAt: null, lockedBy: null, lastError: null, completedAt: null, failedAt: null })
        .returning("id")
        .executeTakeFirstOrThrow();
    const [taskA, taskB, taskSandbox] = [await queue(orgA), await queue(orgB), await queue(sandbox.id)];

    // Visitor A's day is over (their session row has not run out yet).
    await sql`update organizations set demo_expires_at = now() - interval '1 hour' where id = ${orgA}`.execute(ctx.db);

    // A is let in nowhere, and nothing queued for A runs or counts as a stalled queue.
    expect((await a.inject({ method: "GET", url: "/auth/me", headers: { cookie: cookieA } })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url: "/demo/switch", payload: { role: "office" }, headers: { cookie: cookieA } })).statusCode).toBe(401);
    expect(await claimNext(ctx.db, "test", new Date(), orgA)).toBeNull();
    const health = await checkQueue(ctx.db, new Date(Date.now() + 3600_000));
    expect(health.alerts.some((x) => JSON.stringify(x).includes(orgA))).toBe(false);
    // B and the sandbox company carry on.
    expect((await a.inject({ method: "GET", url: "/auth/me", headers: { cookie: cookieB } })).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/auth/me", headers: { cookie: sandboxCookie } })).statusCode).toBe(200);
    expect((await claimNext(ctx.db, "test", new Date(), orgB))?.id).toBe(taskB.id);

    // The next start empties A only.
    expect((await start(a, "203.0.113.12")).statusCode).toBe(200);
    expect(await ctx.db.selectFrom("customers").select("id").where("organizationId", "=", orgA).execute()).toEqual([]);
    expect(await ctx.db.selectFrom("backgroundTasks").select("id").where("id", "=", taskA.id).execute()).toEqual([]);
    expect((await ctx.db.selectFrom("customers").select("id").where("organizationId", "=", orgB).execute()).length).toBeGreaterThan(0);
    expect((await a.inject({ method: "GET", url: "/auth/me", headers: { cookie: cookieB } })).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/auth/me", headers: { cookie: sandboxCookie } })).statusCode).toBe(200);
    const sandboxTask = await ctx.db.selectFrom("backgroundTasks").select(["attempts", "lockedBy", "completedAt"]).where("id", "=", taskSandbox.id).executeTakeFirstOrThrow();
    expect(sandboxTask).toEqual({ attempts: 0, lockedBy: null, completedAt: null });
    // The sandbox company is not a visitor demo: it cannot switch people.
    expect((await a.inject({ method: "POST", url: "/demo/switch", payload: { role: "office" }, headers: { cookie: sandboxCookie } })).statusCode).toBe(403);
  });
});
