import { bundledRulesets, explainSite, loadCatalog } from "@aerowise/compliance";
import { drainTasks } from "@aerowise/tasks";
import { mayAutoSubmit } from "@aerowise/domain";
import { describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

// W6.C18: Brazoria County's draft profile (packages/compliance/rulesets/tx-brazoria-county).
const ctx = setupTestApp();
const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });
const KEY = "tx-brazoria-county";
const VISIT_DAY = "2026-10-07";

const versions = () => bundledRulesets().filter((r) => r.jurisdiction.key === KEY);
const brazoria = () => versions().at(-1)!;
const INBOX = "ehmaintenance@brazoriacountytx.gov";
const PDF = Buffer.from("%PDF-1.4\n% synthetic signed contract for tests\n%%EOF\n");
const AUTODIALER = { method: "autodialer", description: "Acme AD-200 on the control panel", notifies: "The maintenance provider, by phone call", startedOn: "2026-09-01", checkedOn: "2026-09-15" };

/** A Brazoria County site outside the cities with their own program, under contract, with a visit on 2026-10-07. */
async function brazoriaVisit(c: TestContext, opts: { monitored?: boolean } = {}) {
  c.now = new Date(`${VISIT_DAY}T18:00:00Z`);
  const t = await createTenant(c, "Org A");
  expect((await t.api.patch(`/sites/${t.site.id}`, { county: "Brazoria", state: "TX" })).statusCode).toBe(200);
  const j = ((await t.api.get("/jurisdictions")).json().items as { id: string; key: string }[]).find((x) => x.key === KEY)!;
  const assigned = await t.api.put(`/sites/${t.site.id}/jurisdiction`, {
    jurisdictionId: j.id,
    evidenceKind: "authority_determination",
    evidenceReference: "Unincorporated; Brazoria County Environmental Health confirmed the permit 2026-10-06",
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
  const base = { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d07", jobId: job.jobId, templateId: template.id, arrivedAt: `${VISIT_DAY}T15:00:00Z`, arrivalGps: { lat: 29.2, lng: -95.4, accuracyM: 8 } };
  await techApi.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
  await uploadRequiredPhotos(s, base.clientId);
  const complete = (values: Record<string, unknown>) => techApi.put("/inspections/sync", { ...base, status: "completed", completedAt: `${VISIT_DAY}T15:40:00Z`, values });
  return { s, j, complete };
}

async function credentials(s: Setup) {
  const mp = (await s.api.post("/credentials", { userId: s.owner.id, holderName: "Owner Person", kind: "tceq_maintenance_provider", number: "MP0001234", verifiedOn: "2026-10-01", verificationSource: "TCEQ license search" })).json();
  expect((await s.api.post("/credentials", { userId: s.tech.id, holderName: "Tech Person", kind: "tceq_maintenance_technician", number: "MT0005678" })).statusCode).toBe(201);
  await s.api.put("/settings/responsible-provider", { credentialId: mp.id });
}

const filingsOf = async (s: Setup) => (await s.api.get("/filings?view=all&kind=inspection_report")).json().items as { id: string; status: string; [k: string]: unknown }[];

describe("Brazoria County's draft profile", () => {
  it("reads as written: the county's published inbox, drafted for the office to send", () => {
    const r = brazoria();
    expect(r.version).toBe(2);
    expect(r.profile).toMatchObject({ status: "draft", sourcesCheckedOn: "2026-10-06", requirementEffective: { date: "2010-06-30" } });
    expect(r.profile!.sources.every((s) => s.url.startsWith("https://") && s.retrievedOn === "2026-10-06")).toBe(true);
    // The published address is not the county's acceptance of Aerowise's reports.
    expect(r.profile!.unresolved[0]).toContain("not the county's acceptance");
    expect(mayAutoSubmit(r)).toBe(false);
    expect(r.applicability).toMatchObject({ counties: ["Brazoria"], assignment: "reviewed", howToDecide: expect.stringContaining("979-864-1600") });
    expect(r.inspectionReports?.submission).toBe("supported");
    expect(r.contracts?.submission).toBeUndefined();
    expect(r.submission).toMatchObject({ method: "email", email: { to: INBOX, contractSubject: expect.stringContaining("contract") } });
    expect(r.provider?.countyRegistration).toMatchObject({ required: true, renews: expect.stringContaining("Free") });
    expect(r.service).toMatchObject({ intervalMonths: 4, monitored: { intervalMonths: 6 } });
    expect(r.filing).toMatchObject({ deadlineDays: 14, autoSubmit: false });
    expect(r.contracts).toMatchObject({ filingRequired: true, renewalDaysBeforePreviousEnd: 30 });
    expect(r.inspection.requiredFields).toEqual([]);
    expect(r.labTests).toBeUndefined();
    expect(r.fees).toBeUndefined();
  });

  it("keeps v1 as published, replaced from the same day", () => {
    const [v1, v2] = versions();
    expect(v1).toMatchObject({ version: 1, submission: { method: "manual_export" }, inspectionReports: { submission: "unknown" } });
    expect(JSON.stringify(v1!.submission)).not.toContain("ehmaintenance");
    expect(v2!.effectiveFrom).toBe(v1!.effectiveFrom);
  });

  it("does not match a Brazoria site by county alone", async () => {
    const catalog = await loadCatalog(ctx.db);
    const r = explainSite(catalog, { county: "Brazoria County", state: "TX", jurisdictionId: null }, VISIT_DAY);
    expect(r.resolved).toBeNull();
    expect(r.candidates.map((c) => c.jurisdiction.key)).toEqual([KEY]);
  });

  it("files a valid inspection within 14 days, next visit 4 months out, and emails it only when the office presses Send", async () => {
    mail.mode = "ok";
    const { s, complete } = await brazoriaVisit(ctx);
    expect((await complete({ ...completeValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed", validationStatus: "valid" });
    await runWorker(ctx);
    const [f] = await filingsOf(s);
    expect(f).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-02-07", jurisdiction: { key: KEY }, status: "needs_review" });
    expect(f!.reviewReason).toContain("No responsible licensed maintenance provider");

    await credentials(s);
    const inspectionId = ((await s.api.get(`/filings/${f!.id}`)).json()).inspection.id as string;
    expect((await s.api.post(`/inspections/${inspectionId}/signature`, { typedName: "Owner Person" })).statusCode).toBe(200);
    expect((await filingsOf(s))[0]).toMatchObject({ status: "ready" });
    const calls = mail.calls;
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
    expect((await s.api.post(`/filings/${f!.id}/submit`, {})).statusCode).toBe(200);
    await runWorker(ctx);
    const detail = (await s.api.get(`/filings/${f!.id}`)).json();
    expect(detail.status).toBe("sent");
    expect(detail.packages[0]).toMatchObject({ method: "email", recipient: INBOX, subject: expect.stringContaining("OSSF maintenance inspection report") });
  });

  it("files a signed contract to the same inbox, also only when the office presses Send", async () => {
    mail.mode = "ok";
    const { s } = await brazoriaVisit(ctx);
    await credentials(s);
    const up = await s.api.post(`/contracts/${s.contract.id}/document`, { filename: "Signed contract.pdf", contentBase64: PDF.toString("base64"), signedOn: "2026-09-30" });
    expect(up.statusCode, up.body).toBe(201);
    await runWorker(ctx);
    const [cf] = (await s.api.get("/filings?view=all&kind=contract")).json().items as { id: string; status: string; reviewReason: string | null }[];
    expect(cf, JSON.stringify(cf)).toMatchObject({ status: "ready" });
    const calls = mail.calls;
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
    expect((await s.api.post(`/filings/${cf!.id}/submit`, {})).statusCode).toBe(200);
    await runWorker(ctx);
    const detail = (await s.api.get(`/filings/${cf!.id}`)).json();
    expect(detail.packages[0]).toMatchObject({ method: "email", recipient: INBOX, subject: expect.stringContaining("OSSF maintenance contract") });
  });

  it("keeps an inspection without a chlorine residual as a draft", async () => {
    const { complete } = await brazoriaVisit(ctx);
    const values = { ...completeValues(), air_pressure: 4.5 } as Record<string, unknown>;
    delete values.chlorine_level;
    const res = (await complete(values)).json();
    expect(res).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.validationProblems.map((p: { key: string }) => p.key)).toContain("chlorine_level");
  });

  it("allows six months between visits where electronic monitoring is on record", async () => {
    const { s, complete } = await brazoriaVisit(ctx, { monitored: true });
    expect((await complete({ ...completeValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    expect((await filingsOf(s))[0]).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-04-07" });
  });
});
