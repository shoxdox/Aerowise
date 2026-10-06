import { bundledRulesets, explainSite, loadCatalog } from "@aerowise/compliance";
import { drainTasks } from "@aerowise/tasks";
import { mayAutoSubmit } from "@aerowise/domain";
import { describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { countyValues, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

// W6.C4: Comal County's draft profile (packages/compliance/rulesets/tx-comal-county).
// The ruleset applies from 2026-10-06, so these visits happen on 2026-10-07.
const ctx = setupTestApp();
const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });
const KEY = "tx-comal-county";
const VISIT_DAY = "2026-10-07";
const PORTAL = "https://comalcountyengineersoffice.files.com/u/maintenance-reports";

const versions = () => bundledRulesets().filter((r) => r.jurisdiction.key === KEY);
const comal = () => versions().at(-1)!;
const AUTODIALER = { method: "autodialer", description: "Acme AD-200 on the control panel", notifies: "The maintenance provider, by phone call", startedOn: "2026-09-01", checkedOn: "2026-09-15" };

/** A Comal County site the office has checked is permitted by the county, under contract, with a visit on 2026-10-07. */
async function comalVisit(c: TestContext, opts: { monitored?: boolean } = {}) {
  c.now = new Date(`${VISIT_DAY}T18:00:00Z`);
  const t = await createTenant(c, "Org A");
  expect((await t.api.patch(`/sites/${t.site.id}`, { county: "Comal", state: "TX" })).statusCode).toBe(200);
  const j = ((await t.api.get("/jurisdictions")).json().items as { id: string; key: string }[]).find((x) => x.key === KEY)!;
  const assigned = await t.api.put(`/sites/${t.site.id}/jurisdiction`, {
    jurisdictionId: j.id,
    evidenceKind: "authority_determination",
    evidenceReference: "Permit found in the Comal County septic records search 2026-10-06",
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
  const base = { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d07", jobId: job.jobId, templateId: template.id, arrivedAt: `${VISIT_DAY}T15:00:00Z`, arrivalGps: { lat: 29.8, lng: -98.3, accuracyM: 8 } };
  await techApi.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
  await uploadRequiredPhotos(s, base.clientId);
  const complete = (values: Record<string, unknown>) => techApi.put("/inspections/sync", { ...base, status: "completed", completedAt: `${VISIT_DAY}T15:40:00Z`, values });
  return { s, j, complete };
}

const filingsOf = async (s: Setup) => (await s.api.get("/filings?view=all&kind=inspection_report")).json().items as { id: string; status: string; [k: string]: unknown }[];

describe("Comal County's draft profile", () => {
  it("reads as written: reports go to the county's upload portal by hand, never on their own", () => {
    const r = comal();
    expect(r.version).toBe(2);
    expect(r.profile).toMatchObject({ status: "draft", sourcesCheckedOn: "2026-10-06", requirementEffective: { date: "2013-11-26" } });
    expect(r.profile!.sources.every((s) => s.url.startsWith("https://") && s.retrievedOn === "2026-10-06")).toBe(true);
    // The rules scan is read now; the five city agreements are evidence, not an assignment.
    expect(r.profile!.unresolved.some((u) => u.includes("could not be read"))).toBe(false);
    expect(r.profile!.sources.filter((s) => s.title.includes("interlocal agreement"))).toHaveLength(5);
    for (const city of ["Bulverde", "Fair Oaks Ranch", "Garden Ridge", "Schertz", "Spring Branch"]) expect(r.applicability.howToDecide).toContain(city);
    // v1's homeowner no-report claim is not relied on.
    expect(r.profile!.unresolved.join(" ")).toContain("is not stated on the county's current pages");
    expect(r.inspection.requiredFields).toEqual(["spray_area"]);
    expect(mayAutoSubmit(r)).toBe(false);
    expect(r.applicability).toMatchObject({ counties: ["Comal"], assignment: "reviewed", howToDecide: expect.stringContaining("830-608-2090") });
    expect(r.inspectionReports?.submission).toBe("supported");
    expect(r.submission).toMatchObject({ method: "manual_export", portalUrl: PORTAL });
    expect(r.submission.email).toBeUndefined();
    expect(r.service).toMatchObject({ intervalMonths: 4, monitored: { intervalMonths: 6 } });
    expect(r.filing.deadlineDays).toBe(14);
    expect(r.contracts).toMatchObject({ filingRequired: true, renewalDaysBeforePreviousEnd: 30 });
    expect(r.labTests).toBeUndefined();
    expect(r.fees).toBeUndefined();
  });

  it("does not match a Comal site by county alone", async () => {
    const catalog = await loadCatalog(ctx.db);
    const r = explainSite(catalog, { county: "Comal County", state: "TX", jurisdictionId: null }, VISIT_DAY);
    expect(r.resolved).toBeNull();
    expect(r.candidates.map((c) => c.jurisdiction.key)).toEqual([KEY]);
  });

  it("dates a valid inspection's filing 14 days out with the next visit in 4 months, for the office to upload and record", async () => {
    mail.mode = "ok";
    const { s, complete } = await comalVisit(ctx);
    expect((await complete({ ...countyValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed", validationStatus: "valid" });
    await runWorker(ctx);
    const [f] = await filingsOf(s);
    expect(f).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-02-07", jurisdiction: { key: KEY }, status: "needs_review" });
    expect(f!.reviewReason).toContain("No responsible licensed maintenance provider");

    const mp = (await s.api.post("/credentials", { userId: s.owner.id, holderName: "Owner Person", kind: "tceq_maintenance_provider", number: "MP0001234", verifiedOn: "2026-10-01", verificationSource: "TCEQ license search" })).json();
    expect((await s.api.post("/credentials", { userId: s.tech.id, holderName: "Tech Person", kind: "tceq_maintenance_technician", number: "MT0005678" })).statusCode).toBe(201);
    await s.api.put("/settings/responsible-provider", { credentialId: mp.id });
    const inspectionId = ((await s.api.get(`/filings/${f!.id}`)).json()).inspection.id as string;
    expect((await s.api.post(`/inspections/${inspectionId}/signature`, { typedName: "Owner Person" })).statusCode).toBe(200);
    // Ready to file by hand on the county's portal; nothing is mailed.
    const calls = mail.calls;
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
    const ready = (await s.api.get(`/filings/${f!.id}`)).json();
    expect(ready).toMatchObject({ status: "ready", submissionMethod: "manual_export" });
    expect(ready.package?.portalUrl ?? ready.packages?.[0]?.portalUrl).toBe(PORTAL);
    const sent = await s.api.post(`/filings/${f!.id}/mark-sent`, { reference: "Uploaded 2026-10-08", note: "Comal County maintenance reports portal" });
    expect(sent.json()).toMatchObject({ status: "sent", proof: { kind: "manual_submission" } });
  });

  it("keeps an inspection without a chlorine residual as a draft", async () => {
    const { complete } = await comalVisit(ctx);
    const values = { ...countyValues(), air_pressure: 4.5 } as Record<string, unknown>;
    delete values.chlorine_level;
    const res = (await complete(values)).json();
    expect(res).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.validationProblems.map((p: { key: string }) => p.key)).toContain("chlorine_level");
  });

  it("allows six months between visits where electronic monitoring is on record", async () => {
    const { s, complete } = await comalVisit(ctx, { monitored: true });
    expect((await complete({ ...countyValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    expect((await filingsOf(s))[0]).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-04-07" });
  });

  it("keeps an inspection without the spray area's condition as a draft", async () => {
    const { complete } = await comalVisit(ctx);
    const values = { ...countyValues(), air_pressure: 4.5 } as Record<string, unknown>;
    delete values.spray_area;
    const res = (await complete(values)).json();
    expect(res).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.validationProblems.map((p: { key: string }) => p.key)).toContain("spray_area");
  });

  it("keeps v1 as published, replaced from the same day", () => {
    const [v1, v2] = versions();
    expect(v1).toMatchObject({ version: 1, profile: { requirementEffective: { date: null } }, inspection: { requiredFields: [] } });
    expect(v2!.effectiveFrom).toBe(v1!.effectiveFrom);
  });
});
