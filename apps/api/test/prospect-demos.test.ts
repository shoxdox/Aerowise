import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminLogin, client, createAdmin, createTenant, setupTestApp } from "./helpers.ts";

// Personalized prospect demos (W10.6): made from /admin with the prospect's name and counties,
// fictional data only, entered by a link the admin sends themselves, ending on a set day,
// every step audited; turning one into a trial leaves no synthetic record in the real company.
const ctx = setupTestApp();

async function setup() {
  // The seed dates the demo from the real today, so the story plays on the real clock.
  ctx.now = new Date();
  await createAdmin(ctx);
  const admin = client(ctx.app, await adminLogin(ctx));
  const res = await admin.post("/admin/prospect-demos", { prospect: "Lone Star Aerobic", serviceCounties: ["Travis County", "Hays County"], days: 7 });
  expect(res.statusCode).toBe(201);
  const { demo, link } = res.json();
  return { admin, demo, link, token: (link.url as string).split("#")[1]! };
}

const enter = (token: string) => ctx.app.inject({ method: "POST", url: "/demo/enter", payload: { token } });
const cookieOf = (res: Awaited<ReturnType<typeof enter>>) => `aw_session=${res.cookies.find((c) => c.name === "aw_session")!.value}`;
const audit = (organizationId: string) =>
  ctx.db.selectFrom("platformAuditEvents").select("action").where("organizationId", "=", organizationId).orderBy("occurredAt").orderBy("id").execute().then((r) => r.map((x) => x.action));

