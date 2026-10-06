import { bundledRulesets, explainSite, loadCatalog } from "@aerowise/compliance";
import { drainTasks } from "@aerowise/tasks";
import { DEFAULT_TEMPLATE, mayAutoSubmit } from "@aerowise/domain";
import { describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { countyValues, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

// W6.C1: Williamson County's draft profile (packages/compliance/rulesets/tx-williamson-county).
// The ruleset applies from 2026-10-06, so these visits happen on 2026-10-07.
const ctx = setupTestApp();
const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });
const KEY = "tx-williamson-county";
const VISIT_DAY = "2026-10-07";

const williamson = () => bundledRulesets().filter((r) => r.jurisdiction.key === KEY).at(-1)!;
const AUTODIALER = { method: "autodialer", description: "Acme AD-200 on the control panel", notifies: "The maintenance provider, by phone call", startedOn: "2026-09-01", checkedOn: "2026-09-15" };

/** A Williamson County site the office has checked is outside Austin, under contract, with a visit on 2026-10-07. */
async function williamsonVisit(c: TestContext, opts: { monitored?: boolean; ownForm?: boolean } = {}) {
  c.now = new Date(`${VISIT_DAY}T18:00:00Z`);
  const t = await createTenant(c, "Org A");
  expect((await t.api.patch(`/sites/${t.site.id}`, { county: "Williamson", state: "TX" })).statusCode).toBe(200);
  const j = ((await t.api.get("/jurisdictions")).json().items as { id: string; key: string }[]).find((x) => x.key === KEY)!;
  const assigned = await t.api.put(`/sites/${t.site.id}/jurisdiction`, {
    jurisdictionId: j.id,
    evidenceKind: "authority_determination",
    evidenceReference: "Outside Austin city limits; Williamson County OSSF confirmed by phone 2026-10-06",
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  if (opts.monitored) expect((await t.api.post(`/systems/${t.system.id}/monitoring`, AUTODIALER)).statusCode).toBe(201);
  const plan = (await t.api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
  const contract = await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2026-10-01" });
  expect(contract.statusCode, contract.body).toBe(201);
  const tech = await createUser(c.db, t.org.id, "technician");
  const techApi = client(c.app, await login(c.app, tech.email));
  const job = (await t.api.post("/jobs", { obligationId: contract.json().obligations[0].id, technicianId: tech.id, scheduledDate: VISIT_DAY })).json();
  if (opts.ownForm) {
    // A company form saved before form v2: no sludge or spray-area questions.
    const older = DEFAULT_TEMPLATE.definition.fields.filter((f) => !["pump_tank_sludge", "pump_tank_ph", "spray_area", "spray_area_detail", "unauthorized_alterations", "unauthorized_alterations_detail"].includes(f.key));
    expect((await t.api.post("/inspection-templates", { name: "Our form", definition: { ...DEFAULT_TEMPLATE.definition, fields: older } })).statusCode).toBe(201);
  }
  const template = (await techApi.get("/inspection-template")).json();
  const s = { ...t, contract: contract.json(), tech, techApi, job, template } as unknown as Setup;
  const base = { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d07", jobId: job.jobId, templateId: template.id, arrivedAt: `${VISIT_DAY}T15:00:00Z`, arrivalGps: { lat: 30.63, lng: -97.68, accuracyM: 8 } };
  await techApi.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
  await uploadRequiredPhotos(s, base.clientId);
  const complete = (values: Record<string, unknown>) => techApi.put("/inspections/sync", { ...base, status: "completed", completedAt: `${VISIT_DAY}T15:40:00Z`, values });
  return { s, j, complete };
}

const filingsOf = async (s: Setup) => (await s.api.get("/filings?view=all&kind=inspection_report")).json().items as { id: string; status: string; [k: string]: unknown }[];

describe("Williamson County's draft profile", () => {
  it("reads as written, and never sends on its own", () => {
    const r = williamson();
    expect(r.version).toBe(2);
    // The approved copy of the order (W1); activation in Aerowise is still 2026-10-06.
    expect(r.profile).toMatchObject({ status: "draft", sourcesCheckedOn: "2026-10-06", requirementEffective: { date: "2021-05-07" } });
    expect(r.effectiveFrom).toBe("2026-10-06");
    expect(r.profile!.sources[0]!.note).toContain("PDF p. 10, Section 10.E.7(c)");
    // The homeowner packet's other inbox, the deadline conflict and the future-dated affidavit stay open.
    const open = r.profile!.unresolved.join(" ");
    expect(open).toContain("ossfcontracts@wilcotx.gov");
    expect(open).toContain("'Updated 9/9/2028'");
    expect(open).toContain("Aerowise uses 10 days");
    expect(r.inspection.requiredFields).toEqual(["dispersal_field", "pump_tank_sludge", "spray_area"]);
    expect(r.profile!.sources.every((s) => s.url.startsWith("https://") && s.retrievedOn === "2026-10-06")).toBe(true);
    expect(r.profile!.unresolved.length).toBeGreaterThan(0);
    expect(mayAutoSubmit(r)).toBe(false);
    // Everything in the county except the City of Austin: a person checks each site.
    expect(r.applicability).toMatchObject({ counties: ["Williamson"], assignment: "reviewed", howToDecide: expect.stringContaining("City of Austin") });
    expect(r.service).toMatchObject({ intervalMonths: 4, monitored: { intervalMonths: 6 } });
    expect(r.filing.deadlineDays).toBe(10);
    expect(r.contracts).toMatchObject({ filingRequired: true, renewalDaysBeforePreviousEnd: 30 });
    expect(r.submission).toMatchObject({ method: "email", email: { to: "ossf@wilcotx.gov" } });
    expect(r.labTests).toBeUndefined();
    expect(r.fees).toBeUndefined();
  });

  it("does not match a site by county alone", async () => {
    const catalog = await loadCatalog(ctx.db);
    const r = explainSite(catalog, { county: "Williamson County", state: "TX", jurisdictionId: null }, VISIT_DAY);
    expect(r.resolved).toBeNull();
    expect(r.candidates.map((c) => c.jurisdiction.key)).toEqual([KEY]);
  });

  it("files a valid inspection within 10 days, with the next visit 4 months out, ready for the office to send to ossf@wilcotx.gov", async () => {
    mail.mode = "ok";
    const { s, complete } = await williamsonVisit(ctx);
    const done = await complete({ ...countyValues(), air_pressure: 4.5 });
    expect(done.json()).toMatchObject({ status: "completed", validationStatus: "valid" });
    await runWorker(ctx);
    const [f] = await filingsOf(s);
    expect(f).toMatchObject({ deadlineOn: "2026-10-17", nextDueOn: "2027-02-07", jurisdiction: { key: KEY } });
    // The provider and technician credentials Williamson needs are not on record yet.
    expect(f!.status).toBe("needs_review");
    expect(f!.reviewReason).toContain("No responsible licensed maintenance provider");

    const mp = (await s.api.post("/credentials", { userId: s.owner.id, holderName: "Owner Person", kind: "tceq_maintenance_provider", number: "MP0001234", verifiedOn: "2026-10-01", verificationSource: "TCEQ license search" })).json();
    expect((await s.api.post("/credentials", { userId: s.tech.id, holderName: "Tech Person", kind: "tceq_maintenance_technician", number: "MT0005678" })).statusCode).toBe(201);
    await s.api.put("/settings/responsible-provider", { credentialId: mp.id });
    const inspectionId = ((await s.api.get(`/filings/${f!.id}`)).json()).inspection.id as string;
    expect((await s.api.post(`/inspections/${inspectionId}/signature`, { typedName: "Owner Person" })).statusCode).toBe(200);
    // A draft: ready, never queued, and nothing is mailed until the office presses Send.
    expect((await filingsOf(s))[0]).toMatchObject({ status: "ready" });
    const calls = mail.calls;
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
    expect((await s.api.post(`/filings/${f!.id}/submit`, {})).statusCode).toBe(200);
    await runWorker(ctx);
    const detail = (await s.api.get(`/filings/${f!.id}`)).json();
    expect(detail.status).toBe("sent");
    expect(detail.packages[0]).toMatchObject({ method: "email", recipient: "ossf@wilcotx.gov", subject: expect.stringContaining("OSSF maintenance inspection report") });
  });

  it("keeps an inspection without the spray area's condition as a draft", async () => {
    const { complete } = await williamsonVisit(ctx);
    const values = { ...countyValues(), air_pressure: 4.5 } as Record<string, unknown>;
    delete values.dispersal_field;
    const res = (await complete(values)).json();
    expect(res).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.validationProblems.map((p: { key: string }) => p.key)).toContain("dispersal_field");
  });

  it("asks for the pump tank's sludge in inches and the spray area's condition (order 10.E.7(c))", async () => {
    const { s, complete } = await williamsonVisit(ctx);
    const sludge = (s.template.definition.fields as { key: string; unit?: string }[]).find((f) => f.key === "pump_tank_sludge");
    expect(sludge).toMatchObject({ unit: "in" });
    const values = { ...countyValues(), air_pressure: 4.5 } as Record<string, unknown>;
    delete values.pump_tank_sludge;
    delete values.spray_area;
    const res = (await complete(values)).json();
    expect(res).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.validationProblems.map((p: { key: string }) => p.key).sort()).toEqual(["pump_tank_sludge", "spray_area"]);
    // A system without a spray area says so rather than leaving it blank.
    expect((await complete({ ...countyValues(), air_pressure: 4.5, spray_area: "not_spray" })).json()).toMatchObject({ status: "completed", validationStatus: "valid" });
  });

  it("holds a report made on a company form that doesn't ask for them", async () => {
    const { s, complete } = await williamsonVisit(ctx, { ownForm: true });
    expect((await complete({ ...countyValues(), air_pressure: 4.5, pump_tank_sludge: undefined, pump_tank_ph: undefined, spray_area: undefined, unauthorized_alterations: undefined })).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    const [f] = await filingsOf(s);
    expect(f).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("requires Sludge in pump tank, Spray area condition, which this inspection's form does not ask for") });
  });

  it("allows six months between visits where electronic monitoring is on record", async () => {
    const { s, complete } = await williamsonVisit(ctx, { monitored: true });
    expect((await complete({ ...countyValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    expect((await filingsOf(s))[0]).toMatchObject({ deadlineOn: "2026-10-17", nextDueOn: "2027-04-07" });
  });
});
