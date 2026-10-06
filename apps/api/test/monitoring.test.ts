import { fileURLToPath } from "node:url";
import { bundledRulesets, syncRulesets } from "@aerowise/compliance";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

// Today is 2026-03-01 (setupTestApp's clock).
const ctx = setupTestApp();

const FIXTURES = bundledRulesets(fileURLToPath(new URL("./fixtures/rulesets", import.meta.url)));
const MONITORED = "Monitored Fixture County";
const QUARTERLY = "Quarterly Fixture County";

beforeEach(async () => {
  await syncRulesets(ctx.db, FIXTURES);
});

// Other test files list the authorities, so leave only the bundled ones behind.
afterAll(async () => {
  await sql`truncate jurisdiction_rulesets, jurisdictions cascade`.execute(ctx.db);
  await syncRulesets(ctx.db);
});

const AUTODIALER = { method: "autodialer", description: "Acme AD-200 on the control panel", notifies: "The maintenance provider, by phone call", startedOn: "2025-12-01", checkedOn: "2025-12-15" };

/**
 * Creates a contract the way the office does: look at the visits the site's authority needs
 * and, if that is more than the plan has, agree to them (the office is warned first).
 */
async function agreed(t: { api: ReturnType<typeof client>; site: { id: string } }, body: { planId: string; startOn: string }) {
  const preview = (await t.api.get(`/sites/${t.site.id}/contract-terms?planId=${body.planId}&startOn=${body.startOn}`)).json();
  return t.api.post(`/sites/${t.site.id}/contracts`, { ...body, acceptVisits: preview.warning ? preview.visitsPerTerm : undefined });
}

async function siteIn(c: TestContext, county: string, name = "Org A") {
  const t = await createTenant(c, name);
  expect((await t.api.patch(`/sites/${t.site.id}`, { county })).statusCode).toBe(200);
  // Two visits a year: a six-month schedule, if the site may have one.
  const plan = async (customerType = "residential") => (await t.api.post("/plans", { name: `${customerType} 12/2`, customerType, termMonths: 12, visitsPerTerm: 2, priceCents: 20000 })).json();
  const contract = async (startOn = "2026-01-15", customerType = "residential") => {
    await t.api.patch(`/sites/${t.site.id}`, { customerType });
    return (await agreed(t, { planId: (await plan(customerType)).id, startOn })).json();
  };
  return { ...t, contract };
}

