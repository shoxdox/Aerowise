import { bundledRulesets, explainSite, loadCatalog } from "@aerowise/compliance";
import { drainTasks } from "@aerowise/tasks";
import { mayAutoSubmit } from "@aerowise/domain";
import { describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { countyValues, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

// W6.C2: Travis County's draft profile (packages/compliance/rulesets/tx-travis-county).
const ctx = setupTestApp();
const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });
const KEY = "tx-travis-county";
const VISIT_DAY = "2026-10-07";

const travis = () => bundledRulesets().filter((r) => r.jurisdiction.key === KEY).at(-1)!;
const AUTODIALER = { method: "autodialer", description: "Acme AD-200 on the control panel", notifies: "The maintenance provider, by phone call", startedOn: "2026-09-01", checkedOn: "2026-09-15" };

/** A Travis County site the office has checked is outside Austin and LCRA's area, under contract, with a visit on 2026-10-07. */
async function travisVisit(c: TestContext, opts: { monitored?: boolean } = {}) {
  c.now = new Date(`${VISIT_DAY}T18:00:00Z`);
  const t = await createTenant(c, "Org A");
  expect((await t.api.patch(`/sites/${t.site.id}`, { county: "Travis", state: "TX" })).statusCode).toBe(200);
  const j = ((await t.api.get("/jurisdictions")).json().items as { id: string; key: string }[]).find((x) => x.key === KEY)!;
  const assigned = await t.api.put(`/sites/${t.site.id}/jurisdiction`, {
    jurisdictionId: j.id,
    evidenceKind: "authority_determination",
    evidenceReference: "Unincorporated, outside LCRA's Lake Travis area; Travis County TNR confirmed by phone 2026-10-06",
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
  const base = { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d07", jobId: job.jobId, templateId: template.id, arrivedAt: `${VISIT_DAY}T15:00:00Z`, arrivalGps: { lat: 30.18, lng: -97.55, accuracyM: 8 } };
  await techApi.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
  await uploadRequiredPhotos(s, base.clientId);
  const complete = (values: Record<string, unknown>) => techApi.put("/inspections/sync", { ...base, status: "completed", completedAt: `${VISIT_DAY}T15:40:00Z`, values });
  return { s, j, complete };
}

const filingsOf = async (s: Setup) => (await s.api.get("/filings?view=all&kind=inspection_report")).json().items as { id: string; status: string; [k: string]: unknown }[];

describe("Travis County's draft profile", () => {
  it("reads as written: no published way to submit reports, so nothing is ever sent", () => {
    const r = travis();
    expect(r.profile).toMatchObject({ status: "draft", sourcesCheckedOn: "2026-10-06", requirementEffective: { date: "2024-07-16" } });
    expect(r.profile!.sources.every((s) => s.url.startsWith("https://") && s.retrievedOn === "2026-10-06")).toBe(true);
    expect(r.profile!.unresolved.length).toBeGreaterThan(0);
    expect(mayAutoSubmit(r)).toBe(false);
    expect(r.applicability).toMatchObject({ counties: ["Travis"], assignment: "reviewed", howToDecide: expect.stringContaining("LCRA") });
    expect(r.inspectionReports?.submission).toBe("unknown");
    expect(r.submission).toMatchObject({ method: "manual_export" });
    expect(r.submission.email).toBeUndefined();
    expect(r.service).toMatchObject({ intervalMonths: 4, monitored: { intervalMonths: 6 } });
    expect(r.filing.deadlineDays).toBe(14);
    expect(r.contracts).toMatchObject({ filingRequired: true, renewalDaysBeforePreviousEnd: 30 });
    // v2 (W12.C3/C4): 448.034(e) report fields, scoped by 448.034(a) to single-family systems.
    expect(r.version).toBe(2);
    expect(r.inspection.requiredFields).toEqual(["dispersal_field"]);
    expect(r.inspection.scopedRequiredFields).toEqual([{ appliesTo: ["residential"], fields: ["unauthorized_alterations", "spray_area"], note: expect.stringContaining("448.034(a)") }]);
  });

  it("uses LCRA's 2,000-foot Lake Travis zone, not 1,000 feet, and leaves the decision to the permit or LCRA's map", () => {
    const r = travis();
    expect(r.applicability.howToDecide).toContain("within 2,000 horizontal feet of the area below the 691-foot contour");
    expect(r.applicability.howToDecide).toContain("not distance from the shoreline");
    expect(r.applicability.howToDecide).not.toContain("1,000");
    expect(r.profile!.unresolved.join(" ")).not.toMatch(/within 1,000 feet/);
    // The county page's 1,000-foot figure is kept only as the source that says it, marked as not used.
    expect(r.profile!.sources.find((x) => x.title.startsWith("Travis County TNR"))!.note).toContain("Aerowise does not use it");
    expect(r.profile!.sources.map((x) => x.title)).toEqual(expect.arrayContaining(["Travis County: Non-residential OSSF checklist", "LCRA OSSF order and fee schedule"]));
  });

  it("does not match a Travis site by county alone: LCRA and Travis County each cover part", async () => {
    const catalog = await loadCatalog(ctx.db);
    const r = explainSite(catalog, { county: "Travis County", state: "TX", jurisdictionId: null }, VISIT_DAY);
    expect(r.resolved).toBeNull();
    expect(r.candidates.map((c) => c.jurisdiction.key)).toEqual(["tx-lcra-ossf", KEY]);
  });

  it("dates a valid inspection's filing 14 days out with the next visit in 4 months, and holds it for review", async () => {
    mail.mode = "ok";
    const { s, complete } = await travisVisit(ctx);
    expect((await complete({ ...countyValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed", validationStatus: "valid" });
    await runWorker(ctx);
    const [f] = await filingsOf(s);
    expect(f).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-02-07", jurisdiction: { key: KEY }, status: "needs_review" });
    const calls = mail.calls;
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
  });

  it("asks a single-family site for unauthorized alterations and the spray area, but not a commercial one", async () => {
    const res = async (customerType: "residential" | "commercial") => {
      const { s, complete } = await travisVisit(ctx);
      if (customerType === "commercial") expect((await s.api.patch(`/sites/${s.site.id}`, { customerType })).statusCode).toBe(200);
      const values = { ...countyValues(), air_pressure: 4.5 } as Record<string, unknown>;
      delete values.unauthorized_alterations;
      delete values.spray_area;
      return (await complete(values)).json();
    };
    const home = await res("residential");
    expect(home).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(home.validationProblems.map((p: { key: string }) => p.key).sort()).toEqual(["spray_area", "unauthorized_alterations"]);
    expect(await res("commercial")).toMatchObject({ status: "completed", validationStatus: "valid" });
  });

  it("keeps an inspection without the dispersal field's condition as a draft", async () => {
    const { complete } = await travisVisit(ctx);
    const values = { ...countyValues(), air_pressure: 4.5 } as Record<string, unknown>;
    delete values.dispersal_field;
    const res = (await complete(values)).json();
    expect(res).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.validationProblems.map((p: { key: string }) => p.key)).toContain("dispersal_field");
  });

  it("allows six months between visits where electronic monitoring is on record", async () => {
    const { s, complete } = await travisVisit(ctx, { monitored: true });
    expect((await complete({ ...countyValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    expect((await filingsOf(s))[0]).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-04-07" });
  });
});
