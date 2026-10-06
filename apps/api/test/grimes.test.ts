import { bundledRulesets, explainSite, loadCatalog } from "@aerowise/compliance";
import { drainTasks } from "@aerowise/tasks";
import { mayAutoSubmit } from "@aerowise/domain";
import { describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { countyValues, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

// W6.C17: Grimes County's draft profile (packages/compliance/rulesets/tx-grimes-county).
const ctx = setupTestApp();
const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });
const KEY = "tx-grimes-county";
const VISIT_DAY = "2026-10-07";

const grimes = () => bundledRulesets().filter((r) => r.jurisdiction.key === KEY).at(-1)!;
const AUTODIALER = { method: "autodialer", description: "Acme AD-200 on the control panel", notifies: "The maintenance provider, by phone call", startedOn: "2026-09-01", checkedOn: "2026-09-15" };

/** A Grimes County site the county holds the permit for, under contract, with a visit on 2026-10-07. */
async function grimesVisit(c: TestContext, opts: { monitored?: boolean } = {}) {
  c.now = new Date(`${VISIT_DAY}T18:00:00Z`);
  const t = await createTenant(c, "Org A");
  expect((await t.api.patch(`/sites/${t.site.id}`, { county: "Grimes", state: "TX" })).statusCode).toBe(200);
  const j = ((await t.api.get("/jurisdictions")).json().items as { id: string; key: string }[]).find((x) => x.key === KEY)!;
  const assigned = await t.api.put(`/sites/${t.site.id}/jurisdiction`, {
    jurisdictionId: j.id,
    evidenceKind: "authority_determination",
    evidenceReference: "Grimes County Environmental Permits confirmed the permit by phone 2026-10-06",
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  if (opts.monitored) expect((await t.api.post(`/systems/${t.system.id}/monitoring`, AUTODIALER)).statusCode).toBe(201);
  const plan = (await t.api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
  const contract = await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2026-10-01" });
  expect(contract.statusCode, contract.body).toBe(201);
  const tech = await createUser(c.db, t.org.id, "technician");
  const techApi = client(c.app, await login(c.app, tech.email));
  const job = (await t.api.post("/jobs", { obligationId: contract.json().obligations[0].id, technicianId: tech.id, scheduledDate: VISIT_DAY })).json();
  const template = (await techApi.get("/inspection-template")).json();
  const s = { ...t, contract: contract.json(), tech, techApi, job, template } as unknown as Setup;
  const base = { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d07", jobId: job.jobId, templateId: template.id, arrivedAt: `${VISIT_DAY}T15:00:00Z`, arrivalGps: { lat: 30.5, lng: -96.0, accuracyM: 8 } };
  await techApi.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
  await uploadRequiredPhotos(s, base.clientId);
  const complete = (values: Record<string, unknown>) => techApi.put("/inspections/sync", { ...base, status: "completed", completedAt: `${VISIT_DAY}T15:40:00Z`, values });
  return { s, j, complete };
}

const filingsOf = async (s: Setup) => (await s.api.get("/filings?view=all&kind=inspection_report")).json().items as { id: string; status: string; [k: string]: unknown }[];

describe("Grimes County's draft profile", () => {
  it("reads as written: no published way to submit reports, so nothing is ever sent", () => {
    const r = grimes();
    expect(r.profile).toMatchObject({ status: "draft", sourcesCheckedOn: "2026-10-06", requirementEffective: { date: null } });
    expect(r.profile!.sources.every((s) => s.url.startsWith("https://") && s.retrievedOn === "2026-10-06")).toBe(true);
    expect(r.profile!.unresolved.length).toBeGreaterThan(0);
    expect(mayAutoSubmit(r)).toBe(false);
    expect(r.applicability).toMatchObject({ counties: ["Grimes"], assignment: "reviewed", howToDecide: expect.stringContaining("(936) 873-4495") });
    expect(r.inspectionReports?.submission).toBe("unknown");
    expect(r.submission).toMatchObject({ method: "manual_export" });
    expect(r.submission.email).toBeUndefined();
    // v2 (W12.C3): the 2024 order's four months, with no monitoring exception, and its report fields.
    expect(r.version).toBe(2);
    expect(r.service).toEqual({ intervalMonths: 4 });
    expect(r.filing.deadlineDays).toBe(14);
    expect(r.contracts).toMatchObject({ filingRequired: true, renewalDaysBeforePreviousEnd: 30 });
    expect(r.inspection.requiredFields).toEqual(["pump_tank_sludge", "pump_tank_ph", "spray_area"]);
    // Adopted 2024-08-21, but no final TCEQ approval was found: no effective date is claimed.
    expect(r.profile!.requirementEffective.basis).toContain("2024-08-21");
    expect(r.profile!.sources[0]!.note).toContain("PDF pp. 4-5, Section 9.C.1");
    expect(r.profile!.unresolved.join(" ")).toContain("final TCEQ approval was not found");
    expect(r.labTests).toBeUndefined();
  });

  it("does not match a Grimes site by county alone", async () => {
    const catalog = await loadCatalog(ctx.db);
    const r = explainSite(catalog, { county: "Grimes County", state: "TX", jurisdictionId: null }, VISIT_DAY);
    expect(r.resolved).toBeNull();
    expect(r.candidates.map((c) => c.jurisdiction.key)).toEqual([KEY]);
  });

  it("dates a valid inspection's filing 14 days out with the next visit in 4 months, and holds it for review", async () => {
    mail.mode = "ok";
    const { s, complete } = await grimesVisit(ctx);
    expect((await complete({ ...countyValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed", validationStatus: "valid" });
    await runWorker(ctx);
    const [f] = await filingsOf(s);
    expect(f).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-02-07", jurisdiction: { key: KEY }, status: "needs_review" });
    const calls = mail.calls;
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
  });

  it("keeps an inspection without a chlorine residual as a draft", async () => {
    const { complete } = await grimesVisit(ctx);
    const values = { ...countyValues(), air_pressure: 4.5 } as Record<string, unknown>;
    delete values.chlorine_level;
    const res = (await complete(values)).json();
    expect(res).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.validationProblems.map((p: { key: string }) => p.key)).toContain("chlorine_level");
  });

  it("keeps four months between visits even where electronic monitoring is on record (order 9.C.1)", async () => {
    const { s, complete } = await grimesVisit(ctx, { monitored: true });
    expect((await complete({ ...countyValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    expect((await filingsOf(s))[0]).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-02-07" });
  });

  it("asks for the pump tank's sludge and pH and the spray area's condition, without judging the readings", async () => {
    const { complete } = await grimesVisit(ctx);
    const values = { ...countyValues(), air_pressure: 4.5 } as Record<string, unknown>;
    delete values.pump_tank_sludge;
    delete values.pump_tank_ph;
    delete values.spray_area;
    const res = (await complete(values)).json();
    expect(res).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.validationProblems.map((p: { key: string }) => p.key).sort()).toEqual(["pump_tank_ph", "pump_tank_sludge", "spray_area"]);
    // No pH range is published, so any reading on the scale is accepted.
    expect((await complete({ ...countyValues(), air_pressure: 4.5, pump_tank_ph: 11.5, pump_tank_sludge: 30 })).json()).toMatchObject({ status: "completed", validationStatus: "valid" });
  });
});
