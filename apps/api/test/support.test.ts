import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminLogin, client, createAdmin, createOrg, createTenant, setupTestApp, type TestContext } from "./helpers.ts";

const ctx = setupTestApp();
const PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

async function openSupport(c: TestContext, organizationId: string, reason = "Customer called about a missing filing") {
  const admin = await adminLogin(c);
  const res = await c.app.inject({ method: "POST", url: `/admin/organizations/${organizationId}/support`, headers: { cookie: admin }, payload: { reason } });
  expect(res.statusCode, res.body).toBe(201);
  const cookie = res.cookies.find((k) => k.name === "aw_support_session")!;
  return { admin, support: `aw_support_session=${cookie.value}`, body: res.json() as { expiresAt: string } };
}

/** Every tenant write route the API has, from its OpenAPI description. */
async function writeRoutes(c: TestContext) {
  const spec = (await c.app.inject({ method: "GET", url: "/openapi.json" })).json() as { paths: Record<string, Record<string, unknown>> };
  const routes: { method: string; url: string }[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    if (path.startsWith("/admin/")) continue;
    const url = path.replace(/\{[^}]+\}/g, PLACEHOLDER);
    for (const method of Object.keys(methods)) if (!["get", "head", "options"].includes(method)) routes.push({ method: method.toUpperCase(), url });
  }
  return routes;
}

