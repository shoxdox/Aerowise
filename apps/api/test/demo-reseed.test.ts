import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_ORG_NAME, reseedDemo } from "@aerowise/db";
import { LocalDiskStore } from "@aerowise/storage";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../src/app.ts";
import { adminLogin, client, createAdmin, createTenant, setupTestApp } from "./helpers.ts";

// The nightly reset of the hosted demo (STG-01) refreshes only its public part: the shared demo
// company and visitors' own. A prospect's demo, promised for days, and a real company trying
// Aerowise on the same server keep their data, people, sign-ins, files and queued work.
const ctx = setupTestApp();

let demoApp: App | undefined;
afterEach(async () => {
  await demoApp?.close();
  demoApp = undefined;
});

const SNAPSHOT = ["customers", "sites", "inspections", "attachments", "filings", "invoices", "memberships", "sessions", "backgroundTasks", "emailSends", "auditEvents", "platformAuditEvents", "demoAccessLinks"] as const;

/** How many rows one company has in each of the tables that matter here. */
async function snapshot(organizationId: string) {
  const out = {} as Record<(typeof SNAPSHOT)[number], number>;
  for (const t of SNAPSHOT) {
    const r = await ctx.db.selectFrom(t).select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", organizationId).executeTakeFirstOrThrow();
    out[t] = Number(r.n);
  }
  return out;
}

/** Whether a company reads as an ended demo, the way /auth/access-status (STG-03) asks. */
async function ended(id: string) {
  const row = await ctx.db.selectFrom("organizations").select("id").where("id", "=", id).where("demo", "=", true).where("demoExpiresAt", "<=", new Date()).executeTakeFirst();
  return Boolean(row);
}

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => `aw_session=${res.cookies.find((c) => c.name === "aw_session")!.value}`;

async function world() {
  // The seed and the story date the demo from the real today.
  ctx.now = new Date();
  const files = mkdtempSync(join(tmpdir(), "aerowise-reseed-"));
  const store = new LocalDiskStore(files);
  await reseedDemo(ctx.db, { filesDir: files });
  demoApp = await buildApp({ db: ctx.db, demo: true, now: () => ctx.now, store, sms: ctx.sms, loginRateLimit: 1000 });
  const app = demoApp;
  const public_ = await ctx.db.selectFrom("organizations").select("id").where("name", "=", DEMO_ORG_NAME).executeTakeFirstOrThrow();
  await store.put(`${public_.id}/logo/logo.png`, Buffer.from("x"), "image/png");

  // A visitor's own demo, with the story's photos.
  const visit = await app.inject({ method: "POST", url: "/demo/start", payload: {}, remoteAddress: "203.0.113.7" });
  expect(visit.statusCode).toBe(200);
  const visitor = { id: visit.json().organizationId as string, cookie: cookieOf(visit) };

  // A prospect's demo, signed in by its link.
  await createAdmin(ctx);
  const admin = client(app, await adminLogin({ ...ctx, app }));
  const made = await admin.post("/admin/prospect-demos", { prospect: "Lone Star Aerobic", serviceCounties: ["Travis County"], days: 14 });
  expect(made.statusCode).toBe(201);
  const token = (made.json().link.url as string).split("#")[1]!;
  const entered = await app.inject({ method: "POST", url: "/demo/enter", payload: { token } });
  expect(entered.statusCode).toBe(200);
  const prospect = { id: made.json().demo.id as string, token, cookie: cookieOf(entered) };

  // A real company on its trial, with a stored file, queued work and an outbox email.
  const trial = await createTenant({ ...ctx, app }, "Clean Trial Septic");
  await store.put(`${trial.org.id}/photos/one.jpg`, Buffer.from("trial photo"), "image/jpeg");
  await ctx.db
    .insertInto("backgroundTasks")
    .values({ organizationId: trial.org.id, kind: "email.send", payload: "{}", dedupeKey: null, runAt: new Date(0), lockedAt: null, lockedBy: null, lastError: null, completedAt: null, failedAt: null })
    .execute();
  const invited = await trial.api.post("/invitations", { email: "office.trial@example.com", role: "office" });
  expect(invited.statusCode).toBeLessThan(300);

  return { app, admin, files, store, publicId: public_.id, visitor, prospect, trial };
}

