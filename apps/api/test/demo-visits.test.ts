import { DEMO_PASSWORD, seedDemoCompany } from "@aerowise/db";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildApp, type App } from "../src/app.ts";
import { DEMO_VISIT_HOURS } from "../src/routes/demo-visits.ts";
import { setupTestApp } from "./helpers.ts";

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
    expect(filings.map((f) => f.status).sort()).toEqual(["confirmed", "sent"]);
    expect((await a.inject({ method: "GET", url: "/app-info", headers: { cookie } })).json()).toEqual({ demo: true, demoCompany: true, demoVisitor: true });

    // A second visitor gets a different company and cannot see the first.
    const other = await start(a, "198.51.100.9");
    expect(other.json().organizationId).not.toBe(organizationId);
    const site = await ctx.db.selectFrom("sites").select("id").where("organizationId", "=", organizationId).executeTakeFirstOrThrow();
    expect((await a.inject({ method: "GET", url: `/sites/${site.id}`, headers: { cookie: cookieOf(other) } })).statusCode).toBe(404);
    expect((await a.inject({ method: "GET", url: `/sites/${site.id}`, headers: { cookie } })).statusCode).toBe(200);

    // The session ends with the demo.
    const sessions = await ctx.db.selectFrom("sessions").select("expiresAt").where("organizationId", "=", organizationId).execute();
    expect(sessions.map((x) => x.expiresAt.toISOString())).toEqual([expiresAt]);
    await sql`update sessions set expires_at = now() - interval '1 second' where organization_id = ${organizationId}`.execute(ctx.db);
    expect((await a.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode).toBe(401);
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
});