describe("prospect demos", () => {
  it("are made from /admin with the prospect's name and counties, on fictional data, and nothing is sent", async () => {
    const { demo, link } = await setup();
    expect(demo).toMatchObject({ prospect: "Lone Star Aerobic", name: "Lone Star Aerobic (demo)", serviceCounties: ["Travis County", "Hays County"], state: "live", activeLinks: 1 });
    expect(new Date(demo.endsAt).getTime() - ctx.now.getTime()).toBe(7 * 86_400_000);
    expect(link.url).toMatch(/\/demo\/enter#[\w-]{40,}$/);

    const visitorCookie = cookieOf(await enter(link.url.split("#")[1]));
    expect((await ctx.app.inject({ method: "GET", url: "/app-info", headers: { cookie: visitorCookie } })).json()).toMatchObject({ demoVisitor: true });
    expect((await ctx.app.inject({ method: "GET", url: "/demo/journey", headers: { cookie: visitorCookie } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/demo/switch", payload: { role: "technician" }, headers: { cookie: visitorCookie } })).statusCode).toBe(200);

    const org = await ctx.db.selectFrom("organizations").select(["demo", "demoProspect"]).where("id", "=", demo.id).executeTakeFirstOrThrow();
    expect(org).toEqual({ demo: true, demoProspect: "Lone Star Aerobic" });
    const people = await ctx.db.selectFrom("memberships").innerJoin("users", "users.id", "memberships.userId").select(["users.email", "users.passwordHash"]).where("organizationId", "=", demo.id).execute();
    expect(people).toHaveLength(3);
    for (const p of people) {
      expect(p.passwordHash).toBeNull();
      expect(p.email).toMatch(/@demo\.example\.com$/);
    }
    // The five-minute story was played; nobody was invited and nothing left for a real inbox.
    const filings = await ctx.db.selectFrom("filings").select("status").where("organizationId", "=", demo.id).where("inspectionId", "is not", null).execute();
    // Yesterday's two and the year's history before them: every report filing sent or confirmed.

    expect(filings.length).toBeGreaterThan(2);

    expect(new Set(filings.map((f) => f.status))).toEqual(new Set(["confirmed", "sent"]));
    expect(await ctx.db.selectFrom("invitations").select("id").where("organizationId", "=", demo.id).execute()).toEqual([]);
    const tokens = await ctx.db.selectFrom("demoAccessLinks").select("tokenHash").execute();
    expect(tokens.every((t) => !link.url.includes(t.tokenHash))).toBe(true);
    expect(await audit(demo.id)).toEqual(["prospect_demo.created"]);
  });

  it("let the prospect in by their link, as the owner, until a new link replaces it", async () => {
    const { admin, demo, token } = await setup();
    const opened = await enter(token);
    expect(opened.statusCode).toBe(200);
    const me = (await client(ctx.app, cookieOf(opened)).get("/auth/me")).json();
    expect(me.role).toBe("owner");
    expect(me.organization.id).toBe(demo.id);
    expect((await client(ctx.app, cookieOf(opened)).post("/demo/switch", { role: "technician" })).statusCode).toBe(200);
    expect((await enter("x".repeat(43))).statusCode).toBe(404);

    const next = await admin.post(`/admin/prospect-demos/${demo.id}/links`, {});
    expect(next.statusCode).toBe(201);
    expect((await enter(token)).statusCode).toBe(404);
    expect((await enter(next.json().url.split("#")[1])).statusCode).toBe(200);
    expect(await audit(demo.id)).toEqual(["prospect_demo.created", "prospect_demo.link_issued"]);
  });

  it("end on their day: no way in, no queued work, then emptied", async () => {
    const { admin, demo, token } = await setup();
    const session = cookieOf(await enter(token));
    const task = await ctx.db
      .insertInto("backgroundTasks")
      .values({ organizationId: demo.id, kind: "email.send", payload: "{}", dedupeKey: null, runAt: new Date(0), lockedAt: null, lockedBy: null, lastError: null, completedAt: null, failedAt: null })
      .returning("id")
      .executeTakeFirstOrThrow();
    await sql`update organizations set demo_expires_at = now() - interval '1 hour' where id = ${demo.id}`.execute(ctx.db);
    expect((await client(ctx.app, session).get("/auth/me")).statusCode).toBe(401);
    expect((await enter(token)).statusCode).toBe(404);
    const { claimNext } = await import("@aerowise/tasks");
    expect(await claimNext(ctx.db, "test", new Date(), demo.id)).toBeNull();

    const list = (await admin.get("/admin/prospect-demos")).json();
    expect(list.items).toEqual([expect.objectContaining({ id: demo.id, state: "ended" })]);
    expect(await ctx.db.selectFrom("customers").select("id").where("organizationId", "=", demo.id).execute()).toEqual([]);
    expect(await ctx.db.selectFrom("backgroundTasks").select("id").where("id", "=", task.id).execute()).toEqual([]);
    expect((await admin.post(`/admin/prospect-demos/${demo.id}/links`, {})).statusCode).toBe(409);
  });

  it("can be ended by hand, which touches no other company", async () => {
    const { admin, demo, token } = await setup();
    const other = await createTenant(ctx, "Real company");
    const session = cookieOf(await enter(token));
    const ended = await admin.post(`/admin/prospect-demos/${demo.id}/end`, {});
    expect(ended.statusCode).toBe(200);
    expect(ended.json().state).toBe("ended");
    expect((await client(ctx.app, session).get("/auth/me")).statusCode).toBe(401);
    expect((await enter(token)).statusCode).toBe(404);
    expect(await ctx.db.selectFrom("customers").select("id").where("organizationId", "=", demo.id).execute()).toEqual([]);
    expect((await other.api.get("/auth/me")).statusCode).toBe(200);
    expect(await ctx.db.selectFrom("customers").select("id").where("organizationId", "=", other.org.id).execute()).toHaveLength(1);
    expect(await audit(demo.id)).toEqual(["prospect_demo.created", "prospect_demo.ended"]);
    expect((await admin.post(`/admin/prospect-demos/${demo.id}/end`, {})).statusCode).toBe(409);
  });

  it("turn into a real trial company with nothing synthetic in it, and the demo ends", async () => {
    const { admin, demo, token } = await setup();
    const sendsBefore = await ctx.db.selectFrom("emailSends").select("id").execute();
    const res = await admin.post(`/admin/prospect-demos/${demo.id}/convert`, {});
    expect(res.statusCode).toBe(201);
    const trialId = res.json().organizationId;
    const trial = await ctx.db.selectFrom("organizations").select(["name", "demo", "demoProspect", "demoExpiresAt", "subscriptionState", "serviceCounties"]).where("id", "=", trialId).executeTakeFirstOrThrow();
    expect(trial).toEqual({ name: "Lone Star Aerobic", demo: false, demoProspect: null, demoExpiresAt: null, subscriptionState: "trial", serviceCounties: ["Travis County", "Hays County"] });
    for (const table of ["customers", "sites", "contacts", "contracts", "jobs", "inspections", "filings", "invoices", "renewals", "memberships", "invitations", "backgroundTasks", "emailSends", "smsMessages", "attachments", "reports"] as const) {
      const rows = await ctx.db.selectFrom(table).select("organizationId").where("organizationId", "=", trialId).execute();
      expect(rows, table).toEqual([]);
    }
    // The step sends nothing: no invitation, no email, nothing queued, for either company.
    expect(await ctx.db.selectFrom("emailSends").select("id").where("organizationId", "=", trialId).execute()).toEqual([]);
    expect(await ctx.db.selectFrom("backgroundTasks").select("id").where("organizationId", "=", demo.id).execute()).toEqual([]);
    expect(await ctx.db.selectFrom("emailSends").select("id").execute()).toEqual(sendsBefore);
    // The demo stays a demo company (it can never become real) and has ended and been emptied.
    const after = await ctx.db.selectFrom("organizations").select(["demo", "demoExpiresAt"]).where("id", "=", demo.id).executeTakeFirstOrThrow();
    expect(after.demo).toBe(true);
    expect(after.demoExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await ctx.db.selectFrom("customers").select("id").where("organizationId", "=", demo.id).execute()).toEqual([]);
    expect((await enter(token)).statusCode).toBe(404);
    expect(await audit(demo.id)).toEqual(["prospect_demo.created", "prospect_demo.converted"]);
    expect(await audit(trialId)).toEqual(["organization.created"]);
  });

  it("are for platform admins only", async () => {
    ctx.now = new Date();
    const tenant = await createTenant(ctx, "Real company");
    expect((await client(ctx.app).get("/admin/prospect-demos")).statusCode).toBe(401);
    expect((await tenant.api.post("/admin/prospect-demos", { prospect: "X", serviceCounties: ["Travis County"] })).statusCode).toBe(401);
  });
});