describe("read-only support access", () => {
  it("shows the company as its owner sees it, and says it is support", async () => {
    const t = await createTenant(ctx, "Org A");
    await createAdmin(ctx);
    const { support, body } = await openSupport(ctx, t.org.id);
    const api = client(ctx.app, support);
    const me = (await api.get("/auth/me")).json();
    expect(me).toMatchObject({ role: "owner", organization: { id: t.org.id }, user: { name: "Aerowise support (Founder)" }, support: { adminName: "Founder", expiresAt: body.expiresAt } });
    expect(me.organizations).toHaveLength(1);
    // The owner has not accepted the terms, but support is not asked to accept them for the owner (W8.3).
    expect(me.legalDue).toEqual([]);
    expect((await api.get("/customers")).json().items.map((c: { displayName: string }) => c.displayName)).toEqual(["Org A customer"]);
    expect((await api.get("/users")).statusCode).toBe(200);
    // The support view lasts an hour.
    expect(new Date(body.expiresAt).getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
  });

  it("audits the start in the platform log and in the company's own log", async () => {
    const t = await createTenant(ctx, "Org A");
    await createAdmin(ctx);
    await openSupport(ctx, t.org.id, "Checking an import");
    const platform = await ctx.db.selectFrom("platformAuditEvents").select(["action", "organizationId", "changes"]).where("action", "like", "support.%").execute();
    expect(platform).toEqual([{ action: "support.started", organizationId: t.org.id, changes: expect.objectContaining({ reason: "Checking an import" }) }]);
    const tenant = await ctx.db.selectFrom("auditEvents").select(["action", "actorUserId", "changes"]).where("organizationId", "=", t.org.id).where("action", "like", "support.%").execute();
    expect(tenant).toEqual([{ action: "support.started", actorUserId: null, changes: expect.objectContaining({ reason: "Checking an import" }) }]);
  });

  it("refuses every write and records each attempt", async () => {
    const t = await createTenant(ctx, "Org A");
    await createAdmin(ctx);
    const { support } = await openSupport(ctx, t.org.id);
    const before = await ctx.db.selectFrom("auditEvents").select((eb) => eb.fn.countAll<string>().as("n")).where("action", "not like", "support.%").executeTakeFirstOrThrow();

    let refused = 0;
    for (const route of await writeRoutes(ctx)) {
      const label = `${route.method} ${route.url}`;
      const send = (headers: Record<string, string>, payload: string | Buffer) =>
        ctx.app.inject({ method: route.method as "POST", url: route.url, headers, payload });
      // Public routes (sign-in, homeowner links, webhooks) are not tenant sessions; skip them.
      if ((await send({ "content-type": "application/json" }, "{}")).statusCode !== 401) continue;
      let res = await send({ cookie: support, "content-type": "application/json" }, "{}");
      if (res.statusCode === 415) res = await send({ cookie: support, "content-type": "image/png" }, Buffer.from([0x89, 0x50]));
      expect(res.statusCode, label).toBe(403);
      expect(res.json().error, label).toBe("support_read_only");
      refused++;
    }
    expect(refused).toBeGreaterThan(50);

    // The one GET that changes data is refused too.
    const callback = await client(ctx.app, support).get("/quickbooks/callback?code=x&realmId=1&state=y");
    expect(callback.json().error).toBe("support_read_only");

    const after = await ctx.db.selectFrom("auditEvents").select((eb) => eb.fn.countAll<string>().as("n")).where("action", "not like", "support.%").executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
    const attempts = await ctx.db.selectFrom("platformAuditEvents").select("action").where("action", "=", "support.write_refused").execute();
    expect(attempts).toHaveLength(refused + 1);
  });

  it("wins over a tenant sign-in in the same browser, so a write cannot slip through", async () => {
    const t = await createTenant(ctx, "Org A");
    await createAdmin(ctx);
    const { support } = await openSupport(ctx, t.org.id);
    const both = client(ctx.app, `${t.cookie}; ${support}`);
    expect((await both.post("/customers", { displayName: "Sneaky" })).json().error).toBe("support_read_only");
  });

  it("ends when the admin ends it, audited, and the cookie stops working", async () => {
    const t = await createTenant(ctx, "Org A");
    await createAdmin(ctx);
    const { admin, support } = await openSupport(ctx, t.org.id);
    const end = await ctx.app.inject({ method: "POST", url: "/admin/support/end", headers: { cookie: admin }, payload: {} });
    expect(end.statusCode).toBe(204);
    expect(end.cookies.find((k) => k.name === "aw_support_session")?.value).toBe("");
    expect((await client(ctx.app, support).get("/auth/me")).statusCode).toBe(401);
    const tenant = await ctx.db.selectFrom("auditEvents").select("action").where("organizationId", "=", t.org.id).where("action", "like", "support.%").orderBy("id").execute();
    expect(tenant.map((e) => e.action)).toEqual(["support.started", "support.ended"]);
    expect((await ctx.db.selectFrom("platformAuditEvents").select("action").where("action", "=", "support.ended").execute())).toHaveLength(1);
  });

  it("expires after an hour, and stops when the admin is deactivated", async () => {
    const t = await createTenant(ctx, "Org A");
    const founder = await createAdmin(ctx);
    const first = await openSupport(ctx, t.org.id);
    await sql`update support_sessions set started_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'`.execute(ctx.db);
    expect((await client(ctx.app, first.support).get("/auth/me")).statusCode).toBe(401);
    const second = await openSupport(ctx, t.org.id);
    await ctx.db.updateTable("platformAdmins").set({ active: false }).where("id", "=", founder.id).execute();
    expect((await client(ctx.app, second.support).get("/auth/me")).statusCode).toBe(401);
  });

  it("covers one company only, one at a time", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    await createAdmin(ctx);
    const inA = await openSupport(ctx, a.org.id);
    expect((await client(ctx.app, inA.support).get("/customers")).json().items.map((c: { displayName: string }) => c.displayName)).toEqual(["Org A customer"]);
    const bCustomer = (await b.api.get("/customers")).json().items[0];
    expect((await client(ctx.app, inA.support).get(`/customers/${bCustomer.id}`)).statusCode).toBe(404);
    // Opening B ends A.
    const inB = await openSupport(ctx, b.org.id);
    expect((await client(ctx.app, inA.support).get("/auth/me")).statusCode).toBe(401);
    expect((await client(ctx.app, inB.support).get("/auth/me")).json().organization.id).toBe(b.org.id);
    expect((await ctx.db.selectFrom("auditEvents").select("action").where("organizationId", "=", a.org.id).where("action", "=", "support.ended").execute())).toHaveLength(1);
  });

  it("is for platform admins only, and needs a company with an owner", async () => {
    const t = await createTenant(ctx, "Org A");
    expect((await t.api.post(`/admin/organizations/${t.org.id}/support`, { reason: "Looking around" })).statusCode).toBe(401);
    await createAdmin(ctx);
    const admin = client(ctx.app, await adminLogin(ctx));
    expect((await admin.post(`/admin/organizations/${PLACEHOLDER}/support`, { reason: "Looking around" })).statusCode).toBe(404);
    const empty = await createOrg(ctx.db, "No Owner Yet");
    expect((await admin.post(`/admin/organizations/${empty.id}/support`, { reason: "Looking around" })).json().error).toBe("no_owner");
    expect((await admin.post(`/admin/organizations/${t.org.id}/support`, { reason: "" })).statusCode).toBe(400);
  });
});
