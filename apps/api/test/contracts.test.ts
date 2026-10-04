import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";

const ctx = setupTestApp();

const ANNUAL = { name: "Residential annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 };

async function tenantWithPlan(c: TestContext, name = "Org A") {
  const t = await createTenant(c, name);
  const plan = (await t.api.post("/plans", ANNUAL)).json();
  return { ...t, plan };
}

describe("plans", () => {
  it("creates a plan with sensible defaults", async () => {
    const t = await tenantWithPlan(ctx);
    expect(t.plan).toMatchObject({ ...ANNUAL, customerType: "residential", billingFrequency: "annual", active: true });
  });

  it("rejects visit counts that do not split the term into whole months", async () => {
    const t = await createTenant(ctx, "Org A");
    expect((await t.api.post("/plans", { ...ANNUAL, visitsPerTerm: 5 })).statusCode).toBe(400);
    const plan = (await t.api.post("/plans", ANNUAL)).json();
    expect((await t.api.patch(`/plans/${plan.id}`, { visitsPerTerm: 5 })).statusCode).toBe(422);
  });
});

// Acceptance test: an annual contract creates the expected recurring obligations.
describe("annual contract", () => {
  it("generates three inspection visits with windows and due dates", async () => {
    const t = await tenantWithPlan(ctx);
    const res = await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-01-15" });
    expect(res.statusCode).toBe(201);
    const contract = res.json();
    expect(contract).toMatchObject({
      siteId: t.site.id,
      planName: "Residential annual",
      startOn: "2026-01-15",
      endOn: "2027-01-14",
      priceCents: 27500,
      state: "active",
      renewalStatus: "not_started",
    });
    expect(contract.obligations.map((o: Record<string, unknown>) => [o.sequence, o.windowStart, o.dueOn, o.status])).toEqual([
      [1, "2026-01-15", "2026-05-14", "open"],
      [2, "2026-05-15", "2026-09-14", "open"],
      [3, "2026-09-15", "2027-01-14", "open"],
    ]);
  });

  it("keeps its own terms when the plan is edited later", async () => {
    const t = await tenantWithPlan(ctx);
    const contract = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-01-15" })).json();
    await t.api.patch(`/plans/${t.plan.id}`, { priceCents: 99900, name: "Renamed" });
    const after = (await t.api.get(`/contracts/${contract.id}`)).json();
    expect(after).toMatchObject({ priceCents: 27500, planName: "Residential annual" });
  });

  it("allows a negotiated price", async () => {
    const t = await tenantWithPlan(ctx);
    const res = await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-01-15", priceCents: 20000 });
    expect(res.json().priceCents).toBe(20000);
  });

  it("refuses a second contract that overlaps the first on the same site", async () => {
    const t = await tenantWithPlan(ctx);
    await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-01-15" });
    const res = await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-06-01" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("overlapping_contract");
  });

  it("refuses inactive plans and inactive sites", async () => {
    const t = await tenantWithPlan(ctx);
    await t.api.patch(`/plans/${t.plan.id}`, { active: false });
    expect((await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-01-15" })).statusCode).toBe(422);
    const active = (await t.api.post("/plans", ANNUAL)).json();
    await t.api.patch(`/sites/${t.site.id}`, { active: false });
    expect((await t.api.post(`/sites/${t.site.id}/contracts`, { planId: active.id, startOn: "2026-01-15" })).statusCode).toBe(422);
  });

  it("derives upcoming, active and expired from today's date", async () => {
    const t = await tenantWithPlan(ctx);
    const contract = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-04-01" })).json();
    expect(contract.state).toBe("upcoming");
    ctx.now = new Date("2026-04-01T12:00:00Z");
    expect((await t.api.get(`/contracts/${contract.id}`)).json().state).toBe("active");
    ctx.now = new Date("2027-04-01T12:00:00Z");
    expect((await t.api.get(`/contracts/${contract.id}`)).json().state).toBe("expired");
  });

  it("uses the organization's timezone for today", async () => {
    const t = await tenantWithPlan(ctx);
    const contract = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-04-01" })).json();
    // 03:00 UTC on April 1 is still March 31 in Texas.
    ctx.now = new Date("2026-04-01T03:00:00Z");
    expect((await t.api.get(`/contracts/${contract.id}`)).json().state).toBe("upcoming");
  });
});

// Acceptance test: renewal creates a new term without corrupting history.
describe("renewal", () => {
  it("creates the next term starting the day after, leaving the old contract untouched", async () => {
    const t = await tenantWithPlan(ctx);
    const first = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-01-15" })).json();
    const res = await t.api.post(`/contracts/${first.id}/renew`, { priceCents: 29500 });
    expect(res.statusCode).toBe(201);
    const next = res.json();
    expect(next).toMatchObject({ startOn: "2027-01-15", endOn: "2028-01-14", priceCents: 29500, previousContractId: first.id });
    expect(next.obligations).toHaveLength(3);
    expect(next.obligations[0].dueOn).toBe("2027-05-14");

    const old = (await t.api.get(`/contracts/${first.id}`)).json();
    expect(old).toEqual({ ...first, renewedById: next.id });
  });

  it("can switch plans at renewal", async () => {
    const t = await tenantWithPlan(ctx);
    const twoYear = (await t.api.post("/plans", { name: "Two-year", termMonths: 24, visitsPerTerm: 6, priceCents: 50000 })).json();
    const first = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-01-15" })).json();
    const next = (await t.api.post(`/contracts/${first.id}/renew`, { planId: twoYear.id })).json();
    expect(next).toMatchObject({ planName: "Two-year", endOn: "2029-01-14", priceCents: 50000 });
    expect(next.obligations).toHaveLength(6);
  });

  it("renews a contract only once, and never a cancelled one", async () => {
    const t = await tenantWithPlan(ctx);
    const first = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-01-15" })).json();
    await t.api.post(`/contracts/${first.id}/renew`, {});
    const again = await t.api.post(`/contracts/${first.id}/renew`, {});
    expect(again.statusCode).toBe(409);

    const other = await createTenant(ctx, "Org C");
    const plan = (await other.api.post("/plans", ANNUAL)).json();
    const c = (await other.api.post(`/sites/${other.site.id}/contracts`, { planId: plan.id, startOn: "2026-01-15" })).json();
    await other.api.post(`/contracts/${c.id}/cancel`, { reason: "Sold the house" });
    expect((await other.api.post(`/contracts/${c.id}/renew`, {})).statusCode).toBe(422);
  });
});

describe("cancellation", () => {
  it("cancels open visits but keeps the record and reason", async () => {
    const t = await tenantWithPlan(ctx);
    const c = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-01-15" })).json();
    const res = await t.api.post(`/contracts/${c.id}/cancel`, { reason: "Customer moved" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "cancelled", cancelReason: "Customer moved" });
    expect(res.json().obligations.every((o: { status: string }) => o.status === "cancelled")).toBe(true);
    expect((await t.api.post(`/contracts/${c.id}/cancel`, { reason: "again" })).statusCode).toBe(409);
    // The site is free for a new contract over the same dates.
    expect((await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-02-01" })).statusCode).toBe(201);
  });
});

describe("due inspections", () => {
  it("lists open visits due by a date, overdue first", async () => {
    const t = await tenantWithPlan(ctx);
    // Today is 2026-03-01.
    await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2025-10-01" });
    const second = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "2 Oak", city: "Wimberley" })).json();
    await t.api.post(`/sites/${second.id}/contracts`, { planId: t.plan.id, startOn: "2026-03-20" });

    const all = (await t.api.get("/obligations/due?through=2026-07-31")).json();
    expect(all.today).toBe("2026-03-01");
    type Row = { site: { id: string }; sequence: number; overdue: boolean; dueOn: string };
    expect(all.items.map((o: Row) => [o.site.id, o.sequence, o.overdue, o.dueOn])).toEqual([
      [t.site.id, 1, true, "2026-01-31"],
      [t.site.id, 2, false, "2026-05-31"],
      [second.id, 1, false, "2026-07-19"],
    ]);
    expect(all.items[0]).toMatchObject({ customer: { displayName: "Org A customer" }, site: { addressLine1: "1 Main St" } });

    // The default looks 30 days ahead, which here leaves only the overdue visit.
    expect((await t.api.get("/obligations/due")).json().items).toHaveLength(1);
    expect((await t.api.get("/obligations/due?through=2026-06-30")).json().items).toHaveLength(2);
    expect((await t.api.get("/obligations/due?through=2026-07-31&overdueOnly=true")).json().items).toHaveLength(1);
    expect((await t.api.get("/obligations/due?through=2026-07-31&overdueOnly=false")).json().items).toHaveLength(3);
  });

  it("leaves out cancelled contracts", async () => {
    const t = await tenantWithPlan(ctx);
    const c = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2025-10-01" })).json();
    expect((await t.api.get("/obligations/due")).json().items).toHaveLength(1);
    await t.api.post(`/contracts/${c.id}/cancel`, { reason: "x" });
    expect((await t.api.get("/obligations/due")).json().items).toHaveLength(0);
  });
});

describe("contracts and tenancy", () => {
  it("keeps plans, contracts and due visits inside their organization", async () => {
    const a = await tenantWithPlan(ctx, "Org A");
    const b = await tenantWithPlan(ctx, "Org B");
    const bContract = (await b.api.post(`/sites/${b.site.id}/contracts`, { planId: b.plan.id, startOn: "2026-01-01" })).json();

    expect((await a.api.get("/plans")).json().items.map((p: { id: string }) => p.id)).toEqual([a.plan.id]);
    expect((await b.api.get("/obligations/due?through=2026-12-31")).json().items.length).toBeGreaterThan(0);
    expect((await a.api.get("/obligations/due?through=2026-12-31")).json().items).toHaveLength(0);
    expect((await a.api.get(`/contracts/${bContract.id}`)).statusCode).toBe(404);
    expect((await a.api.get(`/sites/${b.site.id}/contracts`)).statusCode).toBe(404);
    expect((await a.api.patch(`/plans/${b.plan.id}`, { name: "x" })).statusCode).toBe(404);
    expect((await a.api.post(`/contracts/${bContract.id}/renew`, {})).statusCode).toBe(404);
    expect((await a.api.post(`/contracts/${bContract.id}/cancel`, { reason: "x" })).statusCode).toBe(404);
    // Neither B's site nor B's plan can be used from A.
    expect((await a.api.post(`/sites/${b.site.id}/contracts`, { planId: a.plan.id, startOn: "2026-01-01" })).statusCode).toBe(404);
    expect((await a.api.post(`/sites/${a.site.id}/contracts`, { planId: b.plan.id, startOn: "2026-01-01" })).statusCode).toBe(422);
    expect((await b.api.get(`/contracts/${bContract.id}`)).json().state).toBe("active");
  });

  it("lets technicians see contracts and due visits but not change them", async () => {
    const t = await tenantWithPlan(ctx);
    const c = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2026-01-01" })).json();
    const tech = await createUser(ctx.db, t.org.id, "technician");
    const api = client(ctx.app, await login(ctx.app, tech.email));
    expect((await api.get("/obligations/due")).statusCode).toBe(200);
    expect((await api.get(`/contracts/${c.id}`)).statusCode).toBe(200);
    expect((await api.post("/plans", ANNUAL)).statusCode).toBe(403);
    expect((await api.post(`/sites/${t.site.id}/contracts`, { planId: t.plan.id, startOn: "2027-06-01" })).statusCode).toBe(403);
    expect((await api.post(`/contracts/${c.id}/renew`, {})).statusCode).toBe(403);
    expect((await api.post(`/contracts/${c.id}/cancel`, { reason: "x" })).statusCode).toBe(403);
  });
});
