import { bundledRulesets, explainSite, loadCatalog } from "@aerowise/compliance";
import { drainTasks } from "@aerowise/tasks";
import { mayAutoSubmit } from "@aerowise/domain";
import { describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

// W6.C15: Montgomery County's draft profile (packages/compliance/rulesets/tx-montgomery-county).
const ctx = setupTestApp();
const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });
const KEY = "tx-montgomery-county";
const VISIT_DAY = "2026-10-07";

const versions = () => bundledRulesets().filter((r) => r.jurisdiction.key === KEY);
const montgomery = () => versions().at(-1)!;
const AUTODIALER = { method: "autodialer", description: "Acme AD-200 on the control panel", notifies: "The maintenance provider, by phone call", startedOn: "2026-09-01", checkedOn: "2026-09-15" };

/** An unincorporated Montgomery County site away from Lake Conroe, under contract, with a visit on 2026-10-07. */
async function montgomeryVisit(c: TestContext, opts: { monitored?: boolean; site?: Record<string, unknown>; acceptVisits?: number; startOn?: string } = {}) {
  c.now = new Date(`${VISIT_DAY}T18:00:00Z`);
  const t = await createTenant(c, "Org A");
  const patched = await t.api.patch(`/sites/${t.site.id}`, { county: "Montgomery", state: "TX", ...opts.site });
  expect(patched.statusCode, patched.body).toBe(200);
  const j = ((await t.api.get("/jurisdictions")).json().items as { id: string; key: string }[]).find((x) => x.key === KEY)!;
  const assigned = await t.api.put(`/sites/${t.site.id}/jurisdiction`, {
    jurisdictionId: j.id,
    evidenceKind: "authority_determination",
    evidenceReference: "Unincorporated, away from Lake Conroe; Montgomery County Environmental Health confirmed by phone 2026-10-06",
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  if (opts.monitored) expect((await t.api.post(`/systems/${t.system.id}/monitoring`, AUTODIALER)).statusCode).toBe(201);
  const plan = (await t.api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
  const preview = (await t.api.get(`/sites/${t.site.id}/contract-terms?planId=${plan.id}&startOn=${opts.startOn ?? "2026-10-01"}`)).json();
  const contract = await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: opts.startOn ?? "2026-10-01", acceptVisits: opts.acceptVisits });
  expect(contract.statusCode, contract.body).toBe(201);
  const tech = await createUser(c.db, t.org.id, "technician");
  const techApi = client(c.app, await login(c.app, tech.email));
  const job = (await t.api.post("/jobs", { obligationId: contract.json().obligations[0].id, technicianId: tech.id, scheduledDate: VISIT_DAY })).json();
  const template = (await techApi.get("/inspection-template")).json();
  const s = { ...t, contract: contract.json(), tech, techApi, job, template } as unknown as Setup;
  const base = { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d07", jobId: job.jobId, templateId: template.id, arrivedAt: `${VISIT_DAY}T15:00:00Z`, arrivalGps: { lat: 30.3, lng: -95.5, accuracyM: 8 } };
  await techApi.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
  await uploadRequiredPhotos(s, base.clientId);
  const complete = (values: Record<string, unknown>) => techApi.put("/inspections/sync", { ...base, status: "completed", completedAt: `${VISIT_DAY}T15:40:00Z`, values });
  return { s, j, complete, preview };
}

const filingsOf = async (s: Setup) => (await s.api.get("/filings?view=all&kind=inspection_report")).json().items as { id: string; status: string; [k: string]: unknown }[];

describe("Montgomery County's draft profile", () => {
  it("reads as written: no published way to submit reports, so nothing is ever sent", () => {
    const r = montgomery();
    expect(r.version).toBe(2);
    expect(r.profile).toMatchObject({ status: "draft", sourcesCheckedOn: "2026-10-06", requirementEffective: { date: "2021-03-04" } });
    expect(r.profile!.sources.every((s) => s.url.startsWith("https://") && s.retrievedOn === "2026-10-06")).toBe(true);
    expect(r.profile!.unresolved.length).toBeGreaterThan(0);
    expect(mayAutoSubmit(r)).toBe(false);
    expect(r.applicability).toMatchObject({ counties: ["Montgomery"], assignment: "reviewed", howToDecide: expect.stringContaining("Keith Miles (936-539-7839)") });
    expect(r.inspectionReports?.submission).toBe("unknown");
    expect(r.submission).toMatchObject({ method: "manual_export" });
    expect(r.submission.email).toBeUndefined();
    // The general form says three a year, one every four months, and is silent on monitoring.
    // The food establishment form's monthly initial term is kept apart, never applied by itself.
    expect(r.service).toEqual({
      intervalMonths: 4,
      categoryTerms: [
        {
          useCategories: ["food_establishment"],
          initialTermMonths: 24,
          initialIntervalMonths: 1,
          renewalIntervalMonths: null,
          source: expect.stringContaining("revised 2009-11-25"),
          unconfirmed: expect.stringContaining("has not said whether that form still controls"),
        },
      ],
    });
    expect(r.filing.deadlineDays).toBe(14);
    expect(r.contracts).toMatchObject({ filingRequired: true, renewalDaysBeforePreviousEnd: 30 });
    expect(r.inspection.requiredFields).toEqual([]);
    expect(r.labTests).toMatchObject({ analytes: ["bod", "tss"], everyMonths: 12, appliesTo: ["commercial"], useCategories: ["multifamily", "commercial", "food_establishment"] });
    expect(r.profile!.sources.some((s) => s.url.includes("620145.pdf"))).toBe(true);
    expect(r.profile!.unresolved.join(" ")).toContain("mc.maint@mctx.org is for open records requests");
    expect(JSON.stringify(r)).not.toContain('"email"');
    expect(r.labTests!.limits).toBeUndefined();
  });

  it("does not match a Montgomery site by county alone", async () => {
    const catalog = await loadCatalog(ctx.db);
    const r = explainSite(catalog, { county: "Montgomery County", state: "TX", jurisdictionId: null }, VISIT_DAY);
    expect(r.resolved).toBeNull();
    expect(r.candidates.map((c) => c.jurisdiction.key)).toEqual([KEY, "tx-sjra-ossf"]);
  });

  it("dates a valid inspection's filing 14 days out with the next visit in 4 months, and holds it for review", async () => {
    mail.mode = "ok";
    const { s, complete } = await montgomeryVisit(ctx);
    expect((await complete({ ...completeValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed", validationStatus: "valid" });
    await runWorker(ctx);
    const [f] = await filingsOf(s);
    expect(f).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-02-07", jurisdiction: { key: KEY }, status: "needs_review" });
    const calls = mail.calls;
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
  });

  it("keeps an inspection without a chlorine residual as a draft", async () => {
    const { complete } = await montgomeryVisit(ctx);
    const values = { ...completeValues(), air_pressure: 4.5 } as Record<string, unknown>;
    delete values.chlorine_level;
    const res = (await complete(values)).json();
    expect(res).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.validationProblems.map((p: { key: string }) => p.key)).toContain("chlorine_level");
  });

  it("keeps four months between visits even where electronic monitoring is on record", async () => {
    const { s, complete } = await montgomeryVisit(ctx, { monitored: true });
    expect((await complete({ ...completeValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    expect((await filingsOf(s))[0]).toMatchObject({ deadlineOn: "2026-10-21", nextDueOn: "2027-02-07" });
  });

  it("keeps v1 as published, replaced from the same day", () => {
    const [v1, v2] = versions();
    expect(v1!.version).toBe(1);
    expect(v1!.service).toEqual({ intervalMonths: 4 });
    expect(v2!.effectiveFrom).toBe(v1!.effectiveFrom);
  });
});

describe("Montgomery County sites by what they serve", () => {
  // v2 applies from 2026-10-06, so these contracts start after it.
  const visit = (opts: Parameters<typeof montgomeryVisit>[1] = {}) => montgomeryVisit(ctx, { startOn: VISIT_DAY, ...opts });
  const notice = async (s: Setup) => (await s.api.get(`/sites/${s.site.id}/jurisdiction`)).json().scheduleNotice as string | null;
  const values = { ...completeValues(), air_pressure: 4.5 };

  it("never schedules a food establishment monthly from the 2009 form alone: four months, held, and the reason shown", async () => {
    const { s, complete, preview } = await visit({ site: { customerType: "commercial", useCategory: "food_establishment" } });
    // Nothing added to the plan, and the uncertainty is said before the contract is made.
    expect(preview).toMatchObject({ planVisits: 3, visitsPerTerm: 3, warning: null, scheduleNotice: expect.stringContaining("asks for an inspection every month during the first 24 months for a food establishment") });
    expect(preview.scheduleNotice).toContain("has not said whether that form still controls");
    expect(s.contract.obligations).toHaveLength(3);
    expect(await notice(s)).toBe(preview.scheduleNotice);
    expect((await complete(values)).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    const [f] = await filingsOf(s);
    expect(f).toMatchObject({ nextDueOn: "2027-02-07", status: "needs_review", reviewReason: expect.stringContaining("Record this site's interval from its current contract or permit") });
  });

  it("schedules a food establishment monthly once its own contract or permit interval is recorded", async () => {
    const { s, complete, preview } = await visit({
      site: { customerType: "commercial", useCategory: "food_establishment", permitIntervalMonths: 1, permitIntervalNote: "Signed initial contract with the owner, 2026-09-30, clause 2" },
      acceptVisits: 12,
    });
    expect(preview).toMatchObject({ planVisits: 3, visitsPerTerm: 12, scheduleNotice: null, warning: expect.stringContaining("at least every 1 month") });
    expect(s.contract.obligations).toHaveLength(12);
    expect(await notice(s)).toBeNull();
    expect((await complete(values)).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    const [f] = await filingsOf(s);
    expect(f).toMatchObject({ nextDueOn: "2026-11-07", status: "needs_review" });
    expect(f!.reviewReason).not.toContain("Record this site's interval");
  });

  it("asks for the use where nobody has recorded it, and leaves other sites at four months", async () => {
    const unset = await visit();
    expect(await notice(unset.s)).toContain("rules differ by what the system serves");
    expect(unset.preview).toMatchObject({ visitsPerTerm: 3, scheduleNotice: expect.stringContaining("Record this site's use") });
    const home = await visit({ site: { useCategory: "single_family", permitIntervalMonths: 6, permitIntervalNote: "Permit 12-3456" } });
    // A recorded interval only counts where the authority defers to it.
    expect(home.preview).toMatchObject({ visitsPerTerm: 3, scheduleNotice: null });
    expect(await notice(home.s)).toBeNull();
  });

  it("asks commercial and multifamily systems for annual BOD and TSS, by recorded use", async () => {
    const lab = async (site: Record<string, unknown>, acceptVisits?: number) => {
      const { s } = await visit({ site, acceptVisits });
      return (await s.api.get(`/sites/${s.site.id}/lab-tests`)).json().requirement as { analytes: string[]; everyMonths: number } | null;
    };
    expect(await lab({ useCategory: "multifamily" })).toMatchObject({ analytes: ["bod", "tss"], everyMonths: 12 });
    expect(await lab({ customerType: "commercial", useCategory: "food_establishment", permitIntervalMonths: 1, permitIntervalNote: "Contract clause 2" }, 12)).toMatchObject({ everyMonths: 12 });
    expect(await lab({ customerType: "commercial", useCategory: "single_family" })).toBeNull();
    // Without a recorded use, residential or commercial still decides.
    expect(await lab({ customerType: "commercial" })).toMatchObject({ everyMonths: 12 });
    expect(await lab({})).toBeNull();
  });
});
