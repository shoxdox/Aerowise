import { bundledRulesets, explainSite, loadCatalog } from "@aerowise/compliance";
import { drainTasks } from "@aerowise/tasks";
import { mayAutoSubmit } from "@aerowise/domain";
import { describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

// W6.C20: the San Jacinto River Authority's draft profile (packages/compliance/rulesets/tx-sjra-ossf).
// The ruleset applies from 2026-10-06, so these visits happen on 2026-10-07.
const ctx = setupTestApp();
const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });
const KEY = "tx-sjra-ossf";
const VISIT_DAY = "2026-10-07";
const PORTAL = "https://customerportal.sjra.net/";

const sjra = () => bundledRulesets().find((r) => r.jurisdiction.key === KEY)!;
const AUTODIALER = { method: "autodialer", description: "Acme AD-200 on the control panel", notifies: "The maintenance provider, by phone call", startedOn: "2026-09-01", checkedOn: "2026-09-15" };

/** A Lake Conroe site the office has checked is inside SJRA's 2,075-foot band, under contract, with a visit on 2026-10-07. */
async function sjraVisit(c: TestContext, opts: { monitored?: boolean } = {}) {
  c.now = new Date(`${VISIT_DAY}T18:00:00Z`);
  const t = await createTenant(c, "Org A");
  expect((await t.api.patch(`/sites/${t.site.id}`, { county: "Montgomery", state: "TX" })).statusCode).toBe(200);
  const j = ((await t.api.get("/jurisdictions")).json().items as { id: string; key: string }[]).find((x) => x.key === KEY)!;
  const assigned = await t.api.put(`/sites/${t.site.id}/jurisdiction`, {
    jurisdictionId: j.id,
    evidenceKind: "authority_determination",
    evidenceReference: "Inside the 2,075-foot band on SJRA's OSSF Data Viewer 2026-10-06",
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
  const base = { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d07", jobId: job.jobId, templateId: template.id, arrivedAt: `${VISIT_DAY}T15:00:00Z`, arrivalGps: { lat: 30.4, lng: -95.6, accuracyM: 8 } };
  await techApi.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
  await uploadRequiredPhotos(s, base.clientId);
  const complete = (values: Record<string, unknown>) => techApi.put("/inspections/sync", { ...base, status: "completed", completedAt: `${VISIT_DAY}T15:40:00Z`, values });
  return { s, j, complete };
}

const filingsOf = async (s: Setup) => (await s.api.get("/filings?view=all&kind=inspection_report")).json().items as { id: string; status: string; [k: string]: unknown }[];

describe("the San Jacinto River Authority's draft profile", () => {
  it("reads as written: reports go to SJRA's customer portal by hand, never on their own", () => {
    const r = sjra();
    expect(r.profile).toMatchObject({ status: "draft", sourcesCheckedOn: "2026-10-06", requirementEffective: { date: null } });
    expect(r.profile!.sources.every((s) => s.url.startsWith("https://") && s.retrievedOn === "2026-10-06")).toBe(true);
    expect(r.profile!.unresolved.some((u) => u.includes("384053.4"))).toBe(true);
    expect(r.jurisdiction.type).toBe("river_authority");
    expect(mayAutoSubmit(r)).toBe(false);
    expect(r.applicability).toMatchObject({ counties: ["Montgomery"], assignment: "reviewed", howToDecide: expect.stringContaining("936-588-3111") });
    expect(r.inspectionReports?.submission).toBe("supported");
    expect(r.submission).toMatchObject({ method: "manual_export", portalUrl: PORTAL });
    expect(r.submission.email).toBeUndefined();
    // Every four calendar months, with no monitoring exception (order Section 7(a)(10)(A)).
    expect(r.service).toEqual({ intervalMonths: 4 });
    expect(r.inspection.requiredFields).toEqual([]);
    expect(r.filing.deadlineDays).toBe(14);
    expect(r.contracts).toMatchObject({ filingRequired: true, renewalDaysBeforePreviousEnd: 30 });
    expect(r.labTests).toBeUndefined();
    expect(r.fees).toBeUndefined();
  });

  it("does not match a Montgomery site by county alone", async () => {
    const catalog = await loadCatalog(ctx.db);
    const r = explainSite(catalog, { county: "Montgomery County", state: "TX", jurisdictionId: null }, VISIT_DAY);
    expect(r.resolved).toBeNull();
    expect(r.candidates.map((c) => c.jurisdiction.key)).toEqual(["tx-montgomery-county", KEY]);
  });

  it("dates a valid inspection's filing 14 days out with the next visit in 4 months, for the office to upload and record", async () => {
    mail.mode = "ok";
    const { s, complete } = await sjraVisit(ctx);
    expect((await complete({ ...completeValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed", validationStatus: "valid" });
    await runWorker(ctx);
    const [f] = await filingsOf(s);
    expect(f).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-02-07", jurisdiction: { key: KEY }, status: "needs_review" });
    expect(f!.reviewReason).toContain("No responsible licensed maintenance provider");

    const mp = (await s.api.post("/credentials", { userId: s.owner.id, holderName: "Owner Person", kind: "tceq_maintenance_provider", number: "MP0001234", verifiedOn: "2026-10-01", verificationSource: "TCEQ license search" })).json();
    expect((await s.api.post("/credentials", { userId: s.tech.id, holderName: "Tech Person", kind: "tceq_maintenance_technician", number: "MT0005678" })).statusCode).toBe(201);
    await s.api.put("/settings/responsible-provider", { credentialId: mp.id });
    const inspectionId = ((await s.api.get(`/filings/${f!.id}`)).json()).inspection.id as string;
    expect((await s.api.post(`/inspections/${inspectionId}/signature`, { typedName: "Owner Person" })).statusCode).toBe(200);
    // Ready to enter by hand on SJRA's portal; nothing is mailed.
    const calls = mail.calls;
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
    const ready = (await s.api.get(`/filings/${f!.id}`)).json();
    expect(ready).toMatchObject({ status: "ready", submissionMethod: "manual_export" });
    expect(ready.package?.portalUrl ?? ready.packages?.[0]?.portalUrl).toBe(PORTAL);
    const sent = await s.api.post(`/filings/${f!.id}/mark-sent`, { reference: "Uploaded 2026-10-08", note: "SJRA customer portal, OSSF Inspection" });
    expect(sent.json()).toMatchObject({ status: "sent", proof: { kind: "manual_submission" } });
  });

  it("keeps an inspection without a chlorine residual as a draft", async () => {
    const { complete } = await sjraVisit(ctx);
    const values = { ...completeValues(), air_pressure: 4.5 } as Record<string, unknown>;
    delete values.chlorine_level;
    const res = (await complete(values)).json();
    expect(res).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.validationProblems.map((p: { key: string }) => p.key)).toContain("chlorine_level");
  });

  it("keeps four months between visits even where electronic monitoring is on record", async () => {
    const { s, complete } = await sjraVisit(ctx, { monitored: true });
    expect((await complete({ ...completeValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    expect((await filingsOf(s))[0]).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-02-07" });
  });
});