describe("the six-month schedule", () => {
  it("is allowed where the ruleset permits it and monitoring is on record", async () => {
    const t = await siteIn(ctx, MONITORED);
    expect((await t.api.post(`/systems/${t.system.id}/monitoring`, AUTODIALER)).statusCode).toBe(201);
    const contract = await t.contract();
    expect(contract.visitsPerTerm).toBe(2);
    expect(contract.obligations.map((o: { windowStart: string; dueOn: string }) => [o.windowStart, o.dueOn])).toEqual([
      ["2026-01-15", "2026-07-14"],
      ["2026-07-15", "2027-01-14"],
    ]);
  });

  it("is refused without monitoring on record: the visits go back to every four months", async () => {
    const t = await siteIn(ctx, MONITORED);
    expect((await t.contract()).visitsPerTerm).toBe(3);
  });

  it("is refused where the ruleset does not permit it, even with monitoring", async () => {
    const t = await siteIn(ctx, QUARTERLY);
    await t.api.post(`/systems/${t.system.id}/monitoring`, AUTODIALER);
    expect((await t.contract()).visitsPerTerm).toBe(4);
    const u = await siteIn(ctx, "Example County", "Org B");
    await u.api.post(`/systems/${u.system.id}/monitoring`, AUTODIALER);
    expect((await u.contract()).visitsPerTerm).toBe(3);
  });

  it("is refused for a system type the ruleset does not name", async () => {
    const t = await siteIn(ctx, MONITORED);
    await t.api.post(`/systems/${t.system.id}/monitoring`, AUTODIALER);
    expect((await t.contract("2026-01-15", "commercial")).visitsPerTerm).toBe(3);
  });

  it("counts monitoring only once it was checked, and not after it ended", async () => {
    const t = await siteIn(ctx, MONITORED);
    await t.api.post(`/systems/${t.system.id}/monitoring`, { ...AUTODIALER, startedOn: "2026-01-20", checkedOn: "2026-02-01" });
    // Starts before the check: four months.
    expect((await t.contract("2026-01-15")).visitsPerTerm).toBe(3);

    const u = await siteIn(ctx, MONITORED, "Org B");
    const m = (await u.api.post(`/systems/${u.system.id}/monitoring`, AUTODIALER)).json();
    expect((await u.api.post(`/monitoring/${m.id}/end`, { endedOn: "2026-01-10", reason: "Autodialer removed by the owner" })).statusCode).toBe(200);
    expect((await u.contract("2026-01-15")).visitsPerTerm).toBe(3);
  });

  it("sets the next inspection six months out on a monitored site's filing", async () => {
    const t = await siteIn(ctx, MONITORED);
    await t.api.post(`/systems/${t.system.id}/monitoring`, AUTODIALER);
    const contract = await t.contract("2026-01-15");
    const tech = await createUser(ctx.db, t.org.id, "technician");
    await ctx.db.updateTable("memberships").set({ technicianLicense: "MT-0001" }).where("userId", "=", tech.id).execute();
    const techApi = client(ctx.app, await login(ctx.app, tech.email));
    const job = (await t.api.post("/jobs", { obligationId: contract.obligations[0].id, technicianId: tech.id, scheduledDate: "2026-03-01" })).json();
    const template = (await techApi.get("/inspection-template")).json();
    const s = { ...t, contract, tech, techApi, job, template } as unknown as Setup;
    const base = { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d03", jobId: job.jobId, templateId: template.id, arrivedAt: "2026-03-01T15:00:00Z", arrivalGps: { lat: 30.27, lng: -97.74, accuracyM: 8 } };
    await techApi.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
    await uploadRequiredPhotos(s, base.clientId);
    const done = await techApi.put("/inspections/sync", { ...base, status: "completed", completedAt: "2026-03-01T15:40:00Z", values: { ...completeValues(), air_pressure: 4.5 } });
    expect(done.json()).toMatchObject({ status: "completed" });
    expect((await t.api.get("/filings?view=all")).json().items[0]).toMatchObject({ nextDueOn: "2026-09-01", jurisdiction: { key: "tx-fixture-monitored" } });
  });
});

describe("monitoring records", () => {
  it("say what it is, who it notifies and when it was checked, one open record per system", async () => {
    const t = await siteIn(ctx, MONITORED);
    const res = await t.api.post(`/systems/${t.system.id}/monitoring`, AUTODIALER);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ ...AUTODIALER, systemId: t.system.id, endedOn: null, endReason: null });
    expect((await t.api.post(`/systems/${t.system.id}/monitoring`, AUTODIALER)).statusCode).toBe(409);
    expect((await t.api.post(`/systems/${t.system.id}/monitoring`, { ...AUTODIALER, notifies: "" })).statusCode).toBe(400);
    expect((await t.api.post(`/systems/${t.system.id}/monitoring`, { ...AUTODIALER, checkedOn: "2026-03-02" })).statusCode).toBe(422);
    expect((await t.api.post(`/systems/${t.system.id}/monitoring`, { ...AUTODIALER, startedOn: "2026-01-01", checkedOn: "2025-12-01" })).statusCode).toBe(422);

    const id = res.json().id;
    expect((await t.api.post(`/monitoring/${id}/end`, { endedOn: "2025-11-01", reason: "x" })).statusCode).toBe(422);
    const ended = await t.api.post(`/monitoring/${id}/end`, { endedOn: "2026-02-01", reason: "Owner cancelled the monitoring service" });
    expect(ended.json()).toMatchObject({ endedOn: "2026-02-01", endReason: "Owner cancelled the monitoring service" });
    expect((await t.api.post(`/monitoring/${id}/end`, { endedOn: "2026-02-02", reason: "again" })).statusCode).toBe(409);
    // A new record can follow once the old one has ended.
    expect((await t.api.post(`/systems/${t.system.id}/monitoring`, { ...AUTODIALER, startedOn: "2026-02-10", checkedOn: "2026-02-10" })).statusCode).toBe(201);
    expect((await t.api.get(`/sites/${t.site.id}/monitoring`)).json().items).toHaveLength(2);

    const events = (await t.api.get(`/sites/${t.site.id}/compliance-events`)).json().items as { eventType: string }[];
    expect(events.filter((e) => e.eventType.startsWith("monitoring_")).map((e) => e.eventType).sort()).toEqual(["monitoring_ended", "monitoring_recorded", "monitoring_recorded"]);
  });

  it("are recorded by the office, not a technician", async () => {
    const t = await siteIn(ctx, MONITORED);
    const tech = await createUser(ctx.db, t.org.id, "technician");
    const techApi = client(ctx.app, await login(ctx.app, tech.email));
    expect((await techApi.post(`/systems/${t.system.id}/monitoring`, AUTODIALER)).statusCode).toBe(403);
    expect((await techApi.get(`/sites/${t.site.id}/monitoring`)).statusCode).toBe(200);
  });

  it("stay inside their organization", async () => {
    const a = await siteIn(ctx, MONITORED, "Org A");
    const b = await siteIn(ctx, MONITORED, "Org B");
    const m = (await a.api.post(`/systems/${a.system.id}/monitoring`, AUTODIALER)).json();
    expect((await b.api.get(`/sites/${a.site.id}/monitoring`)).statusCode).toBe(404);
    expect((await b.api.post(`/systems/${a.system.id}/monitoring`, AUTODIALER)).statusCode).toBe(404);
    expect((await b.api.post(`/monitoring/${m.id}/end`, { endedOn: "2026-02-01", reason: "x" })).statusCode).toBe(404);
    // Org A's monitoring does not stretch Org B's schedule.
    expect((await b.contract()).visitsPerTerm).toBe(3);
    await expect(
      sql`insert into system_monitoring (organization_id, system_id, method, description, notifies, started_on, checked_on, recorded_by) values (${b.org.id}, ${a.system.id}, 'autodialer', 'x', 'y', '2026-01-01', '2026-01-01', ${b.owner.id})`.execute(ctx.db),
    ).rejects.toThrow(/foreign key/);
  });
});
