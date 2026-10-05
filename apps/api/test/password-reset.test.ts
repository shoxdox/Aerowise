import { drainTasks } from "@aerowise/tasks";
import { describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { client, createOrg, createTenant, createUser, login, PASSWORD, setupTestApp, type TestContext } from "./helpers.ts";

const mail = new FakeMail();
const ctx = setupTestApp({ mail });
const APP_URL = "http://localhost:3000";
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail, appUrl: APP_URL });

const resetEmails = (to: string) => [...mail.delivered.values()].filter((m) => m.to === to && m.idempotencyKey.startsWith("password-reset-"));
const linkIn = (text: string) => /\/reset-password\/([A-Za-z0-9_-]+)/.exec(text)![1]!;

async function requestReset(email: string, ip = "10.0.0.1") {
  return ctx.app.inject({ method: "POST", url: "/auth/password-reset", payload: { email }, remoteAddress: ip });
}

async function resetLinkFor(email: string) {
  mail.delivered.clear();
  expect((await requestReset(email)).statusCode).toBe(202);
  await runWorker(ctx);
  const [message] = resetEmails(email.toLowerCase());
  expect(message, "reset email").toBeTruthy();
  return linkIn(message!.text);
}

const setPassword = (token: string, password: string) =>
  ctx.app.inject({ method: "POST", url: `/auth/password-reset/${token}`, payload: { password } });

describe("password reset", () => {
  it("emails a link that sets a new password and signs the person out everywhere", async () => {
    const t = await createTenant(ctx, "Org A");
    const other = await createOrg(ctx.db, "Org B");
    await ctx.db.insertInto("memberships").values({ organizationId: other.id, userId: t.owner.id, role: "office", technicianLicense: null }).execute();
    const otherSession = client(ctx.app, await login(ctx.app, t.owner.email, PASSWORD, other.id));

    const token = await resetLinkFor(t.owner.email.toUpperCase());
    expect((await ctx.app.inject({ method: "GET", url: `/auth/password-reset/${token}` })).json()).toEqual({ email: t.owner.email });
    expect((await setPassword(token, "a brand new password")).statusCode).toBe(204);

    // Both sessions end, the old password stops working and the new one works.
    expect((await t.api.get("/auth/me")).statusCode).toBe(401);
    expect((await otherSession.get("/auth/me")).statusCode).toBe(401);
    await expect(login(ctx.app, t.owner.email, PASSWORD)).rejects.toThrow(/401/);
    await login(ctx.app, t.owner.email, "a brand new password");

    const audits = await ctx.db.selectFrom("auditEvents").select(["organizationId"]).where("action", "=", "user.password_reset").execute();
    expect(audits.map((a) => a.organizationId).sort()).toEqual([t.org.id, other.id].sort());
  });

  it("answers the same for unknown emails and sends nothing", async () => {
    mail.delivered.clear();
    const res = await requestReset("nobody@example.com");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    await runWorker(ctx);
    expect(mail.delivered.size).toBe(0);
  });

  it("sends nothing to a person with no active membership", async () => {
    mail.delivered.clear();
    const org = await createOrg(ctx.db, "Org A");
    const gone = await createUser(ctx.db, org.id, "technician", { membershipActive: false });
    expect((await requestReset(gone.email)).statusCode).toBe(202);
    await runWorker(ctx);
    expect(mail.delivered.size).toBe(0);
  });

  it("works once", async () => {
    const t = await createTenant(ctx, "Org A");
    const token = await resetLinkFor(t.owner.email);
    expect((await setPassword(token, "a brand new password")).statusCode).toBe(204);
    const again = await setPassword(token, "another new password");
    expect(again.statusCode).toBe(404);
    expect(again.json().error).toBe("invalid_reset_link");
    await login(ctx.app, t.owner.email, "a brand new password");
  });

  it("spends every other open link once one is used", async () => {
    const t = await createTenant(ctx, "Org A");
    const first = await resetLinkFor(t.owner.email);
    ctx.now = new Date(ctx.now.getTime() + 16 * 60_000); // past the one-email window
    const second = await resetLinkFor(t.owner.email);
    expect(second).not.toBe(first);
    expect((await setPassword(second, "a brand new password")).statusCode).toBe(204);
    expect((await setPassword(first, "another new password")).statusCode).toBe(404);
  });

  it("expires after an hour", async () => {
    const t = await createTenant(ctx, "Org A");
    const token = await resetLinkFor(t.owner.email);
    ctx.now = new Date(ctx.now.getTime() + 60 * 60_000 + 1000);
    expect((await ctx.app.inject({ method: "GET", url: `/auth/password-reset/${token}` })).statusCode).toBe(404);
    expect((await setPassword(token, "a brand new password")).statusCode).toBe(404);
    await login(ctx.app, t.owner.email, PASSWORD);
  });

  it("refuses a tampered token and a short password", async () => {
    const t = await createTenant(ctx, "Org A");
    const token = await resetLinkFor(t.owner.email);
    const tampered = token.slice(0, 5) + (token[5] === "A" ? "B" : "A") + token.slice(6);
    expect((await setPassword(tampered, "a brand new password")).statusCode).toBe(404);
    expect((await setPassword(token, "short")).statusCode).toBe(422);
    // A refused short password does not spend the link.
    expect((await setPassword(token, "a brand new password")).statusCode).toBe(204);
  });

  it("rate-limits requests per address and sends at most one email per window", async () => {
    mail.delivered.clear();
    const t = await createTenant(ctx, "Org A");
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await requestReset(t.owner.email, "10.9.9.9")).statusCode);
    expect(codes.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(codes.slice(5)).toEqual([429, 429]);
    await runWorker(ctx);
    expect(resetEmails(t.owner.email)).toHaveLength(1);
  });
});

