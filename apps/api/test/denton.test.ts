import { bundledRulesets, explainSite, loadCatalog } from "@aerowise/compliance";
import { drainTasks } from "@aerowise/tasks";
import { mayAutoSubmit } from "@aerowise/domain";
import { describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

// W6.C9: the draft profiles of Denton County and the City of Denton
// (packages/compliance/rulesets/tx-denton-county and tx-city-of-denton), two authorities in one county.
// The ruleset applies from 2026-10-06, so these visits happen on 2026-10-07.
const ctx = setupTestApp();
const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });
const KEY = "tx-denton-county";
const CITY = "tx-city-of-denton";
const VISIT_DAY = "2026-10-07";

const ruleset = (key: string) => bundledRulesets().find((r) => r.jurisdiction.key === key)!;
const PDF = Buffer.from("%PDF-1.4\n% synthetic signed contract for tests\n%%EOF\n");
const AUTODIALER = { method: "autodialer", description: "Acme AD-200 on the control panel", notifies: "The maintenance provider, by phone call", startedOn: "2026-09-01", checkedOn: "2026-09-15" };

/** A Denton site the office has assigned to one of the two authorities, under contract, with a visit on 2026-10-07. */
async function dentonVisit(c: TestContext, opts: { monitored?: boolean; key?: string } = {}) {
  const key = opts.key ?? KEY;
  c.now = new Date(`${VISIT_DAY}T18:00:00Z`);
  const t = await createTenant(c, "Org A");
  expect((await t.api.patch(`/sites/${t.site.id}`, { county: "Denton", state: "TX" })).statusCode).toBe(200);
  const j = ((await t.api.get("/jurisdictions")).json().items as { id: string; key: string }[]).find((x) => x.key === key)!;
  const assigned = await t.api.put(`/sites/${t.site.id}/jurisdiction`, {
    jurisdictionId: j.id,
    evidenceKind: "authority_determination",
    evidenceReference: key === KEY ? "Unincorporated; Denton County Environmental Health confirmed by phone 2026-10-06" : "Inside Denton city limits; City of Denton Environmental Services confirmed by phone 2026-10-06",
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
  const base = { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d07", jobId: job.jobId, templateId: template.id, arrivedAt: `${VISIT_DAY}T15:00:00Z`, arrivalGps: { lat: 33.3, lng: -97.0, accuracyM: 8 } };
  await techApi.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
  await uploadRequiredPhotos(s, base.clientId);
  const complete = (values: Record<string, unknown>) => techApi.put("/inspections/sync", { ...base, status: "completed", completedAt: `${VISIT_DAY}T15:40:00Z`, values });
  return { s, j, complete };
}

const filingsOf = async (s: Setup) => (await s.api.get("/filings?view=all&kind=inspection_report")).json().items as { id: string; status: string; [k: string]: unknown }[];

describe("Denton County's draft profile", () => {
  it("reads as written, and never sends on its own", () => {
    const r = ruleset(KEY);
    expect(r.profile).toMatchObject({ status: "draft", sourcesCheckedOn: "2026-10-06", requirementEffective: { date: null } });
    expect(r.profile!.sources.every((s) => s.url.startsWith("https://") && s.retrievedOn === "2026-10-06")).toBe(true);
    expect(r.profile!.unresolved.length).toBeGreaterThan(0);
    expect(mayAutoSubmit(r)).toBe(false);
    // Unincorporated Denton County only; the City of Denton runs its own program, so a person checks each site.
    expect(r.applicability).toMatchObject({ counties: ["Denton"], assignment: "reviewed", howToDecide: expect.stringContaining("City of Denton") });
    expect(r.service).toEqual({ intervalMonths: 4 });
    expect(r.filing.deadlineDays).toBe(14);
    expect(r.contracts).toMatchObject({ filingRequired: true, renewalDaysBeforePreviousEnd: 30 });
    expect(r.inspectionReports?.submission).toBe("supported");
    expect(r.submission).toMatchObject({ method: "email", email: { to: "ossfinspections@dentoncounty.gov" } });
    // Nothing says that address takes contracts.
    expect(r.contracts?.submission).toBe("unknown");
    expect(r.labTests).toBeUndefined();
    expect(r.fees).toBeUndefined();
  });

  it("does not match a site by county alone", async () => {
    const catalog = await loadCatalog(ctx.db);
    const r = explainSite(catalog, { county: "Denton County", state: "TX", jurisdictionId: null }, VISIT_DAY);
    expect(r.resolved).toBeNull();
    expect(r.candidates.map((c) => c.jurisdiction.key)).toEqual([CITY, KEY]);
  });

  it("files a valid inspection within 14 days, with the next visit 4 months out, ready for the office to send to ossfinspections@dentoncounty.gov", async () => {
    mail.mode = "ok";
    const { s, complete } = await dentonVisit(ctx);
    const done = await complete({ ...completeValues(), air_pressure: 4.5 });
    expect(done.json()).toMatchObject({ status: "completed", validationStatus: "valid" });
    await runWorker(ctx);
    const [f] = await filingsOf(s);
    expect(f).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-02-07", jurisdiction: { key: KEY } });
    // The provider and technician credentials Denton County needs are not on record yet.
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
    expect(detail.packages[0]).toMatchObject({ method: "email", recipient: "ossfinspections@dentoncounty.gov", subject: expect.stringContaining("OSSF maintenance inspection report") });
  });

  it("keeps an inspection without a chlorine residual as a draft", async () => {
    const { complete } = await dentonVisit(ctx);
    const values = { ...completeValues(), air_pressure: 4.5 } as Record<string, unknown>;
    delete values.chlorine_level;
    const res = (await complete(values)).json();
    expect(res).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.validationProblems.map((p: { key: string }) => p.key)).toContain("chlorine_level");
  });

  it("keeps four months between visits even where electronic monitoring is on record", async () => {
    // The county form says "Every 4 months" and does not address monitoring.
    const { s, complete } = await dentonVisit(ctx, { monitored: true });
    expect((await complete({ ...completeValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    expect((await filingsOf(s))[0]).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-02-07" });
  });

  it("holds a signed contract for review and never emails it to the reports address", async () => {
    mail.mode = "ok";
    const { s } = await dentonVisit(ctx);
    const up = await s.api.post(`/contracts/${s.contract.id}/document`, { filename: "Signed contract.pdf", contentBase64: PDF.toString("base64"), signedOn: "2026-09-30" });
    expect(up.statusCode, up.body).toBe(201);
    await runWorker(ctx);
    const [cf] = (await s.api.get("/filings?view=all&kind=contract")).json().items as { id: string; status: string; reviewReason: string }[];
    expect(cf).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("has not published how maintenance contracts are submitted") });
    expect((await s.api.post(`/filings/${cf!.id}/submit`, {})).statusCode).not.toBe(200);
    const calls = mail.calls;
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
  });
});

describe("the City of Denton's draft profile", () => {
  it("reads as written: no published way to submit reports, so nothing is ever sent", () => {
    const r = ruleset(CITY);
    expect(r.jurisdiction.type).toBe("city");
    expect(r.profile).toMatchObject({ status: "draft", sourcesCheckedOn: "2026-10-06", requirementEffective: { date: null } });
    expect(r.profile!.sources.every((s) => s.url.startsWith("https://") && s.retrievedOn === "2026-10-06")).toBe(true);
    expect(r.profile!.unresolved.length).toBeGreaterThan(0);
    expect(mayAutoSubmit(r)).toBe(false);
    expect(r.applicability).toMatchObject({ counties: ["Denton"], assignment: "reviewed", howToDecide: expect.stringContaining("(940) 349-8619") });
    expect(r.inspectionReports?.submission).toBe("unknown");
    expect(r.submission).toMatchObject({ method: "manual_export" });
    expect(r.submission.email).toBeUndefined();
    expect(r.service).toMatchObject({ intervalMonths: 4, monitored: { intervalMonths: 6 } });
    expect(r.filing.deadlineDays).toBe(14);
    expect(r.contracts).toMatchObject({ filingRequired: true, renewalDaysBeforePreviousEnd: 30 });
    expect(r.inspection.requiredFields).toEqual([]);
    expect(r.labTests).toBeUndefined();
  });

  it("dates a valid inspection's filing 14 days out with the next visit in 4 months, and holds it for review", async () => {
    mail.mode = "ok";
    const { s, complete } = await dentonVisit(ctx, { key: CITY });
    expect((await complete({ ...completeValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed", validationStatus: "valid" });
    await runWorker(ctx);
    const [f] = await filingsOf(s);
    expect(f).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-02-07", jurisdiction: { key: CITY }, status: "needs_review" });
    const calls = mail.calls;
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
  });

  it("allows six months between visits where electronic monitoring is on record", async () => {
    const { s, complete } = await dentonVisit(ctx, { key: CITY, monitored: true });
    expect((await complete({ ...completeValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    expect((await filingsOf(s))[0]).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-04-07" });
  });
});
