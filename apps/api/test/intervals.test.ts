import { fileURLToPath } from "node:url";
import { bundledRulesets, syncRulesets } from "@aerowise/compliance";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

const ctx = setupTestApp();

// Fictional authorities with other service intervals: one quarterly, one with the 4-month
// default for residential systems and monthly visits for commercial ones.
const FIXTURES = bundledRulesets(fileURLToPath(new URL("./fixtures/rulesets", import.meta.url)));
const QUARTERLY = "Quarterly Fixture County";
const COMMERCIAL_MONTHLY = "Commercial Monthly Fixture County";

beforeEach(async () => {
  await syncRulesets(ctx.db, FIXTURES);
});

// Other test files list the authorities, so leave only the bundled ones behind.
afterAll(async () => {
  await sql`truncate jurisdiction_rulesets, jurisdictions cascade`.execute(ctx.db);
  await syncRulesets(ctx.db);
});

async function tenantIn(c: TestContext, county: string | null, customerType: "residential" | "commercial" = "residential") {
  const t = await createTenant(c, "Org A");
  if (county) expect((await t.api.patch(`/sites/${t.site.id}`, { county })).statusCode).toBe(200);
  // "Commercial" is set on the site (Justin, 2026-10-05); the plan's type is only a label.
  if (customerType === "commercial") expect((await t.api.patch(`/sites/${t.site.id}`, { customerType })).json()).toMatchObject({ customerType });
  const plan = async (customerType: "residential" | "commercial", termMonths = 12, visitsPerTerm = 3) =>
    (await t.api.post("/plans", { name: `${customerType} ${termMonths}/${visitsPerTerm}`, customerType, termMonths, visitsPerTerm, priceCents: 27500 })).json();
  return { ...t, plan };
}

/**
 * Creates a contract the way the office does: look at the visits the site's authority needs
 * and, if that is more than the plan has, agree to them (the office is warned first).
 */
async function agreed(t: { api: ReturnType<typeof client>; site: { id: string } }, body: { planId: string; startOn: string }) {
  const preview = (await t.api.get(`/sites/${t.site.id}/contract-terms?planId=${body.planId}&startOn=${body.startOn}`)).json();
  return t.api.post(`/sites/${t.site.id}/contracts`, { ...body, acceptVisits: preview.warning ? preview.visitsPerTerm : undefined });
}

type Visit = { sequence: number; windowStart: string; dueOn: string };
const windows = (contract: { obligations: Visit[] }) => contract.obligations.map((o) => [o.sequence, o.windowStart, o.dueOn]);

describe("contract visits follow the site's ruleset interval", () => {
  it("keeps the plan's visits under the 4-month default", async () => {
    const t = await tenantIn(ctx, "Example County");
    for (const [term, visits] of [[12, 3], [24, 6]] as const) {
      const plan = await t.plan("residential", term, visits);
      const contract = (await agreed(t, { planId: plan.id, startOn: term === 12 ? "2026-01-15" : "2027-01-15" })).json();
      expect(contract).toMatchObject({ termMonths: term, visitsPerTerm: visits, customerType: "residential" });
    }
  });

  it("schedules quarterly visits where the authority requires them", async () => {
    const t = await tenantIn(ctx, QUARTERLY);
    const plan = await t.plan("residential");
    const res = await agreed(t, { planId: plan.id, startOn: "2026-01-15" });
    expect(res.statusCode).toBe(201);
    const contract = res.json();
    expect(contract).toMatchObject({ termMonths: 12, visitsPerTerm: 4, endOn: "2027-01-14", priceCents: 27500 });
    expect(windows(contract)).toEqual([
      [1, "2026-01-15", "2026-04-14"],
      [2, "2026-04-15", "2026-07-14"],
      [3, "2026-07-15", "2026-10-14"],
      [4, "2026-10-15", "2027-01-14"],
    ]);
  });

  it("schedules monthly visits for a commercial site under a monthly commercial rule", async () => {
    const t = await tenantIn(ctx, COMMERCIAL_MONTHLY, "commercial");
    const plan = await t.plan("commercial");
    const contract = (await agreed(t, { planId: plan.id, startOn: "2026-01-31" })).json();
    expect(contract).toMatchObject({ customerType: "commercial", visitsPerTerm: 12, endOn: "2027-01-30" });
    expect(windows(contract).slice(0, 3)).toEqual([
      [1, "2026-01-31", "2026-02-27"],
      [2, "2026-02-28", "2026-03-30"],
      [3, "2026-03-31", "2026-04-29"],
    ]);
    expect(windows(contract).at(-1)).toEqual([12, "2026-12-31", "2027-01-30"]);

    // The renewal follows the site's type, so it is monthly too.
    const renewed = (await t.api.post(`/contracts/${contract.id}/renew`, {})).json();
    expect(renewed).toMatchObject({ customerType: "commercial", visitsPerTerm: 12, startOn: "2027-01-31" });
  });

  it("keeps a residential site under that rule on the 4-month default", async () => {
    const t = await tenantIn(ctx, COMMERCIAL_MONTHLY);
    const plan = await t.plan("residential");
    const contract = (await agreed(t, { planId: plan.id, startOn: "2026-01-15" })).json();
    expect(contract).toMatchObject({ customerType: "residential", visitsPerTerm: 3 });
  });

  it("goes by the site's type, not the plan's", async () => {
    const t = await tenantIn(ctx, COMMERCIAL_MONTHLY);
    const commercialPlan = await t.plan("commercial");
    expect((await agreed(t, { planId: commercialPlan.id, startOn: "2026-01-15" })).json()).toMatchObject({ customerType: "residential", visitsPerTerm: 3 });
    const u = await tenantIn(ctx, COMMERCIAL_MONTHLY, "commercial");
    const residentialPlan = await u.plan("residential");
    expect((await agreed(u, { planId: residentialPlan.id, startOn: "2026-01-15" })).json()).toMatchObject({ customerType: "commercial", visitsPerTerm: 12 });
  });

  it("keeps a plan that already visits often enough, and a site with no authority", async () => {
    const t = await tenantIn(ctx, QUARTERLY);
    const monthly = await t.plan("residential", 12, 12);
    expect((await agreed(t, { planId: monthly.id, startOn: "2026-01-15" })).json().visitsPerTerm).toBe(12);

    const u = await tenantIn(ctx, null, "commercial");
    const plan = await u.plan("commercial");
    expect((await agreed(u, { planId: plan.id, startOn: "2026-01-15" })).json().visitsPerTerm).toBe(3);
  });

  it("follows the rules in force when the contract starts, not when it was created", async () => {
    // A quarterly rule that only takes effect in 2027 does not change a 2026 contract.
    const [quarterly] = FIXTURES.filter((r) => r.jurisdiction.key === "tx-fixture-quarterly");
    const later = { ...quarterly!, jurisdiction: { ...quarterly!.jurisdiction, key: "tx-fixture-quarterly-2027" }, effectiveFrom: "2027-01-01", applicability: { counties: ["Later Fixture County"] } };
    await syncRulesets(ctx.db, [later]);
    const t = await tenantIn(ctx, "Later Fixture County");
    const plan = await t.plan("residential");
    expect((await agreed(t, { planId: plan.id, startOn: "2026-01-15" })).json().visitsPerTerm).toBe(3);
    expect((await agreed(t, { planId: plan.id, startOn: "2027-01-15" })).json().visitsPerTerm).toBe(4);
  });
});

