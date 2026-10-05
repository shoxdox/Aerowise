import { createPlatformAdmin } from "@aerowise/db";
import { describe, expect, it } from "vitest";
import { subscriptionConfigFromEnv } from "../src/lib/subscription.ts";
import { client, createTenant, PASSWORD, setupTestApp, type TestContext } from "./helpers.ts";
import { payload, setup } from "./inspection-helpers.ts";

const ctx = setupTestApp();

async function adminApi(c: TestContext) {
  await createPlatformAdmin(c.db, { name: "Founder", email: "founder@example.com", password: PASSWORD });
  const res = await c.app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "founder@example.com", password: PASSWORD } });
  const cookie = res.cookies.find((k) => k.name === "aw_admin_session");
  if (!cookie) throw new Error(`admin login failed: ${res.statusCode}`);
  return client(c.app, `aw_admin_session=${cookie.value}`);
}

const plan = (state: string, endsOn: string | null = null, extra: Record<string, unknown> = {}) => ({
  state,
  startsOn: "2026-03-01",
  endsOn,
  pricePerContractCentsOverride: null,
  monthlyMinimumCentsOverride: null,
  ...extra,
});

describe("plans in /admin", () => {
  it("starts a new organization on a trial, or a design-partner period, from the configured lengths", async () => {
    const admin = await adminApi(ctx);
    // ctx.now is 2026-03-01 at noon in Texas.
    const trial = (await admin.post("/admin/organizations", { name: "Brazos Aerobic Co" })).json();
    expect(trial.plan).toEqual(plan("trial", "2026-03-31"));
    expect(trial.daysLeft).toBe(30);

    const partner = (await admin.post("/admin/organizations", { name: "Hill Country Septic", plan: "design_partner" })).json();
    expect(partner.plan).toMatchObject({ state: "design_partner", endsOn: "2026-05-30" });
    expect(partner.daysLeft).toBe(90);

    const created = await ctx.db.selectFrom("platformAuditEvents").select("changes").where("action", "=", "organization.created").execute();
    expect(created.map((e) => (e.changes as { plan: { state: string } }).plan.state).sort()).toEqual(["design_partner", "trial"]);

    const list = (await admin.get("/admin/organizations")).json();
    expect(list.defaults).toEqual({ trialDays: 30, designPartnerDays: 90, pricePerContractCents: 150, monthlyMinimumCents: 9900 });
    expect(list.items.map((o: { plan: { state: string } }) => o.plan.state)).toEqual(["trial", "design_partner"]);
  });

  it("changes state, dates and founder price, audited with before and after", async () => {
    const admin = await adminApi(ctx);
    const org = (await admin.post("/admin/organizations", { name: "Brazos Aerobic Co", plan: "design_partner" })).json();

    const founder = plan("design_partner", "2026-06-30", { pricePerContractCentsOverride: 100, monthlyMinimumCentsOverride: 4900 });
    const res = await admin.put(`/admin/organizations/${org.id}/plan`, founder);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: org.id, plan: founder, daysLeft: 121 });

    expect((await admin.put(`/admin/organizations/${org.id}/plan`, plan("active", null, { pricePerContractCentsOverride: 100 }))).statusCode).toBe(200);

    const events = await ctx.db
      .selectFrom("platformAuditEvents")
      .select(["organizationId", "changes"])
      .where("action", "=", "organization.plan_changed")
      .orderBy("id")
      .execute();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ organizationId: org.id, changes: { before: { state: "design_partner", endsOn: "2026-05-30" }, after: founder } });
    expect(events[1]?.changes).toMatchObject({ before: { state: "design_partner" }, after: { state: "active", pricePerContractCentsOverride: 100 } });
  });

  it("refuses changes the lifecycle does not allow and plans that do not add up", async () => {
    const admin = await adminApi(ctx);
    const org = (await admin.post("/admin/organizations", { name: "Brazos Aerobic Co" })).json();
    expect((await admin.put(`/admin/organizations/${org.id}/plan`, plan("active"))).statusCode).toBe(200);

    const back = await admin.put(`/admin/organizations/${org.id}/plan`, plan("trial", "2026-03-31"));
    expect(back.statusCode).toBe(422);
    expect(back.json().message).toBe("A plan cannot go from Active to Trial");
    // A free period needs an end; an end cannot come before the start.
    expect((await admin.put(`/admin/organizations/${org.id}/plan`, plan("read_only"))).statusCode).toBe(200);
    expect((await admin.put(`/admin/organizations/${org.id}/plan`, plan("trial", null))).statusCode).toBe(400);
    expect((await admin.put(`/admin/organizations/${org.id}/plan`, plan("trial", "2026-02-01"))).statusCode).toBe(400);
    expect((await admin.put(`/admin/organizations/${org.id}/plan`, plan("active", null, { pricePerContractCentsOverride: -5 }))).statusCode).toBe(400);
    expect((await admin.put("/admin/organizations/00000000-0000-4000-8000-000000000000/plan", plan("active"))).statusCode).toBe(404);

    const stored = await ctx.db.selectFrom("organizations").select("subscriptionState").where("id", "=", org.id).executeTakeFirstOrThrow();
    expect(stored.subscriptionState).toBe("read_only");
  });
});

