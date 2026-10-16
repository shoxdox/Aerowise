import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { client, createOrg, createUser, login, PASSWORD, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();

describe("sign in", () => {
  it("sets an httpOnly session cookie and returns the user's organization and role", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const user = await createUser(ctx.db, org.id, "office", { email: "Office@Example.com" });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "office@example.com", password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { id: user.id }, organization: { id: org.id }, role: "office" });
    const cookie = res.cookies.find((c) => c.name === "aw_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
  });

  it("stores only a hash of the session token", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const user = await createUser(ctx.db, org.id, "owner");
    const cookie = await login(ctx.app, user.email);
    const token = cookie.split("=")[1]!;
    const rows = await ctx.db.selectFrom("sessions").select("tokenHash").execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash.toString("base64url")).not.toBe(token);
  });

  it("rejects a wrong password, an unknown email and a deactivated user with the same error", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const active = await createUser(ctx.db, org.id, "office");
    const inactive = await createUser(ctx.db, org.id, "office", { active: false });
    for (const payload of [
      { email: active.email, password: "wrong" },
      { email: "nobody@example.com", password: PASSWORD },
      { email: inactive.email, password: PASSWORD },
    ]) {
      const res = await ctx.app.inject({ method: "POST", url: "/auth/login", payload });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_credentials");
    }
  });

  it("refuses users whose membership was removed", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const user = await createUser(ctx.db, org.id, "technician", { membershipActive: false });
    const res = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { email: user.email, password: PASSWORD } });
    expect(res.statusCode).toBe(401);
  });

  it("signs a user with two organizations into the one they ask for", async () => {
    const a = await createOrg(ctx.db, "Org A");
    const b = await createOrg(ctx.db, "Org B");
    const user = await createUser(ctx.db, a.id, "office");
    await ctx.db.insertInto("memberships").values({ organizationId: b.id, userId: user.id, role: "read_only", technicianLicense: null }).execute();
    const cookie = await login(ctx.app, user.email, PASSWORD, b.id);
    const me = (await client(ctx.app, cookie).get("/auth/me")).json();
    expect(me.organization.id).toBe(b.id);
    expect(me.role).toBe("read_only");
    expect(me.organizations).toHaveLength(2);
  });
});

describe("sessions", () => {
  it("requires a session for protected routes", async () => {
    const res = await client(ctx.app).get("/auth/me");
    expect(res.statusCode).toBe(401);
  });

  it("revokes the session on sign out", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const user = await createUser(ctx.db, org.id, "owner");
    const cookie = await login(ctx.app, user.email);
    const api = client(ctx.app, cookie);
    expect((await api.post("/auth/logout", {})).statusCode).toBe(204);
    expect((await api.get("/auth/me")).statusCode).toBe(401);
  });

  it("ends a phone's session from before a sign-out made with no signal, never one signed in since", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const user = await createUser(ctx.db, org.id, "technician");
    const old = client(ctx.app, await login(ctx.app, user.email));
    await sql`update sessions set created_at = now() - interval '1 hour' where user_id = ${user.id}`.execute(ctx.db);
    const signedOutAt = new Date(Date.now() - 60_000).toISOString();
    const since = client(ctx.app, await login(ctx.app, user.email));

    // Signed in again after it: kept, cookie and all.
    const kept = await since.post("/auth/logout", { signedInBefore: signedOutAt });
    expect(kept.statusCode).toBe(204);
    expect(kept.cookies.find((c) => c.name === "aw_session")).toBeUndefined();
    expect((await since.get("/auth/me")).statusCode).toBe(200);

    // Still the session from before it: ended.
    const ended = await old.post("/auth/logout", { signedInBefore: signedOutAt });
    expect(ended.statusCode).toBe(204);
    expect(ended.cookies.find((c) => c.name === "aw_session")?.value).toBe("");
    expect((await old.get("/auth/me")).statusCode).toBe(401);
    expect((await since.get("/auth/me")).statusCode).toBe(200);
  });

  it("rejects expired sessions", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const user = await createUser(ctx.db, org.id, "owner");
    const cookie = await login(ctx.app, user.email);
    await sql`update sessions set expires_at = now() - interval '1 second'`.execute(ctx.db);
    expect((await client(ctx.app, cookie).get("/auth/me")).statusCode).toBe(401);
  });

  it("cuts off a signed-in user as soon as they are deactivated", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const user = await createUser(ctx.db, org.id, "office");
    const cookie = await login(ctx.app, user.email);
    await ctx.db.updateTable("users").set({ active: false }).where("id", "=", user.id).execute();
    expect((await client(ctx.app, cookie).get("/customers")).statusCode).toBe(401);
  });

  it("rejects state-changing requests that are not JSON", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "email=a&password=b",
    });
    expect(res.statusCode).toBe(415);
  });
});

describe("sign-in rate limit", () => {
  it("blocks repeated attempts for the same email", async () => {
    const app = await buildApp({ db: ctx.db, loginRateLimit: 3 });
    const attempt = () =>
      app.inject({ method: "POST", url: "/auth/login", payload: { email: "victim@example.com", password: "guess" } });
    for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("rate_limited");
    await app.close();
  });

  it("counts each email separately, so one blocked email does not block everyone at the same address", async () => {
    const app = await buildApp({ db: ctx.db, loginRateLimit: 3 });
    const attempt = (email: string) => app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "guess" } });
    for (let i = 0; i < 4; i++) await attempt("victim@example.com");
    expect((await attempt("victim@example.com")).statusCode).toBe(429);
    expect((await attempt("colleague@example.com")).statusCode).toBe(401);
    await app.close();
  });
});
