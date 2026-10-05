import { createPlatformAdmin } from "@aerowise/db";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminLogin, client, createAdmin, createOrg, createTenant, createUser, login, PASSWORD, setupTestApp, type TestContext } from "./helpers.ts";

const ctx = setupTestApp();

/** Every guarded admin route, read from the API's own route table so new ones are covered too. */
async function adminRoutes(c: TestContext) {
  const spec = (await c.app.inject({ method: "GET", url: "/openapi.json" })).json() as { paths: Record<string, Record<string, unknown>> };
  const routes: { method: string; url: string }[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    if (!path.startsWith("/admin/") || path === "/admin/auth/login" || path === "/admin/auth/logout") continue;
    const url = path.replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000000");
    for (const method of Object.keys(methods)) routes.push({ method: method.toUpperCase(), url });
  }
  return routes;
}

describe("platform admin guard", () => {
  it("never lets a tenant owner reach an admin route", async () => {
    const t = await createTenant(ctx, "Org A");
    const routes = await adminRoutes(ctx);
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const route of routes) {
      const withTenantSession = await ctx.app.inject({ ...route, method: route.method as "GET", headers: { cookie: t.cookie }, payload: route.method === "GET" ? undefined : {} });
      expect(withTenantSession.statusCode, `${route.method} ${route.url}`).toBe(401);
      // A tenant token presented as an admin cookie is not an admin session either.
      const token = t.cookie.split("=")[1];
      const smuggled = await ctx.app.inject({
        ...route,
        method: route.method as "GET",
        headers: { cookie: `aw_admin_session=${token}` },
        payload: route.method === "GET" ? undefined : {},
      });
      expect(smuggled.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it("does not sign a tenant user into the console with their own password", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const owner = await createUser(ctx.db, org.id, "owner");
    const res = await ctx.app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: owner.email, password: PASSWORD } });
    expect(res.statusCode).toBe(401);
  });

  it("does not let an admin session reach tenant routes", async () => {
    await createAdmin(ctx);
    const cookie = await adminLogin(ctx);
    const token = cookie.split("=")[1];
    expect((await client(ctx.app, cookie).get("/auth/me")).statusCode).toBe(401);
    expect((await client(ctx.app, `aw_session=${token}`).get("/customers")).statusCode).toBe(401);
  });

  it("refuses wrong passwords, deactivated admins and signed-out sessions", async () => {
    const admin = await createAdmin(ctx);
    const bad = await ctx.app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: admin.email, password: "nope" } });
    expect(bad.statusCode).toBe(401);

    const cookie = await adminLogin(ctx);
    const api = client(ctx.app, cookie);
    expect((await api.get("/admin/auth/me")).json()).toMatchObject({ email: "founder@example.com", name: "Founder" });

    await ctx.app.inject({ method: "POST", url: "/admin/auth/logout", payload: {}, headers: { cookie } });
    expect((await api.get("/admin/auth/me")).statusCode).toBe(401);

    const again = await adminLogin(ctx);
    await ctx.db.updateTable("platformAdmins").set({ active: false }).where("id", "=", admin.id).execute();
    expect((await client(ctx.app, again).get("/admin/organizations")).statusCode).toBe(401);
    const blocked = await ctx.app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: admin.email, password: PASSWORD } });
    expect(blocked.statusCode).toBe(401);
  });
});