describe("read-only organizations", () => {
  it("still see due inspections, filings, deadlines and records, and change nothing", async () => {
    const a = await setup(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const admin = await adminApi(ctx);
    expect((await admin.put(`/admin/organizations/${a.org.id}/plan`, plan("read_only"))).statusCode).toBe(200);

    expect((await a.api.get("/auth/me")).json().organization.subscription).toEqual({ state: "read_only", endsOn: null, readOnly: true });

    // Compliance-critical views and every record stay readable.
    const due = await a.api.get("/obligations/due");
    expect(due.statusCode).toBe(200);
    expect(due.json().total).toBeGreaterThan(0);
    for (const url of ["/filings", "/inbox", "/schedule?from=2026-03-01&to=2026-03-07", `/customers/${a.customer.id}`, `/contracts/${a.contract.id}`, "/invoices"]) {
      expect((await a.api.get(url)).statusCode, url).toBe(200);
    }
    expect((await a.techApi.get("/route")).statusCode).toBe(200);

    // Every write is refused with a clear reason, for every role.
    const refused = [
      await a.api.post("/customers", { displayName: "New customer" }),
      await a.api.patch(`/customers/${a.customer.id}`, { displayName: "Renamed" }),
      await a.api.post(`/contracts/${a.contract.id}/cancel`, { reason: "Moved away" }),
      await a.techApi.put("/inspections/sync", payload(a)),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "organization_read_only", message: expect.stringMatching(/read-only.*export/) });
    }
    const customer = await ctx.db.selectFrom("customers").select("displayName").where("id", "=", a.customer.id).executeTakeFirstOrThrow();
    expect(customer.displayName).toBe(a.customer.displayName);
    expect(await ctx.db.selectFrom("inspections").select("id").execute()).toHaveLength(0);

    // Signing out still works, and another organization is unaffected.
    expect((await ctx.app.inject({ method: "POST", url: "/auth/logout", payload: {}, headers: { cookie: a.cookie } })).statusCode).toBe(204);
    expect((await b.api.post("/customers", { displayName: "Org B customer 2" })).statusCode).toBe(201);
    expect((await b.api.get("/auth/me")).json().organization.subscription).toEqual({ state: "active", endsOn: null, readOnly: false });
  });

  it("can write again as soon as the plan is active", async () => {
    const a = await setup(ctx, "Org A");
    const admin = await adminApi(ctx);
    await admin.put(`/admin/organizations/${a.org.id}/plan`, plan("read_only"));
    expect((await a.techApi.put("/inspections/sync", payload(a))).statusCode).toBe(403);
    await admin.put(`/admin/organizations/${a.org.id}/plan`, plan("active"));
    expect((await a.techApi.put("/inspections/sync", payload(a))).statusCode).toBe(200);
  });

  it("does not refuse writes for trial, design-partner or past-due organizations", async () => {
    const a = await createTenant(ctx, "Org A");
    const admin = await adminApi(ctx);
    for (const p of [plan("past_due"), plan("read_only"), plan("trial", "2026-03-31"), plan("design_partner", "2026-05-30")]) {
      await admin.put(`/admin/organizations/${a.org.id}/plan`, p);
      const res = await a.api.post("/customers", { displayName: `Customer while ${p.state}` });
      expect(res.statusCode, p.state).toBe(p.state === "read_only" ? 403 : 201);
    }
  });
});

describe("subscription configuration", () => {
  it("reads prices and free-period lengths from the environment", () => {
    expect(subscriptionConfigFromEnv({})).toEqual({ trialDays: 30, designPartnerDays: 90, pricePerContractCents: 150, monthlyMinimumCents: 9900 });
    expect(subscriptionConfigFromEnv({ AEROWISE_TRIAL_DAYS: "14", AEROWISE_PRICE_PER_CONTRACT_CENTS: "200", AEROWISE_MONTHLY_MINIMUM_CENTS: "" })).toEqual({
      trialDays: 14,
      designPartnerDays: 90,
      pricePerContractCents: 200,
      monthlyMinimumCents: 9900,
    });
    expect(() => subscriptionConfigFromEnv({ AEROWISE_MONTHLY_MINIMUM_CENTS: "99.00" })).toThrow(/whole number/);
  });
});