describe("the office is warned before visits are added", () => {
  it("refuses a contract with fewer visits than the authority needs until the office agrees to the count", async () => {
    const t = await tenantIn(ctx, QUARTERLY);
    const plan = await t.plan("residential");
    const preview = (await t.api.get(`/sites/${t.site.id}/contract-terms?planId=${plan.id}&startOn=2026-01-15`)).json();
    expect(preview).toEqual({
      planVisits: 3,
      visitsPerTerm: 4,
      warning: "Quarterly Fixture County (fictional) requires an inspection at least every 3 months, so this contract needs 4 visits instead of the plan's 3, at the same price. Create it with 4 visits?",
    });

    const body = { planId: plan.id, startOn: "2026-01-15" };
    const refused = await t.api.post(`/sites/${t.site.id}/contracts`, body);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "more_visits_required", message: preview.warning });
    expect((await t.api.post(`/sites/${t.site.id}/contracts`, { ...body, acceptVisits: 3 })).statusCode).toBe(409);
    expect((await t.api.get(`/sites/${t.site.id}/contracts`)).json().items).toHaveLength(0);

    const created = await t.api.post(`/sites/${t.site.id}/contracts`, { ...body, acceptVisits: 4 });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ visitsPerTerm: 4, priceCents: 27500 });

    // Renewing onto a plan with too few visits asks again; renewing as is keeps the agreed visits.
    expect((await t.api.post(`/contracts/${created.json().id}/renew`, { planId: plan.id })).json()).toMatchObject({ error: "more_visits_required" });
    expect((await t.api.post(`/contracts/${created.json().id}/renew`, {})).json()).toMatchObject({ visitsPerTerm: 4 });
  });

  it("does not ask when the plan already has enough visits", async () => {
    const t = await tenantIn(ctx, "Example County");
    const plan = await t.plan("residential");
    expect((await t.api.get(`/sites/${t.site.id}/contract-terms?planId=${plan.id}&startOn=2026-01-15`)).json()).toEqual({ planVisits: 3, visitsPerTerm: 3, warning: null });
    expect((await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2026-01-15" })).statusCode).toBe(201);
  });
});

describe("the next inspection date on a filing", () => {
  it("uses the commercial interval for a commercial site", async () => {
    const t = await tenantIn(ctx, COMMERCIAL_MONTHLY, "commercial");
    const plan = await t.plan("commercial");
    const contract = (await agreed(t, { planId: plan.id, startOn: "2026-01-01" })).json();
    const tech = await createUser(ctx.db, t.org.id, "technician");
    await ctx.db.updateTable("memberships").set({ technicianLicense: "MT-0001" }).where("userId", "=", tech.id).execute();
    const techApi = client(ctx.app, await login(ctx.app, tech.email));
    const visit = contract.obligations.find((o: Visit) => o.windowStart === "2026-03-01");
    const job = (await t.api.post("/jobs", { obligationId: visit.id, technicianId: tech.id, scheduledDate: "2026-03-01" })).json();
    const template = (await techApi.get("/inspection-template")).json();
    const s = { ...t, contract, tech, techApi, visit, job, template } as unknown as Setup;

    const base = {
      clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d02",
      jobId: job.jobId,
      templateId: template.id,
      arrivedAt: "2026-03-01T15:00:00Z",
      arrivalGps: { lat: 30.27, lng: -97.74, accuracyM: 8 },
    };
    await techApi.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
    await uploadRequiredPhotos(s, base.clientId);
    const done = await techApi.put("/inspections/sync", { ...base, status: "completed", completedAt: "2026-03-01T15:40:00Z", values: { ...completeValues(), air_pressure: 4.5 } });
    expect(done.json()).toMatchObject({ status: "completed", validationStatus: "valid" });

    const filing = (await t.api.get("/filings?view=all")).json().items[0];
    expect(filing).toMatchObject({ nextDueOn: "2026-04-01", jurisdiction: { key: "tx-fixture-commercial-monthly" } });
  });
});