describe("admin console", () => {
  it("creates an organization and audits it", async () => {
    const admin = await createAdmin(ctx);
    const api = client(ctx.app, await adminLogin(ctx));
    const res = await api.post("/admin/organizations", { name: "Brazos Aerobic Co", phone: "(979) 555-0100" });
    expect(res.statusCode).toBe(201);
    const org = res.json();
    expect(org).toMatchObject({ name: "Brazos Aerobic Co", timezone: "America/Chicago", activeContracts: 0, users: 0, lastActivityAt: null });

    const stored = await ctx.db.selectFrom("organizations").selectAll().where("id", "=", org.id).executeTakeFirstOrThrow();
    expect(stored.phone).toBe("(979) 555-0100");

    const events = await ctx.db.selectFrom("platformAuditEvents").selectAll().orderBy("id").execute();
    expect(events.map((e) => e.action)).toEqual(["admin.signed_in", "organization.created"]);
    expect(events[1]).toMatchObject({ adminId: admin.id, organizationId: org.id, entityType: "organization", entityId: org.id });
    expect(events[1]?.changes).toMatchObject({ name: "Brazos Aerobic Co" });
  });

  it("validates new organizations", async () => {
    await createAdmin(ctx);
    const api = client(ctx.app, await adminLogin(ctx));
    expect((await api.post("/admin/organizations", { name: "" })).statusCode).toBe(400);
    expect((await api.post("/admin/organizations", { name: "X", timezone: "Mars/Olympus" })).statusCode).toBe(400);
    expect(await ctx.db.selectFrom("organizations").select("id").execute()).toHaveLength(0);
  });

  it("lists organizations with active contracts, users and last activity", async () => {
    const a = await createTenant(ctx, "Org A");
    await createUser(ctx.db, a.org.id, "technician");
    await createUser(ctx.db, a.org.id, "office", { membershipActive: false });
    await createUser(ctx.db, a.org.id, "office", { active: false });
    const plan = (await a.api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
    // ctx.now is 2026-03-01: one contract in force, one that ended, one cancelled.
    const site2 = (await a.api.post(`/customers/${a.customer.id}/sites`, { addressLine1: "2 Main St", city: "Austin" })).json();
    const site3 = (await a.api.post(`/customers/${a.customer.id}/sites`, { addressLine1: "3 Main St", city: "Austin" })).json();
    expect((await a.api.post(`/sites/${a.site.id}/contracts`, { planId: plan.id, startOn: "2026-01-15" })).statusCode).toBe(201);
    expect((await a.api.post(`/sites/${site2.id}/contracts`, { planId: plan.id, startOn: "2024-06-01" })).statusCode).toBe(201);
    const cancelled = (await a.api.post(`/sites/${site3.id}/contracts`, { planId: plan.id, startOn: "2026-02-01" })).json();
    expect((await a.api.post(`/contracts/${cancelled.id}/cancel`, { reason: "Moved away" })).statusCode).toBeLessThan(300);

    const b = await createOrg(ctx.db, "Org B");

    await createAdmin(ctx);
    const items = (await client(ctx.app, await adminLogin(ctx)).get("/admin/organizations")).json().items;
    expect(items.map((o: { name: string }) => o.name)).toEqual(["Org A", "Org B"]);
    const [orgA, orgB] = items;
    expect(orgA).toMatchObject({ id: a.org.id, activeContracts: 1, users: 2 });
    expect(orgA.lastActivityAt).not.toBeNull();
    expect(orgB).toMatchObject({ id: b.id, activeContracts: 0, users: 0, lastActivityAt: null });
  });

  it("keeps the platform audit log append-only", async () => {
    await createAdmin(ctx);
    await adminLogin(ctx);
    await expect(sql`delete from platform_audit_events`.execute(ctx.db)).rejects.toThrow(/append-only/);
    await expect(sql`update platform_audit_events set action = 'x'`.execute(ctx.db)).rejects.toThrow(/append-only/);
  });
});

describe("createPlatformAdmin (the CLI command)", () => {
  it("rejects short passwords, bad emails and duplicates", async () => {
    await expect(createPlatformAdmin(ctx.db, { name: "A", email: "a@example.com", password: "short" })).rejects.toThrow(/at least 12/);
    await expect(createPlatformAdmin(ctx.db, { name: "A", email: "not-an-email", password: PASSWORD })).rejects.toThrow(/not an email/);
    await createPlatformAdmin(ctx.db, { name: "A", email: "a@example.com", password: PASSWORD });
    await expect(createPlatformAdmin(ctx.db, { name: "B", email: "A@Example.com", password: PASSWORD })).rejects.toThrow(/already exists/);
  });

  it("creates an admin who has no tenant membership", async () => {
    const admin = await createAdmin(ctx);
    expect(await ctx.db.selectFrom("users").select("id").where("email", "=", admin.email).execute()).toHaveLength(0);
    expect(await login(ctx.app, admin.email).catch((e: Error) => e.message)).toMatch(/401/);
  });
});
