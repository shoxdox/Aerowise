import { runMonthlyBilling, TestBillingProvider } from "@aerowise/billing";
import { createPlatformAdmin } from "@aerowise/db";
import { describe, expect, it } from "vitest";
import { DEFAULT_SUBSCRIPTION_CONFIG, subscriptionConfigFromEnv } from "@aerowise/domain";
import { client, createTenant, createUser, login, PASSWORD, setupTestApp, type TestContext } from "./helpers.ts";
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
    expect(list.defaults).toEqual({ trialDays: 30, designPartnerDays: 90, pricePerContractCents: 150, monthlyMinimumCents: 9900, pastDueGraceDays: 14 });
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
    expect(subscriptionConfigFromEnv({})).toEqual({ trialDays: 30, designPartnerDays: 90, pricePerContractCents: 150, monthlyMinimumCents: 9900, pastDueGraceDays: 14 });
    expect(
      subscriptionConfigFromEnv({ AEROWISE_TRIAL_DAYS: "14", AEROWISE_PRICE_PER_CONTRACT_CENTS: "200", AEROWISE_MONTHLY_MINIMUM_CENTS: "", AEROWISE_PAST_DUE_GRACE_DAYS: "7" }),
    ).toEqual({
      trialDays: 14,
      designPartnerDays: 90,
      pricePerContractCents: 200,
      monthlyMinimumCents: 9900,
      pastDueGraceDays: 7,
    });
    expect(() => subscriptionConfigFromEnv({ AEROWISE_MONTHLY_MINIMUM_CENTS: "99.00" })).toThrow(/whole number/);
  });
});

describe("owner subscription page", () => {
  it("shows the plan, days left and what the company will pay at today's count", async () => {
    // One contract in force (setup's), on a trial with 30 days left and a founder minimum.
    const a = await setup(ctx, "Org A");
    const admin = await adminApi(ctx);
    // Test organizations start active; a new free period is given from read-only.
    await admin.put(`/admin/organizations/${a.org.id}/plan`, plan("read_only"));
    expect((await admin.put(`/admin/organizations/${a.org.id}/plan`, plan("trial", "2026-03-31", { monthlyMinimumCentsOverride: 4900 }))).statusCode).toBe(200);

    const res = await a.api.get("/subscription");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      plan: { state: "trial", startsOn: "2026-03-01", endsOn: "2026-03-31", daysLeft: 30, readOnly: false },
      price: { pricePerContractCents: 150, monthlyMinimumCents: 4900, founder: true },
      estimate: { countedOn: "2026-03-01", activeContracts: 1, amountCents: 4900, charged: false },
      paymentMethod: null,
      provider: "test",
      invoices: [],
    });
  });

  it("is the owner's alone", async () => {
    const a = await createTenant(ctx, "Org A");
    for (const role of ["office", "technician", "read_only"] as const) {
      const user = await createUser(ctx.db, a.org.id, role);
      const api = client(ctx.app, await login(ctx.app, user.email));
      expect((await api.get("/subscription")).statusCode, role).toBe(403);
      expect((await api.post("/subscription/payment-method", {})).statusCode, role).toBe(403);
    }
  });

  it("saves a payment method through Stripe and shows it", async () => {
    const a = await createTenant(ctx, "Org A");
    const res = await a.api.post("/subscription/payment-method", {});
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe("http://localhost:3000/settings/subscription?payment=test");

    const org = await ctx.db.selectFrom("organizations").select("billingCustomerId").where("id", "=", a.org.id).executeTakeFirstOrThrow();
    expect(org.billingCustomerId).toMatch(/^cus_test_/);
    expect((await a.api.get("/subscription")).json().paymentMethod).toEqual({ label: "Visa", last4: "4242", expires: "12/2034" });
    // A second visit reuses the same Stripe customer.
    await a.api.post("/subscription/payment-method", {});
    const again = await ctx.db.selectFrom("organizations").select("billingCustomerId").where("id", "=", a.org.id).executeTakeFirstOrThrow();
    expect(again.billingCustomerId).toBe(org.billingCustomerId);
    const events = await ctx.db.selectFrom("auditEvents").select("action").where("action", "=", "subscription.payment_method_opened").execute();
    expect(events).toHaveLength(2);
  });

  it("lets a read-only company add a payment method, and nothing else", async () => {
    const a = await createTenant(ctx, "Org A");
    const admin = await adminApi(ctx);
    await admin.put(`/admin/organizations/${a.org.id}/plan`, plan("read_only"));
    expect((await a.api.post("/subscription/payment-method", {})).statusCode).toBe(200);
    expect((await a.api.post("/customers", { displayName: "New" })).statusCode).toBe(403);
    const overview = (await a.api.get("/subscription")).json();
    expect(overview.plan).toMatchObject({ state: "read_only", readOnly: true });
    expect(overview.estimate.charged).toBe(false);
  });

  it("lists the company's own invoices with the count each one used", async () => {
    const a = await setup(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const provider = new TestBillingProvider();
    await runMonthlyBilling(ctx.db, { provider, config: DEFAULT_SUBSCRIPTION_CONFIG, now: ctx.now }, a.org.id);

    const invoices = (await a.api.get("/subscription")).json().invoices;
    expect(invoices).toEqual([
      {
        id: expect.any(String),
        startsOn: "2026-03-01",
        endsOn: "2026-03-31",
        activeContracts: 1,
        pricePerContractCents: 150,
        monthlyMinimumCents: 9900,
        amountCents: 9900,
        status: "open",
        hostedInvoiceUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.test\//),
      },
    ]);
    expect((await b.api.get("/subscription")).json().invoices).toEqual([]);
  });
});
