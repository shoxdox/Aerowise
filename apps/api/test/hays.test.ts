import { bundledRulesets, explainSite, loadCatalog, rulesetOn, syncRulesets } from "@aerowise/compliance";
import { drainTasks } from "@aerowise/tasks";
import { mayAutoSubmit } from "@aerowise/domain";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, JPEG, photoUrl, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

// W6.C3 and W12.C2: Hays County's draft profile (packages/compliance/rulesets/tx-hays-county).
// v2 counts visits from the contract's start (Hays County Regulations 10.V.2).
const ctx = setupTestApp({ features: ["work_orders"] });
const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });
const KEY = "tx-hays-county";
const VISIT_DAY = "2026-10-07";
const PDF = Buffer.from("%PDF-1.4\n% synthetic signed contract for tests\n%%EOF\n");

const versions = () => bundledRulesets().filter((r) => r.jurisdiction.key === KEY);
const hays = () => versions().at(-1)!;
const AUTODIALER = { method: "autodialer", description: "Acme AD-200 on the control panel", notifies: "The maintenance provider, by phone call", startedOn: "2026-09-01", checkedOn: "2026-09-15" };

type Visit = { id: string; sequence: number; windowStart: string; dueOn: string; status: string };

/**
 * A Hays County site the office has checked is outside any city with its own OSSF program,
 * under a contract starting 2026-10-06 (the day the profile begins) on a 12-month plan of 3 visits (Hays needs 4), with
 * the first visit on 2026-10-07.
 */