describe("deactivating a user", () => {
  it("ends their session on the next request and stops them signing in to that organization", async () => {
    const t = await createTenant(ctx, "Org A");
    const tech = await createUser(ctx.db, t.org.id, "technician");
    const techApi = client(ctx.app, await login(ctx.app, tech.email));
    expect((await techApi.get("/auth/me")).statusCode).toBe(200);

    expect((await t.api.post(`/users/${tech.id}/deactivate`, {})).statusCode).toBe(204);
    expect((await techApi.get("/auth/me")).statusCode).toBe(401);
    expect((await techApi.get("/route")).statusCode).toBe(401);
    await expect(login(ctx.app, tech.email)).rejects.toThrow(/401/);
    expect((await t.api.get("/users")).json().members.find((m: { userId: string }) => m.userId === tech.id).active).toBe(false);

    const sessions = await ctx.db.selectFrom("sessions").select("revokedAt").where("userId", "=", tech.id).execute();
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    const audit = await ctx.db.selectFrom("auditEvents").select("action").where("entityId", "=", tech.id).execute();
    expect(audit.map((a) => a.action)).toContain("user.deactivated");
  });

  it("leaves the person's other organizations alone", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const shared = await createUser(ctx.db, a.org.id, "technician");
    await ctx.db.insertInto("memberships").values({ organizationId: b.org.id, userId: shared.id, role: "office", technicianLicense: null }).execute();
    const inB = client(ctx.app, await login(ctx.app, shared.email, PASSWORD, b.org.id));
    await a.api.post(`/users/${shared.id}/deactivate`, {});
    expect((await inB.get("/auth/me")).json().organization.id).toBe(b.org.id);
    // Signing in now lands in the organization still open to them.
    expect((await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { email: shared.email, password: PASSWORD } })).json().organization.id).toBe(b.org.id);
  });

  it("can be undone by an owner", async () => {
    const t = await createTenant(ctx, "Org A");
    const tech = await createUser(ctx.db, t.org.id, "technician");
    await t.api.post(`/users/${tech.id}/deactivate`, {});
    // A deactivated person is brought back by reactivating, not by a new invitation.
    expect((await t.api.post("/invitations", { email: tech.email, role: "technician" })).json().error).toBe("deactivated_member");
    expect((await t.api.post(`/users/${tech.id}/reactivate`, {})).statusCode).toBe(204);
    await login(ctx.app, tech.email);
  });

  it("is for owners only, never on yourself, and never across organizations", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const office = await createUser(ctx.db, a.org.id, "office");
    const tech = await createUser(ctx.db, a.org.id, "technician");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    expect((await officeApi.post(`/users/${tech.id}/deactivate`, {})).statusCode).toBe(403);
    expect((await a.api.post(`/users/${a.owner.id}/deactivate`, {})).statusCode).toBe(422);
    expect((await b.api.post(`/users/${tech.id}/deactivate`, {})).statusCode).toBe(404);
    expect((await b.api.post(`/users/${tech.id}/reactivate`, {})).statusCode).toBe(404);
    await login(ctx.app, tech.email);
  });
});
