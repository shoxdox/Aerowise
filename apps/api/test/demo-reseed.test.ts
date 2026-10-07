import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_ORG_NAME, DEMO_PASSWORD, reseedDemo } from "@aerowise/db";
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

/**
 * The renewal e2e's path through the API: run the campaign, the homeowner signs and pays on the
 * test checkout, and the renewal activates with a signed document, a paid invoice and a new
 * contract (renewal and signed document, renewal and new contract point at each other).
 */
async function activateRenewal(app: App, api: ReturnType<typeof client>) {
  expect((await api.post("/billing/stripe/connect", {})).statusCode).toBeLessThan(300);
  await api.post("/billing/stripe/refresh", {});
  expect((await api.patch("/renewals/settings", { windowDays: 180 })).statusCode).toBe(200);
  expect((await api.post("/renewals/campaign", {})).statusCode).toBe(200);
  const pick = (await api.get("/renewals?status=upcoming")).json().items[0];
  const token = ((await api.get(`/renewals/${pick.id}`)).json().link as string).split("/renew/")[1]!;
  const anon = client(app);
  const signed = await anon.post(`/renew/${token}/sign`, { version: 1, contact: { email: "pat@example.com", phone: "512-555-0101" }, signerName: "Pat Homeowner", signature: { kind: "typed" }, agree: true });
  expect(signed.statusCode).toBe(200);
  const url = new URL((await anon.post(`/renew/${token}/checkout`, {})).json().url);
  const paid = await anon.post(`/pay/${url.pathname.split("/")[2]}/test-checkout`, { sessionId: url.searchParams.get("session"), outcome: "card" });
  expect(paid.json().ok).toBe(true);
  const done = (await api.get(`/renewals/${pick.id}`)).json();
  expect(done).toMatchObject({ status: "activated", signedDocument: expect.anything(), invoice: { paymentStatus: "paid" } });
  return done.id as string;
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
  it("stays idempotent night after night: old shared companies never block the seed, and tombstones are left as they are", async () => {
    const files = mkdtempSync(join(tmpdir(), "aerowise-reseed-"));
    const live = () => ctx.db.selectFrom("organizations").select("id").where("name", "=", DEMO_ORG_NAME).where("demoExpiresAt", "is", null).execute();
    const tombstones = () => ctx.db.selectFrom("organizations").select(["id", "demoExpiresAt", "name"]).where("demoExpiresAt", "is not", null).orderBy("id").execute();
    await reseedDemo(ctx.db, { filesDir: files });
    const seen: string[] = [];
    let earlier: Awaited<ReturnType<typeof tombstones>> = [];
    for (let night = 1; night <= 3; night++) {
      const [current] = await live();
      seen.push(current!.id);
      const result = await reseedDemo(ctx.db, { filesDir: files });
      // Only the live shared company is emptied; no earlier tombstone is touched again.
      expect(result.removed).toEqual([current!.id]);
      const now = await tombstones();
      expect(now.map((t) => t.id).sort()).toEqual(seen.slice().sort());
      for (const t of earlier) expect(now.find((n) => n.id === t.id)?.demoExpiresAt).toEqual(t.demoExpiresAt);
      // An old shared company keeps the seed's name, yet the seed made a new live one with its people.
      expect(now.every((t) => t.name === DEMO_ORG_NAME)).toBe(true);
      const fresh = await live();
      expect(fresh).toHaveLength(1);
      expect(seen).not.toContain(fresh[0]!.id);
      expect(await snapshot(fresh[0]!.id)).toMatchObject({ memberships: 3 });
      for (const t of now) expect(Object.values(await snapshot(t.id)).every((n) => n === 0)).toBe(true);
      earlier = now;
    }
    expect((await ctx.db.selectFrom("users").select("email").orderBy("email").execute()).map((u) => u.email)).toEqual(["office@example.com", "owner@example.com", "tech@example.com"]);
  });
  it("empties a public demo whose renewal was activated (signed, paid, new contract) and keeps one activated in a prospect demo", async () => {
    const w = await world();
    // As the renewal e2e does it, in the shared demo company (signed in with the development password)
    // and in the prospect's demo (signed in by its link).
    const login = await w.app.inject({ method: "POST", url: "/auth/login", payload: { email: "owner@example.com", password: DEMO_PASSWORD } });
    expect(login.statusCode).toBe(200);
    await activateRenewal(w.app, client(w.app, cookieOf(login)));
    const kept = await activateRenewal(w.app, client(w.app, w.prospect.cookie));
    const prospectBefore = await snapshot(w.prospect.id);
    const trialBefore = await snapshot(w.trial.org.id);
    const renewalsOf = (id: string) => ctx.db.selectFrom("renewals").select(["id", "status", "newContractId", "signedDocumentId"]).where("organizationId", "=", id).execute();
    const prospectRenewals = await renewalsOf(w.prospect.id);

    for (let night = 0; night < 3; night++) {
      await reseedDemo(ctx.db, { filesDir: w.files });
      expect(await renewalsOf(w.publicId)).toEqual([]);
      expect(await ctx.db.selectFrom("signedDocuments").select("id").where("organizationId", "=", w.publicId).execute()).toEqual([]);
      expect(await ended(w.publicId)).toBe(true);
      // The prospect's activated renewal, its signed document and new contract are untouched.
      expect(await renewalsOf(w.prospect.id)).toEqual(prospectRenewals);
      expect(prospectRenewals.find((r) => r.id === kept)).toMatchObject({ status: "activated", newContractId: expect.any(String), signedDocumentId: expect.any(String) });
      expect(await snapshot(w.prospect.id)).toEqual(prospectBefore);
      expect(await snapshot(w.trial.org.id)).toEqual(trialBefore);
    }
  });
  // The same tables pointing at each other are emptied when a company is erased: a prospect
  // ended by hand or on its day, and a real company deleted on its request.
  it("ends a prospect demo with an activated renewal, by hand and on its day, without breaking the renewal's checks", async () => {
    const w = await world();
    await activateRenewal(w.app, client(w.app, w.prospect.cookie));
    const ended = await w.admin.post(`/admin/prospect-demos/${w.prospect.id}/end`, {});
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json().state).toBe("ended");
    expect(await ctx.db.selectFrom("renewals").select("id").where("organizationId", "=", w.prospect.id).execute()).toEqual([]);
    expect(await ctx.db.selectFrom("signedDocuments").select("id").where("organizationId", "=", w.prospect.id).execute()).toEqual([]);

    // Another prospect, reaching its day.
    const made = (await w.admin.post("/admin/prospect-demos", { prospect: "Hill Top Aerobic", serviceCounties: ["Hays County"], days: 7 })).json();
    const entered = await w.app.inject({ method: "POST", url: "/demo/enter", payload: { token: (made.link.url as string).split("#")[1] } });
    await activateRenewal(w.app, client(w.app, cookieOf(entered)));
    await sql`update organizations set demo_expires_at = now() - interval '1 hour' where id = ${made.demo.id}`.execute(ctx.db);
    const list = await w.admin.get("/admin/prospect-demos");
    expect(list.statusCode, list.body).toBe(200);
    expect(await ctx.db.selectFrom("renewals").select("id").where("organizationId", "=", made.demo.id).execute()).toEqual([]);
    expect(await snapshot(w.trial.org.id)).toMatchObject({ customers: 1 });
  });

  it("erases a real company with an activated renewal on its request, and only that company", async () => {
    const w = await world();
    const other = await createTenant({ ...ctx, app: w.app }, "Other Real Septic");
    // A 12-month contract ending inside the renewal window.
    const plan = (await w.trial.api.post("/plans", { name: "Standard", termMonths: 12, visitsPerTerm: 2, priceCents: 30000, billingFrequency: "annual" })).json();
    const startOn = new Date(Date.now() - 300 * 86_400_000).toISOString().slice(0, 10);
    expect((await w.trial.api.post(`/sites/${w.trial.site.id}/contracts`, { planId: plan.id, startOn })).statusCode).toBe(201);
    await activateRenewal(w.app, w.trial.api);
    const otherBefore = await snapshot(other.org.id);
    const res = await w.admin.post(`/admin/organizations/${w.trial.org.id}/erase`, { confirmName: "Clean Trial Septic" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().tables).toMatchObject({ renewals: 1, signed_documents: 1 });
    expect(await ctx.db.selectFrom("contracts").select("id").where("organizationId", "=", w.trial.org.id).execute()).toEqual([]);
    expect(await snapshot(other.org.id)).toEqual(otherBefore);
    expect((await other.api.get("/auth/me")).statusCode).toBe(200);
  });
});