describe("the nightly demo reset", () => {
  it("refreshes the public demo and visitors' demos, and keeps prospect demos and real trials as they were", async () => {
    const w = await world();
    const prospectBefore = await snapshot(w.prospect.id);
    const trialBefore = await snapshot(w.trial.org.id);
    expect(prospectBefore.attachments).toBeGreaterThan(0);
    expect(trialBefore.emailSends + trialBefore.backgroundTasks).toBeGreaterThan(0);
    const prospectFiles = readdirSync(join(w.files, w.prospect.id), { recursive: true }).length;
    expect(prospectFiles).toBeGreaterThan(0);
    expect(existsSync(join(w.files, w.visitor.id))).toBe(true);

    const result = await reseedDemo(ctx.db, { filesDir: w.files });
    expect(result.removed.sort()).toEqual([w.publicId, w.visitor.id].sort());
    expect(result.kept).toBe(2);

    // The public demo: seeded afresh as a new company; the old one and the visitor's emptied of
    // their data, files and people, their rows left as ended tombstones.
    const fresh = await ctx.db.selectFrom("organizations").select("id").where("name", "=", DEMO_ORG_NAME).where("demoExpiresAt", "is", null).executeTakeFirstOrThrow();
    expect(fresh.id).not.toBe(w.publicId);
    for (const id of [w.publicId, w.visitor.id]) {
      expect(await ended(id)).toBe(true);
      expect(Object.values(await snapshot(id)).every((n) => n === 0)).toBe(true);
    }
    // Exactly what /auth/access-status (STG-03) asks: only a demo company past its end reads as ended.
    for (const id of [fresh.id, w.prospect.id, w.trial.org.id, crypto.randomUUID()]) expect(await ended(id)).toBe(false);
    expect(await snapshot(fresh.id)).toMatchObject({ memberships: 3, attachments: 0 });
    expect(existsSync(join(w.files, w.publicId))).toBe(false);
    expect(existsSync(join(w.files, w.visitor.id))).toBe(false);
    expect((await client(w.app, w.visitor.cookie).get("/auth/me")).statusCode).toBe(401);
    expect(await ctx.db.selectFrom("users").select("email").where("email", "like", "%@demo.example.com").execute()).toHaveLength(3); // the prospect's
    expect(await ctx.db.selectFrom("demoVisits").select("id").execute()).toEqual([]);

    // The prospect: everything as it was, still signed in, and its link still works.
    expect(await snapshot(w.prospect.id)).toEqual(prospectBefore);
    expect(readdirSync(join(w.files, w.prospect.id), { recursive: true })).toHaveLength(prospectFiles);
    const me = await client(w.app, w.prospect.cookie).get("/auth/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().organization.id).toBe(w.prospect.id);
    expect((await w.app.inject({ method: "POST", url: "/demo/enter", payload: { token: w.prospect.token } })).statusCode).toBe(200);
    expect((await w.admin.get("/admin/prospect-demos")).json().items).toEqual([expect.objectContaining({ id: w.prospect.id, state: "live" })]);

    // The real trial: its people, sign-in, file, queued work and outbox untouched.
    expect(await snapshot(w.trial.org.id)).toEqual(trialBefore);
    expect((await w.trial.api.get("/auth/me")).statusCode).toBe(200);
    expect((await w.store.get(`${w.trial.org.id}/photos/one.jpg`))?.toString()).toBe("trial photo");
    expect(await ctx.db.selectFrom("invitations").select("email").where("organizationId", "=", w.trial.org.id).execute()).toEqual([{ email: "office.trial@example.com" }]);

    // Again, as every night: the same three companies, the prospect and trial still unchanged
    // (the prospect now with the second sign-in its link just made).
    const prospectNow = await snapshot(w.prospect.id);
    expect(prospectNow).toEqual({ ...prospectBefore, sessions: prospectBefore.sessions + 1 });
    const second = await reseedDemo(ctx.db, { filesDir: w.files });
    expect(second.removed).toEqual([fresh.id]); // tombstones are left as they are
    expect(await ended(fresh.id)).toBe(true);
    expect(await ended(w.visitor.id)).toBe(true);
    expect(await ctx.db.selectFrom("organizations").select("id").where("demoExpiresAt", "is", null).where("demo", "=", true).execute()).toHaveLength(1);
    expect(await snapshot(w.prospect.id)).toEqual(prospectNow);
    expect(await snapshot(w.trial.org.id)).toEqual(trialBefore);
  });

  it("leaves a prospect demo to end on its own day, and keeps the record of one that ended", async () => {
    const w = await world();
    await reseedDemo(ctx.db, { filesDir: w.files });
    // Its day comes after the reset: it ends and is emptied as before.
    await sql`update organizations set demo_expires_at = now() - interval '1 hour' where id = ${w.prospect.id}`.execute(ctx.db);
    expect((await client(w.app, w.prospect.cookie).get("/auth/me")).statusCode).toBe(401);
    expect((await w.admin.get("/admin/prospect-demos")).json().items).toEqual([expect.objectContaining({ id: w.prospect.id, state: "ended" })]);
    expect(await snapshot(w.prospect.id)).toMatchObject({ customers: 0, memberships: 0, attachments: 0 });
    expect(existsSync(join(w.files, w.prospect.id))).toBe(false);

    // The next reset keeps the ended prospect's row and its admin history.
    const history = await snapshot(w.prospect.id);
    await reseedDemo(ctx.db, { filesDir: w.files });
    expect(await ctx.db.selectFrom("organizations").select("demoProspect").where("id", "=", w.prospect.id).execute()).toEqual([{ demoProspect: "Lone Star Aerobic" }]);
    expect(await snapshot(w.prospect.id)).toEqual(history);
    expect(history.platformAuditEvents).toBeGreaterThan(0);
    expect((await w.admin.get("/admin/prospect-demos")).json().items).toEqual([expect.objectContaining({ id: w.prospect.id, state: "ended" })]);
  });

  it("keeps someone who also belongs to a company that stays", async () => {
    const w = await world();
    // The trial's owner was also added to the public demo company.
    await ctx.db.insertInto("memberships").values({ organizationId: w.publicId, userId: w.trial.owner.id, role: "office", technicianLicense: null }).execute();
    await reseedDemo(ctx.db, { filesDir: w.files });
    expect(await ctx.db.selectFrom("memberships").select("organizationId").where("userId", "=", w.trial.owner.id).execute()).toEqual([{ organizationId: w.trial.org.id }]);
    expect((await w.trial.api.get("/auth/me")).statusCode).toBe(200);
  });
});