async function haysVisit(c: TestContext, opts: { monitored?: boolean; termMonths?: number; visitsPerTerm?: number; permitMonths?: number } = {}) {
  c.now = new Date(`${VISIT_DAY}T18:00:00Z`);
  const t = await createTenant(c, "Org A");
  const permit = opts.permitMonths ? { permitIntervalMonths: opts.permitMonths, permitIntervalNote: "Permit 12-3456, special conditions, page 2" } : {};
  expect((await t.api.patch(`/sites/${t.site.id}`, { county: "Hays", state: "TX", ...permit })).statusCode).toBe(200);
  const j = ((await t.api.get("/jurisdictions")).json().items as { id: string; key: string }[]).find((x) => x.key === KEY)!;
  const assigned = await t.api.put(`/sites/${t.site.id}/jurisdiction`, {
    jurisdictionId: j.id,
    evidenceKind: "authority_determination",
    evidenceReference: "Unincorporated; Hays County Development Services confirmed by phone 2026-10-06",
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  if (opts.monitored) expect((await t.api.post(`/systems/${t.system.id}/monitoring`, AUTODIALER)).statusCode).toBe(201);
  const plan = (await t.api.post("/plans", { name: "Annual", termMonths: opts.termMonths ?? 12, visitsPerTerm: opts.visitsPerTerm ?? 3, priceCents: 27500 })).json();
  const preview = (await t.api.get(`/sites/${t.site.id}/contract-terms?planId=${plan.id}&startOn=2026-10-06`)).json();
  const contract = await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2026-10-06", acceptVisits: preview.visitsPerTerm });
  expect(contract.statusCode, contract.body).toBe(201);
  const tech = await createUser(c.db, t.org.id, "technician");
  const techApi = client(c.app, await login(c.app, tech.email));
  const job = (await t.api.post("/jobs", { obligationId: contract.json().obligations[0].id, technicianId: tech.id, scheduledDate: VISIT_DAY })).json();
  const template = (await techApi.get("/inspection-template")).json();
  const s = { ...t, contract: contract.json(), tech, techApi, job, template } as unknown as Setup;
  const base = { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d07", jobId: job.jobId, templateId: template.id, arrivedAt: `${VISIT_DAY}T15:00:00Z`, arrivalGps: { lat: 30.0, lng: -98.0, accuracyM: 8 } };
  await techApi.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
  await uploadRequiredPhotos(s, base.clientId);
  const complete = (values: Record<string, unknown>) => techApi.put("/inspections/sync", { ...base, status: "completed", completedAt: `${VISIT_DAY}T15:40:00Z`, values });
  return { s, j, plan, preview, complete };
}

const filingsOf = async (s: Setup) => (await s.api.get("/filings?view=all&kind=inspection_report")).json().items as { id: string; status: string; [k: string]: unknown }[];
const visitsOf = async (s: Setup, contractId: string) => ((await s.api.get(`/contracts/${contractId}`)).json().obligations as Visit[]).map((v) => [v.sequence, v.windowStart, v.dueOn, v.status]);
const correctiveItems = async (s: Setup) => { const r = await s.api.get("/inbox"); if (r.statusCode !== 200) throw new Error(r.body); return (r.json().items as { kind: string; dueOn: string; detail: string; target: { id: string } }[]).filter((e) => e.kind === "corrective_report_due"); };

describe("Hays County's draft profile", () => {
  it("reads as written in v2: dated from the original order, no published way to submit reports, so nothing is ever sent", () => {
    const r = hays();
    expect(r.version).toBe(2);
    expect(r.profile).toMatchObject({ status: "draft", sourcesCheckedOn: "2026-10-06", requirementEffective: { date: "2014-02-18" } });
    expect(r.profile!.requirementEffective.basis).toContain("2013-06-04");
    expect(r.profile!.sources.every((s) => s.url.startsWith("https://") && s.retrievedOn === "2026-10-06")).toBe(true);
    expect(r.profile!.sources[0]!.note).toContain("PDF p. 19");
    expect(mayAutoSubmit(r)).toBe(false);
    expect(r.applicability).toMatchObject({ counties: ["Hays"], assignment: "reviewed", howToDecide: expect.stringContaining("512-393-2150") });
    expect(r.inspectionReports?.submission).toBe("unknown");
    expect(r.submission).toMatchObject({ method: "manual_export" });
    expect(r.submission.email).toBeUndefined();
    // The maintenance inquiry address is recorded but never used for filing.
    expect(JSON.stringify(r.submission)).not.toContain("ossfmaintenance");
    expect(r.profile!.unresolved.join(" ")).toContain("ossfmaintenance@hayscountytx.gov is listed for maintenance inquiries only");
    // Four months unless the permit says otherwise: no six-month exception for monitoring.
    expect(r.service).toMatchObject({ intervalMonths: 4, contractVisits: { firstWithinDays: 14, lastWithinDaysOfEnd: 14 }, correctiveReport: { withinDays: 10 } });
    expect(r.service.monitored).toBeUndefined();
    expect(r.filing.deadlineDays).toBe(14);
    expect(r.contracts).toMatchObject({ filingRequired: true, renewalDaysBeforePreviousEnd: 30, submission: "unknown", renewalNeedsPriorReports: true, newProviderMinimum: { termMonths: 12, visits: 4 } });
    expect(r.provider?.countyRegistration).toMatchObject({ required: true, renews: expect.stringContaining("December 31") });
    // The $50 late fee's trigger is not published, so nothing is charged.
    expect(r.fees).toBeUndefined();
    expect(r.profile!.unresolved.join(" ")).toContain("$50 maintenance contract late fee");
    expect(r.inspection.requiredFields).toEqual([]);
    expect(r.labTests).toBeUndefined();
  });

  it("replaces v1 from the day v1 began, and leaves v1 as it was published", async () => {
    const [v1, v2] = versions();
    expect(v1).toMatchObject({ version: 1, effectiveFrom: "2026-10-06", service: { monitored: { intervalMonths: 6 } } });
    expect(v2).toMatchObject({ version: 2, effectiveFrom: "2026-10-06" });
    const entry = (await loadCatalog(ctx.db)).find((e) => e.jurisdiction.key === KEY)!;
    expect(entry.rulesets.map((r) => r.version)).toEqual([2, 1]);
    expect(rulesetOn(entry, "2026-10-06")?.version).toBe(2);
  });

  it("does not match a Hays site by county alone: cities with their own programs are excluded", async () => {
    const catalog = await loadCatalog(ctx.db);
    const r = explainSite(catalog, { county: "Hays County", state: "TX", jurisdictionId: null }, VISIT_DAY);
    expect(r.resolved).toBeNull();
    expect(r.candidates.map((c) => c.jurisdiction.key)).toEqual([KEY]);
  });
});

describe("Hays County visits counted from the contract's start (10.V.2)", () => {
  it("asks for a fourth visit on a 12-month plan of three, saying why", async () => {
    const { preview } = await haysVisit(ctx);
    expect(preview).toEqual({
      planVisits: 3,
      visitsPerTerm: 4,
      warning:
        "Hays County Development Services, On-Site Sewage Facilities counts visits from the contract's start: one within 14 days of it, one at least every 4 months, and one in the last 14 days, so this contract needs 4 visits instead of the plan's 3, at the same price. " +
        'Aerowise reads "within 14 days of the end of the contract period" as the 14 days before the end; Hays County has not confirmed this. Create it with 4 visits?',
      scheduleNotice: null,
      systemWarning: null,
    });
  });

  it("schedules the first visit within 14 days of the start, the next every 4 months from it and the last in the final 14 days", async () => {
    const { s } = await haysVisit(ctx);
    expect(s.contract).toMatchObject({ startOn: "2026-10-06", endOn: "2027-10-05", visitsPerTerm: 4 });
    expect(await visitsOf(s, s.contract.id)).toEqual([
      [1, "2026-10-06", "2026-10-20", "open"],
      [2, "2026-10-21", "2027-02-06", "open"],
      [3, "2027-02-07", "2027-06-06", "open"],
      [4, "2027-09-21", "2027-10-05", "open"],
    ]);
  });

  it("anchors a contract that starts between visits to its own start, not to the last visit", async () => {
    // The site was last inspected under another arrangement in August; the new contract still
    // counts from 2026-10-06.
    const { s } = await haysVisit(ctx, { termMonths: 24, visitsPerTerm: 6 });
    expect(s.contract).toMatchObject({ endOn: "2028-10-05", visitsPerTerm: 7 });
    expect((await visitsOf(s, s.contract.id)).map((v) => v[2])).toEqual(["2026-10-20", "2027-02-06", "2027-06-06", "2027-10-06", "2028-02-06", "2028-06-06", "2028-10-05"]);
  });

  it("makes the first visit's report due by that visit's due date, and holds it for review", async () => {
    mail.mode = "ok";
    const { s, complete } = await haysVisit(ctx);
    expect((await complete({ ...completeValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed", validationStatus: "valid" });
    await runWorker(ctx);
    const [f] = await filingsOf(s);
    // 14 days after the inspection would be 2026-10-21; the first report is due within 14 days of the start.
    expect(f).toMatchObject({ deadlineOn: "2026-10-20", nextDueOn: "2027-02-07", jurisdiction: { key: KEY }, status: "needs_review" });
    const detail = (await s.api.get(`/filings/${f!.id}`)).json();
    expect(detail.deadlineBasis).toContain("counts report due dates from the contract's start: visit 1's test and report are due by 2026-10-20 (Aerowise reads");
    const calls = mail.calls;
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
  });

  it("keeps four months between visits even where electronic monitoring is on record", async () => {
    const { s, complete } = await haysVisit(ctx, { monitored: true });
    expect(s.contract).toMatchObject({ visitsPerTerm: 4 });
    expect((await complete({ ...completeValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    expect((await filingsOf(s))[0]).toMatchObject({ deadlineOn: "2026-10-20", nextDueOn: "2027-02-07" });
  });

  it("uses the interval the site's permit sets, recorded with where it was read", async () => {
    // "Every four (4) months unless otherwise specified on the permit": a six-month permit
    // makes a 12-month plan of three visits enough.
    const { s, preview, complete } = await haysVisit(ctx, { permitMonths: 6 });
    expect(preview).toMatchObject({ planVisits: 3, visitsPerTerm: 3, warning: null });
    expect(await visitsOf(s, s.contract.id)).toEqual([
      [1, "2026-10-06", "2026-10-20", "open"],
      [2, "2026-10-21", "2027-04-06", "open"],
      [3, "2027-09-21", "2027-10-05", "open"],
    ]);
    expect((await complete({ ...completeValues(), air_pressure: 4.5 })).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    expect((await filingsOf(s))[0]).toMatchObject({ deadlineOn: "2026-10-20", nextDueOn: "2027-04-07" });
    // A permit interval is not recorded without saying where it was read.
    const bare = await s.api.patch(`/sites/${s.site.id}`, { permitIntervalNote: null });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().message ?? bare.body).toContain("permitIntervalNote");
  });

  it("keeps an inspection without a chlorine residual as a draft", async () => {
    const { complete } = await haysVisit(ctx);
    const values = { ...completeValues(), air_pressure: 4.5 } as Record<string, unknown>;
    delete values.chlorine_level;
    const res = (await complete(values)).json();
    expect(res).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.validationProblems.map((p: { key: string }) => p.key)).toContain("chlorine_level");
  });
});

describe("Hays County corrective reports (10.V.4)", () => {
  it("asks for a fix, retest and new report within ten days of the report, as an extra visit that leaves the contract's visits alone", async () => {
    const { s, complete } = await haysVisit(ctx);
    const done = (await complete({ ...completeValues(), air_pressure: 4.5, chlorine_level: 0 })).json();
    expect(done).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    const before = await visitsOf(s, s.contract.id);

    const [item] = await correctiveItems(s);
    // The report was made 2026-10-07 and has not been sent (no published channel).
    expect(item).toMatchObject({ dueOn: "2026-10-17", target: { id: done.id }, detail: expect.stringContaining("within 10 days of the previous report (counted from the report's date, 2026-10-07, until it is sent; Aerowise's reading") });

    // Booking the retest uses none of the contract's visits.
    const retest = await s.api.post("/jobs", { retestOfInspectionId: done.id, technicianId: s.tech.id, scheduledDate: "2026-10-12" });
    expect(retest.statusCode, retest.body).toBe(201);
    expect(retest.json()).toMatchObject({ obligation: null, scheduledDate: "2026-10-12" });
    expect((await correctiveItems(s))[0]!.detail).toContain("Retest booked for 2026-10-12");
    expect(await visitsOf(s, s.contract.id)).toEqual(before);

    ctx.now = new Date("2026-10-12T18:00:00Z");
    const base = { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d12", jobId: retest.json().jobId, templateId: s.template.id, arrivedAt: "2026-10-12T15:00:00Z", arrivalGps: { lat: 30.0, lng: -98.0, accuracyM: 8 } };
    await s.techApi.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
    for (const [n, key] of [[3, "overview"], [4, "chlorinator"]] as const) {
      const photo = await s.techApi.putImage(photoUrl(base.clientId, n), JPEG, { "x-photo-key": key, "x-captured-at": "2026-10-12T15:10:00Z" });
      expect(photo.statusCode).toBe(201);
    }
    const fixed = await s.techApi.put("/inspections/sync", { ...base, status: "completed", completedAt: "2026-10-12T15:30:00Z", values: { ...completeValues(), air_pressure: 4.5 } });
    expect(fixed.json()).toMatchObject({ status: "completed", validationStatus: "valid" });
    await runWorker(ctx);

    expect(await correctiveItems(s)).toEqual([]);
    // The retest's report keeps the usual 14 days; the regular visits stay where they were.
    expect((await filingsOf(s)).find((f) => (f.inspection as { id: string } | null)?.id === fixed.json().id)).toMatchObject({ deadlineOn: "2026-10-26" });
    expect((await visitsOf(s, s.contract.id)).slice(1)).toEqual(before.slice(1));
  });

  it("does not read a work visit at the site as a booked retest, and keeps the retest's link to its inspection", async () => {
    const { s, complete } = await haysVisit(ctx);
    const done = (await complete({ ...completeValues(), air_pressure: 4.5, chlorine_level: 0 })).json();
    await runWorker(ctx);
    const pumping = ((await s.api.get("/work-types")).json().items as { id: string; key: string }[]).find((t) => t.key === "pumping")!;
    const wo = (await s.api.post("/work-orders", { siteId: s.site.id, workTypeId: pumping.id })).json();
    expect((await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-10-10" })).statusCode).toBe(201);
    expect((await correctiveItems(s))[0]!.detail).not.toContain("Retest booked");

    const retest = (await s.api.post("/jobs", { retestOfInspectionId: done.id, technicianId: s.tech.id, scheduledDate: "2026-10-12" })).json();
    expect((await correctiveItems(s))[0]!.detail).toContain("Retest booked for 2026-10-12");
    const row = await ctx.db.selectFrom("jobs").select(["type", "retestOfInspectionId", "obligationId"]).where("id", "=", retest.jobId).executeTakeFirstOrThrow();
    expect(row).toEqual({ type: "inspection", retestOfInspectionId: done.id, obligationId: null });
  });

  it("is not raised for a report with everything working", async () => {
    const { s, complete } = await haysVisit(ctx);
    await complete({ ...completeValues(), air_pressure: 4.5 });
    await runWorker(ctx);
    expect(await correctiveItems(s)).toEqual([]);
  });

  it("refuses a retest of an inspection the company does not have, or a job with neither a visit nor a retest", async () => {
    const { s } = await haysVisit(ctx);
    const other = await createTenant(ctx, "Org B");
    expect((await other.api.post("/jobs", { retestOfInspectionId: s.job.jobId, technicianId: s.tech.id, scheduledDate: "2026-10-12" })).statusCode).toBe(422);
    expect((await s.api.post("/jobs", { technicianId: s.tech.id, scheduledDate: "2026-10-12" })).statusCode).toBe(400);
  });
});

describe("Hays County contract filings (10.V.2, 10.V.6)", () => {
  it("holds a same-provider renewal while a report from the previous contract is unsent", async () => {
    const { s, complete } = await haysVisit(ctx);
    await complete({ ...completeValues(), air_pressure: 4.5 });
    await runWorker(ctx);
    const renewal = await s.api.post(`/contracts/${s.contract.id}/renew`, {});
    expect(renewal.statusCode, renewal.body).toBe(201);
    expect(renewal.json()).toMatchObject({ startOn: "2027-10-06", visitsPerTerm: 4 });
    const up = await s.api.post(`/contracts/${renewal.json().id}/document`, { filename: "Signed renewal.pdf", contentBase64: PDF.toString("base64"), signedOn: "2026-10-07" });
    expect(up.statusCode, up.body).toBe(201);
    await runWorker(ctx);
    const cf = ((await s.api.get("/filings?view=all&kind=contract")).json().items as { contract: { id: string } | null; status: string; reviewReason: string }[]).find((f) => f.contract?.id === renewal.json().id);
    expect(cf).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("only after every report from the previous contract has been submitted; 1 visit is due by now without a sent report") });
  });

  it("asks for a year and four inspections when a contract may follow another provider's", async () => {
    const { s } = await haysVisit(ctx, { termMonths: 6, visitsPerTerm: 2 });
    expect(s.contract).toMatchObject({ termMonths: 6, visitsPerTerm: 3 });
    expect((await s.api.put(`/contracts/${s.contract.id}/filing-basis`, { basis: "renewal", basisOn: "2026-10-05", note: "Took over from another provider" })).statusCode).toBe(200);
    const up = await s.api.post(`/contracts/${s.contract.id}/document`, { filename: "Signed contract.pdf", contentBase64: PDF.toString("base64"), signedOn: "2026-09-28" });
    expect(up.statusCode, up.body).toBe(201);
    await runWorker(ctx);
    const [cf] = (await s.api.get("/filings?view=all&kind=contract")).json().items as { status: string; reviewReason: string }[];
    expect(cf).toMatchObject({
      status: "needs_review",
      reviewReason: expect.stringContaining("If the previous contract was with another provider, Hays County Development Services, On-Site Sewage Facilities requires this one to run at least 12 months with 4 inspections, counting the first; it runs 6 months with 3"),
    });
  });
});

describe("Hays County v2 arriving after v1 was in use", () => {
  // The other tests run with every bundled ruleset; this one changes them, so put them back.
  afterAll(async () => {
    await sql`truncate jurisdiction_rulesets, jurisdictions cascade`.execute(ctx.db);
    await syncRulesets(ctx.db);
  });

  it("leaves contracts and filings made under v1 as they were", async () => {
    await sql`truncate jurisdiction_rulesets, jurisdictions cascade`.execute(ctx.db);
    await syncRulesets(ctx.db, bundledRulesets().filter((r) => r.jurisdiction.key !== KEY || r.version === 1));
    const { s, preview, complete } = await haysVisit(ctx);
    // v1 splits a 12-month plan of three visits evenly.
    expect(preview).toMatchObject({ visitsPerTerm: 3, warning: null });
    expect((await complete({ ...completeValues(), air_pressure: 4.5, chlorine_level: 0 })).json()).toMatchObject({ status: "completed" });
    await runWorker(ctx);
    const visits = await visitsOf(s, s.contract.id);
    const [filing] = await filingsOf(s);
    expect(filing).toMatchObject({ jurisdiction: { rulesetVersion: 1 }, deadlineOn: "2026-10-21" });

    await syncRulesets(ctx.db);
    await runWorker(ctx);
    expect(await visitsOf(s, s.contract.id)).toEqual(visits);
    expect((await filingsOf(s))[0]).toMatchObject({ id: filing!.id, jurisdiction: { rulesetVersion: 1 }, deadlineOn: "2026-10-21", nextDueOn: filing!.nextDueOn });
    // The ten-day corrective report belongs to v2, so a v1 report raises none.
    expect(await correctiveItems(s)).toEqual([]);
  });
});
