import { createHash } from "node:crypto";
import { bundledRulesets, contractDeadline, ensurePackage, explainSite, loadCatalog, loadFiling, submitFiling, type ResolvedJurisdiction } from "@aerowise/compliance";
import { complianceContext, drainTasks, runContractFilings } from "@aerowise/tasks";
import { contractFilingRequired, mayAutoSubmit, profileStatus, type ContractFilingBasis, type RulesetRules } from "@aerowise/domain";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { client, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, JPEG, payload, setup, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

const ctx = setupTestApp();
const mail = new FakeMail();
const tasks = (c: TestContext) => ({ db: c.db, store: c.store, now: () => c.now, mail });
const runWorker = (c: TestContext) => drainTasks(tasks(c));
const later = (c: TestContext, ms: number) => (c.now = new Date(c.now.getTime() + ms));

const LCRA_ID = "lcra_ossf_application_number";
const PDF = Buffer.from("%PDF-1.4\n% synthetic signed contract for tests\n%%EOF\n");

/** A visit at a Travis County site: inside the counties LCRA's OSSF area touches. */
async function lcraSetup(c: TestContext, name = "Org A") {
  const s = await setup(c, name);
  expect((await s.api.patch(`/sites/${s.site.id}`, { county: "Travis", state: "TX" })).statusCode).toBe(200);
  return s;
}

async function complete(s: Setup) {
  const p = payload(s);
  await s.techApi.put("/inspections/sync", p);
  await uploadRequiredPhotos(s, p.clientId);
  const res = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: { ...completeValues(), air_pressure: 4.5 } }));
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string };
}

const lcra = async (s: Setup) => ((await s.api.get("/jurisdictions")).json().items as { id: string; key: string }[]).find((j) => j.key === "tx-lcra-ossf")!;

/** The site assigned to LCRA from the map, as the office would after looking it up. */
async function assignLcra(s: Setup) {
  const j = await lcra(s);
  const res = await s.api.put(`/sites/${s.site.id}/jurisdiction`, {
    jurisdictionId: j.id,
    evidenceKind: "authority_map",
    evidenceReference: "waterquality.lcra.org/ossf, address inside the red area, checked 2026-02-27",
  });
  expect(res.statusCode).toBe(200);
  return j;
}

/** The credentials and identifier LCRA's cover sheet needs. */
async function credentialsAndIdentifier(s: Setup, j: { id: string }) {
  const mp = await s.api.post("/credentials", {
    userId: s.owner.id,
    holderName: "Owner Person",
    kind: "tceq_maintenance_provider",
    number: "MP0001234",
    verifiedOn: "2026-02-20",
    verificationSource: "TCEQ license search",
  });
  expect(mp.statusCode).toBe(201);
  const mt = await s.api.post("/credentials", { userId: s.tech.id, holderName: "Tech Person", kind: "tceq_maintenance_technician", number: "MT0005678", expiresOn: "2027-01-31" });
  expect(mt.statusCode).toBe(201);
  expect((await s.api.put("/settings/responsible-provider", { credentialId: mp.json().id })).statusCode).toBe(200);
  const id = await s.api.put(`/sites/${s.site.id}/authority-identifiers/${LCRA_ID}`, { jurisdictionId: j.id, value: "OSSF-2019-0412", sourceNote: "License to operate on file" });
  expect(id.statusCode).toBe(200);
  return { mp: mp.json(), mt: mt.json() };
}

const filings = async (s: Setup, kind?: string) => (await s.api.get(`/filings?view=all${kind ? `&kind=${kind}` : ""}`)).json().items as { id: string; kind: string; status: string; reviewReason: string | null; [k: string]: unknown }[];
const detailOf = async (s: Setup, id: string) => (await s.api.get(`/filings/${id}`)).json();

/** A Travis County inspection filing, assigned to LCRA with everything it needs, ready to send. */
async function readyLcraFiling(c: TestContext, name = "Org A") {
  const s = await lcraSetup(c, name);
  await complete(s);
  await runWorker(c);
  const j = await assignLcra(s);
  await credentialsAndIdentifier(s, j);
  const [f] = await filings(s, "inspection_report");
  // Everything else is in place; only the maintenance provider's signature holds it.
  expect((await s.api.post(`/filings/${f!.id}/recheck`, {})).json()).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("sign the authority report (version 1)") });
  expect(await signReport(s, f!.id)).toMatchObject({ status: "ready" });
  return { s, j, filingId: f!.id };
}

/** The owner, who holds the MP license, signs the latest authority report of the filing's inspection. */
async function signReport(s: Setup, filingId: string, typedName = "Owner Person") {
  const inspectionId = (await detailOf(s, filingId)).inspection.id as string;
  const res = await s.api.post(`/inspections/${inspectionId}/signature`, { typedName });
  expect(res.statusCode, res.body).toBe(200);
  return (await filings(s, "inspection_report")).find((f) => f.id === filingId)!;
}

describe("authority profiles", () => {
  const ruleset = (key: string) => bundledRulesets().find((r) => r.jurisdiction.key === key)!;

  it("never let a draft profile send on its own", () => {
    const example = ruleset("tx-example-county");
    expect(profileStatus(example)).toBe("fictional");
    expect(mayAutoSubmit(example)).toBe(true);
    const draft = { ...example, profile: { status: "draft" as const, sourcesCheckedOn: "2026-10-04", requirementEffective: { date: null, basis: "x" }, sources: [], unresolved: ["x"] } };
    expect(mayAutoSubmit(draft)).toBe(false);
    // Verified sends on its own only with the record of who confirmed it with the authority (W6.5).
    const verified = { ...draft, profile: { ...draft.profile, status: "verified" as const, unresolved: [] } };
    expect(mayAutoSubmit(verified)).toBe(false);
    const verification = { confirmedWith: "x", confirmedBy: "y", confirmedOn: "2026-10-05", method: "email" as const, evidence: "z" };
    expect(mayAutoSubmit({ ...verified, profile: { ...verified.profile, verification } })).toBe(true);
  });

  it("read the LCRA and Harris drafts as written", () => {
    const lcra = ruleset("tx-lcra-ossf");
    expect(lcra.applicability.assignment).toBe("reviewed");
    expect(lcra.coverSheet?.fields.filter((f) => f.required).map((f) => f.label)).toEqual(["Date", "Maintenance Provider Name", "TCEQ MP #", "LCRA OSSF Application Number"]);
    expect(contractFilingRequired(lcra)).toBe(true);
    const harris = ruleset("tx-harris-county-oce");
    expect(harris.inspectionReports?.submission).toBe("unknown");
    // The day the sources were read is not presented as when Harris County's rule took effect.
    expect(harris.profile).toMatchObject({ sourcesCheckedOn: "2026-10-04", requirementEffective: { date: null } });
    expect(lcra.profile?.requirementEffective.date).toBe("2010-04-05");
    // The six-month electronic-monitoring schedule stays off: every real authority is four months.
    for (const r of [lcra, harris]) expect(r.service.intervalMonths).toBe(4);
  });
});

describe("authority selection", () => {
  it("does not guess LCRA from the county: the site waits for a reviewed choice with evidence", async () => {
    mail.mode = "ok";
    const s = await lcraSetup(ctx);
    const before = (await s.api.get(`/sites/${s.site.id}/jurisdiction`)).json();
    expect(before).toMatchObject({ source: "none", jurisdiction: null, reviewReason: expect.stringContaining("may cover part of Travis County") });
    // Travis County's own office covers the rest of the county, so it is a candidate too.
    expect(before.candidates.map((c: { key: string }) => c.key)).toEqual(["tx-lcra-ossf", "tx-travis-county"]);

    await complete(s);
    await runWorker(ctx);
    const [f] = await filings(s, "inspection_report");
    expect(f).toMatchObject({ status: "needs_review", jurisdiction: null, reviewReason: expect.stringContaining("Travis County") });

    // A choice by hand needs what it rests on, and is kept with that evidence.
    const j = await lcra(s);
    expect((await s.api.put(`/sites/${s.site.id}/jurisdiction`, { jurisdictionId: j.id })).statusCode).toBe(400);
    await assignLcra(s);
    const after = (await s.api.get(`/sites/${s.site.id}/jurisdiction`)).json();
    expect(after).toMatchObject({
      source: "override",
      jurisdiction: { key: "tx-lcra-ossf", assignment: "reviewed", profileStatus: "draft" },
      assignment: { evidenceKind: "authority_map", evidenceReference: expect.stringContaining("red area"), assignedBy: "owner user" },
      profile: { status: "draft", howToDecide: expect.stringContaining("waterquality.lcra.org") },
    });
    expect(after.identifiers).toEqual([expect.objectContaining({ key: LCRA_ID, required: true, value: null })]);

    // Changing the choice adds to the history; the earlier assignment is kept as it was.
    await s.api.put(`/sites/${s.site.id}/jurisdiction`, { jurisdictionId: null });
    expect((await s.api.get(`/sites/${s.site.id}/jurisdiction`)).json()).toMatchObject({ source: "none", assignment: null });
    const history = await ctx.db.selectFrom("siteAuthorityAssignments").select(["jurisdictionId", "evidenceKind"]).where("siteId", "=", s.site.id).orderBy("assignedAt").execute();
    expect(history).toEqual([{ jurisdictionId: j.id, evidenceKind: "authority_map" }, { jurisdictionId: null, evidenceKind: null }]);
    await expect(sql`update site_authority_assignments set evidence_reference = 'x'`.execute(ctx.db)).rejects.toThrow(/immutable/);
  });

  it("sends a whole-county authority straight through, and refuses to pick between two", async () => {
    const catalog = await loadCatalog(ctx.db);
    const site = (county: string) => ({ county, state: "TX", jurisdictionId: null });
    expect(explainSite(catalog, site("Example County"), "2026-03-01").resolved?.key).toBe("tx-example-county");
    // LCRA covers only part of these counties.
    for (const county of ["Burnet County", "llano"]) {
      const r = explainSite(catalog, site(county), "2026-03-01");
      expect(r.resolved).toBeNull();
      expect(r.candidates.map((c) => c.jurisdiction.key)).toEqual(["tx-lcra-ossf"]);
    }
    // In Travis, LCRA and Travis County each cover part: a person picks.
    const travis = explainSite(catalog, site("Travis"), "2026-10-06");
    expect(travis.resolved).toBeNull();
    expect(travis.candidates.map((c) => c.jurisdiction.key)).toEqual(["tx-lcra-ossf", "tx-travis-county"]);
    // Harris County's office is assigned by review too; the county is not enough.
    expect(explainSite(catalog, site("Harris"), "2026-10-04").resolved).toBeNull();
    const twin = structuredClone(catalog.find((e) => e.jurisdiction.key === "tx-example-county")!);
    twin.jurisdiction.id = crypto.randomUUID();
    expect(explainSite([...catalog, twin], site("Example County"), "2026-03-01")).toMatchObject({ resolved: null, reviewReason: expect.stringContaining("More than one") });
  });
});

describe("credentials and identifiers", () => {
  it("lists what is missing before a package can be made, and builds the LCRA cover sheet once it is all there", async () => {
    mail.mode = "ok";
    const s = await lcraSetup(ctx);
    await complete(s);
    await runWorker(ctx);
    const j = await assignLcra(s);
    const [f] = await filings(s, "inspection_report");
    const held = (await s.api.post(`/filings/${f!.id}/recheck`, {})).json();
    expect(held.status).toBe("needs_review");
    expect(held.reviewReason).toContain("LCRA OSSF Application Number");
    expect(held.reviewReason).toContain("No responsible licensed maintenance provider");
    expect(held.reviewReason).toContain("maintenance technician registration");

    // The responsible provider must hold an MP license, not a technician registration.
    const mt = (await s.api.post("/credentials", { userId: s.tech.id, holderName: "Tech Person", kind: "tceq_maintenance_technician", number: "MT0005678" })).json();
    expect((await s.api.put("/settings/responsible-provider", { credentialId: mt.id })).statusCode).toBe(422);
    // Verification is recorded with its source or not at all, and numbers are not duplicated.
    expect((await s.api.post("/credentials", { holderName: "X", kind: "tceq_maintenance_provider", number: "MP9", verifiedOn: "2026-02-01" })).statusCode).toBe(400);
    expect((await s.api.post("/credentials", { holderName: "Y", kind: "tceq_maintenance_technician", number: "MT0005678" })).statusCode).toBe(422);
    // One person can hold several: the owner is both the MP and an installer.
    const mp = (await s.api.post("/credentials", { userId: s.owner.id, holderName: "Owner Person", kind: "tceq_maintenance_provider", number: "MP0001234" })).json();
    expect((await s.api.post("/credentials", { userId: s.owner.id, holderName: "Owner Person", kind: "tceq_installer", number: "OS0000777" })).statusCode).toBe(201);
    await s.api.put("/settings/responsible-provider", { credentialId: mp.id });

    // An identifier in place, but the responsible MP license lapsed before today.
    await s.api.put(`/sites/${s.site.id}/authority-identifiers/${LCRA_ID}`, { jurisdictionId: j.id, value: "OSSF-2019-0412", sourceNote: null });
    await s.api.patch(`/credentials/${mp.id}`, { expiresOn: "2026-02-01" });
    const lapsed = (await s.api.post(`/filings/${f!.id}/recheck`, {})).json();
    expect(lapsed).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("MP0001234 expired on 2026-02-01") });

    await s.api.patch(`/credentials/${mp.id}`, { expiresOn: "2027-02-01" });
    expect((await s.api.post(`/filings/${f!.id}/recheck`, {})).json()).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("285.7(b)(3)") });
    // Signing takes an MP license someone has checked against TCEQ's license search.
    const inspectionId = (await detailOf(s, f!.id)).inspection.id;
    expect((await s.api.get(`/inspections/${inspectionId}/signature`)).json()).toMatchObject({ problems: [expect.stringContaining("has not been checked against TCEQ's license search")], signature: null });
    expect((await s.api.post(`/inspections/${inspectionId}/signature`, { typedName: "Owner Person" })).statusCode).toBe(422);
    await s.api.patch(`/credentials/${mp.id}`, { verifiedOn: "2026-02-20", verificationSource: "TCEQ license search" });
    const ready = await signReport(s, f!.id);
    // A draft profile never sends on its own: ready, not queued.
    expect(ready).toMatchObject({ status: "ready" });
    const calls = mail.calls;
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);

    const detail = await detailOf(s, f!.id);
    expect(detail.profile).toMatchObject({ status: "draft", confirmationMode: "none_published" });
    expect(detail.profile.unresolved.length).toBeGreaterThan(0);
    expect(detail.packages).toHaveLength(1);
    const pkg = detail.packages[0];
    expect(pkg).toMatchObject({ submissionNo: 1, method: "email", recipient: "ossf@lcra.org", subject: expect.stringContaining("OSSF-2019-0412"), manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(pkg.documents.map((d: { role: string }) => d.role)).toEqual(["cover_sheet", "inspection_report"]);
    // The maintenance provider's signed copy goes out, not the unsigned report.
    expect(pkg.documents[1].filename).toBe("inspection-report-v1-signed.pdf");
    const field = (label: string) => pkg.fields.find((x: { label: string }) => x.label === label)?.value;
    expect(field("TCEQ MP #")).toBe("MP0001234");
    expect(field("Maintenance Provider Name")).toBe("Owner Person");
    expect(field("LCRA OSSF Application Number")).toBe("OSSF-2019-0412");
    expect(field("Inspection Report Date")).toBe("2026-03-01");
    expect(field("Property Address")).toContain("1 Main St");
    expect(field("Contract Term Start")).toBe("2025-12-01");
    // Each stored file is downloadable and matches the hash in the package.
    for (const d of pkg.documents) {
      const file = await client(ctx.app).get(d.url);
      expect(file.statusCode).toBe(200);
      expect(file.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
      expect(createHash("sha256").update(file.rawPayload).digest("hex")).toBe(d.sha256);
    }
    await expect(sql`update submission_packages set recipient = 'someone@else.example'`.execute(ctx.db)).rejects.toThrow(/immutable/);
  });

  it("checks the technician's registration on the inspection date", async () => {
    const { s, filingId } = await readyLcraFiling(ctx);
    await s.api.post(`/filings/${filingId}/submit`, {});
    await runWorker(ctx);
    expect((await s.api.post(`/filings/${filingId}/reject`, { reason: "Wrong application number" })).statusCode).toBe(200);
    // The registration lapses before the resubmission: held again, naming the technician.
    const mt = ((await s.api.get("/credentials")).json().items as { id: string; kind: string }[]).find((c) => c.kind === "tceq_maintenance_technician")!;
    await s.api.patch(`/credentials/${mt.id}`, { active: false });
    const again = (await s.api.post(`/filings/${filingId}/resubmit`, {})).json();
    expect(again).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("technician user has no active TCEQ maintenance provider license or maintenance technician registration on record for 2026-03-01") });
  });
});

describe("deadlines", () => {
  it("counts an inspection report from the inspection and a renewed contract from the previous term's end", async () => {
    const { s, filingId } = await readyLcraFiling(ctx);
    expect(await detailOf(s, filingId)).toMatchObject({ deadlineOn: "2026-03-15", deadlineBasis: expect.stringContaining("14 days") });

    const rules = { contracts: { filingRequired: true, renewalDaysBeforePreviousEnd: 30, note: "" } } as unknown as RulesetRules;
    const on = (basis: ContractFilingBasis | null, basisOn: string | null = null) => contractDeadline(rules, { basis, basisOn, derived: false });
    // 30 TAC 285.7 gives each kind of contract its own deadline.
    expect(on("renewal", "2026-11-30")).toMatchObject({ deadlineOn: "2026-10-31", basis: expect.stringContaining("285.7(d)(2)") });
    expect(on("after_initial_policy", "2026-11-30")).toMatchObject({ deadlineOn: "2026-10-31", basis: expect.stringContaining("initial two-year service policy expires") });
    expect(on("replacement", "2026-11-30")).toMatchObject({ deadlineOn: "2026-12-30", basis: expect.stringContaining("285.7(d)(3)(C)") });
    expect(on("initial_policy")).toMatchObject({ deadlineOn: null, basis: expect.stringContaining("before the system is approved for use (30 TAC 285.7(c))") });
    // Unknown kind: no date is invented.
    expect(on(null)).toMatchObject({ deadlineOn: null, basis: expect.stringContaining("record whether this is the initial two-year service policy") });
    expect(contractDeadline({ contracts: { filingRequired: true, note: "" } } as unknown as RulesetRules, { basis: "renewal", basisOn: "2026-11-30", derived: false })).toMatchObject({ deadlineOn: null });

    const renewed = await s.api.post(`/contracts/${s.contract.id}/renew`, {});
    expect(renewed.statusCode).toBe(201);
    const contractFiling = (await filings(s, "contract")).find((f) => (f.contract as { id: string }).id === renewed.json().id)!;
    expect(contractFiling).toMatchObject({ kind: "contract", deadlineOn: "2026-10-31", deadlineBasis: expect.stringContaining("2026-11-30") });
  });
});

describe("contract filings", () => {
  it("files a contract separately from inspection reports, once its signed copy is in Aerowise", async () => {
    mail.mode = "ok";
    const { s, filingId } = await readyLcraFiling(ctx);
    // The contract made before the site had an authority is picked up by the sweep.
    expect(await runContractFilings(complianceContext(tasks(ctx)), s.org.id)).toMatchObject({ opened: 1 });
    const [cf] = await filings(s, "contract");
    expect(cf).toMatchObject({ kind: "contract", status: "needs_review", reviewReason: expect.stringContaining("signed"), inspection: null });
    expect((await filings(s, "inspection_report")).map((f) => f.id)).toEqual([filingId]);

    // The status page keeps signed, customer copy and authority apart.
    expect((await s.api.get(`/contracts/${s.contract.id}/filing-status`)).json()).toMatchObject({ signedAt: null, uploadedDocuments: [], customerCopy: [], authority: { status: "needs_review", sentAt: null, confirmedAt: null } });

    expect((await s.api.post(`/contracts/${s.contract.id}/document`, { filename: "contract.png", contentBase64: Buffer.from("not a pdf").toString("base64") })).statusCode).toBe(422);
    const up = await s.api.post(`/contracts/${s.contract.id}/document`, { filename: "Signed contract.pdf", contentBase64: PDF.toString("base64"), signedOn: "2025-11-20" });
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ filingId: cf!.id });
    const detail = await detailOf(s, cf!.id);
    expect(detail.status).toBe("ready");
    expect(detail.packages[0].subject).toContain("maintenance contract");
    expect(detail.packages[0].documents.map((d: { role: string }) => d.role)).toEqual(["cover_sheet", "contract"]);
    expect(detail.packages[0].fields.find((x: { label: string }) => x.label === "Contract Term End").value).toBe("2026-11-30");
    const status = (await s.api.get(`/contracts/${s.contract.id}/filing-status`)).json();
    expect(status.uploadedDocuments).toHaveLength(1);
    expect(status.authority.status).toBe("ready");
    expect((await client(ctx.app).get(status.uploadedDocuments[0].url)).rawPayload.equals(PDF)).toBe(true);

    // Sent is not acknowledged; acknowledgment is recorded by hand with what showed it.
    await s.api.post(`/filings/${cf!.id}/submit`, {});
    await runWorker(ctx);
    expect((await s.api.get(`/contracts/${s.contract.id}/filing-status`)).json().authority).toMatchObject({ status: "sent", confirmedAt: null });
    const ack = await s.api.post(`/filings/${cf!.id}/confirm`, { reference: "LCRA reply 2026-03-04", evidence: { kind: "authority_email_reply", receivedOn: "2026-03-04", from: "ossf@lcra.org" } });
    expect(ack.json()).toMatchObject({ status: "confirmed" });
    expect((await detailOf(s, cf!.id)).confirmationEvidence).toEqual({ kind: "authority_email_reply", receivedOn: "2026-03-04", from: "ossf@lcra.org" });
    await expect(sql`update contract_documents set sha256 = 'x'`.execute(ctx.db)).rejects.toThrow(/immutable/);
  });
});

describe("complaints and monitoring notices", () => {
  const log = (s: Setup, receivedAt: string, description: string, kind = "odor") =>
    s.api.post("/service-requests", { siteId: s.site.id, kind, description, receivedAt }).then((r) => r.json() as { id: string });
  const responsesOf = async (reportId: string) =>
    ((await ctx.db.selectFrom("reports").select("snapshot").where("id", "=", reportId).executeTakeFirstOrThrow()).snapshot as {
      responses: { classification: string; description: string; responseAction: string | null; outcome: string | null; carriedOver: boolean }[];
    }).responses;

  it("asks only about requests in this reporting period, before the report goes out", async () => {
    mail.mode = "ok";
    const s = await lcraSetup(ctx);
    // Before the contract started (2025-12-01): history, never asked about.
    await log(s, "2025-06-10T15:00:00Z", "Old call from before this contract");
    // After the inspection: belongs to the next report.
    await log(s, "2026-03-01T17:00:00Z", "Called after the visit");
    const inPeriod = await log(s, "2026-02-13T09:00:00Z", "Asked about an invoice", "question");
    await complete(s);
    await runWorker(ctx);
    const j = await assignLcra(s);
    await credentialsAndIdentifier(s, j);
    const [f] = await filings(s, "inspection_report");
    const held = (await s.api.post(`/filings/${f!.id}/recheck`, {})).json();
    expect(held).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("1 service request at this site since the last report has not been reviewed") });
    // Marking it not reportable releases the filing at once; only the signature is left.
    await s.api.post(`/service-requests/${inPeriod.id}/classify`, { classification: "not_reportable" });
    expect(await detailOf(s, f!.id)).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("285.7(b)(3)") });
    await signReport(s, f!.id);
    const ready = await detailOf(s, f!.id);
    expect(ready.status).toBe("ready");
    expect(await responsesOf(ready.reports[0].id)).toEqual([]);
  });

  it("reports an unanswered or unfinished complaint as outstanding without holding the filing, and escalates it", async () => {
    mail.mode = "ok";
    const s = await lcraSetup(ctx);
    const complaint = await log(s, "2026-02-10T16:00:00Z", "Owner called about a smell by the spray heads");
    const alarm = await log(s, "2026-02-12T09:00:00Z", "Remote monitor: aerator alarm", "alarm");
    const fixed = await log(s, "2026-02-14T09:00:00Z", "Owner reported a tripped breaker", "repair");
    await complete(s);
    await runWorker(ctx);
    const j = await assignLcra(s);
    await credentialsAndIdentifier(s, j);
    // The alarm got a visit but the replacement part is on order; the breaker was fixed.
    expect((await s.api.post(`/service-requests/${alarm.id}/response`, { action: "Visited, aerator motor failing, part ordered", respondedAt: "2026-02-12T17:00:00Z" })).statusCode).toBe(400);
    await s.api.post(`/service-requests/${alarm.id}/response`, { action: "Visited, aerator motor failing, part ordered", respondedAt: "2026-02-12T17:00:00Z", outcome: "outstanding" });
    await s.api.post(`/service-requests/${fixed.id}/response`, { action: "Reset the breaker and checked the wiring", respondedAt: "2026-02-14T15:00:00Z", outcome: "resolved" });
    for (const r of [complaint, fixed]) await s.api.post(`/service-requests/${r.id}/classify`, { classification: "owner_complaint" });
    await s.api.post(`/service-requests/${alarm.id}/classify`, { classification: "monitoring_notice" });
    expect((await s.api.post(`/service-requests/${fixed.id}/response`, { action: "Too early", respondedAt: "2026-02-01T00:00:00Z", outcome: "resolved" })).statusCode).toBe(422);

    // Recording the responses checked the held filing again: nothing waits on a repair, only
    // on the provider signing the version that has the responses.
    const [held] = await filings(s, "inspection_report");
    expect(held).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("(version 2)") });
    const f = await signReport(s, held!.id);
    expect(f.status).toBe("ready");
    const detail = await detailOf(s, f.id);
    // The report drawn before the classifications was replaced by one that has them.
    expect(detail.reports.map((r: { version: number }) => r.version)).toEqual([2, 1]);
    expect(detail.reports[0]).toMatchObject({ supersedesReportId: detail.reports[1].id, correctionReason: expect.stringContaining("complaint") });
    expect(await responsesOf(detail.reports[0].id)).toEqual([
      expect.objectContaining({ classification: "owner_complaint", responseAction: null, outcome: null, carriedOver: false }),
      expect.objectContaining({ classification: "monitoring_notice", responseAction: "Visited, aerator motor failing, part ordered", outcome: "outstanding" }),
      expect.objectContaining({ classification: "owner_complaint", outcome: "resolved" }),
    ]);
    expect(detail.packages[0].documents[1]).toMatchObject({ role: "inspection_report", sourceVersion: 2 });
    // The customer copy is not an authority filing and is unaffected.
    expect(await ctx.db.selectFrom("reports").select("version").where("audience", "=", "customer").execute()).toEqual([{ version: 1 }]);

    // The office is told about the two that are not resolved, not the fixed one.
    const inbox = (await s.api.get("/inbox")).json().items as { kind: string; title: string }[];
    expect(inbox.filter((i) => i.kind === "complaint_unresolved").map((i) => i.title).sort()).toEqual(["Monitoring notice still outstanding", "Owner complaint with no response yet"]);

    // A response recorded after the package was made but before sending: that package is
    // never sent; a new submission carries a report with the response.
    await s.api.post(`/service-requests/${complaint.id}/response`, { action: "Called the owner, visit booked", respondedAt: "2026-02-28T15:00:00Z", outcome: "outstanding" });
    // The signature on version 2 does not carry over to the redrawn version 3.
    expect(await detailOf(s, f.id)).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("(version 3)") });
    await signReport(s, f.id);
    const redone = await detailOf(s, f.id);
    expect(redone).toMatchObject({ status: "ready", submissionNo: 2, attempts: [] });
    expect(redone.packages.map((p: { submissionNo: number }) => p.submissionNo)).toEqual([2, 1]);
    expect(redone.packages[1]).toEqual(detail.packages[0]);
    expect(redone.packages[0].documents[1]).toMatchObject({ sourceVersion: 3 });
    expect((await responsesOf(redone.reports[0].id))[0]).toMatchObject({ responseAction: "Called the owner, visit booked", outcome: "outstanding" });
  });

  it("carries an unresolved complaint onto the next report until it is resolved", async () => {
    mail.mode = "ok";
    const s = await lcraSetup(ctx);
    const alarm = await log(s, "2026-02-12T09:00:00Z", "Remote monitor: aerator alarm", "alarm");
    await s.api.post(`/service-requests/${alarm.id}/classify`, { classification: "monitoring_notice" });
    await s.api.post(`/service-requests/${alarm.id}/response`, { action: "Part ordered", respondedAt: "2026-02-12T17:00:00Z", outcome: "outstanding" });
    const first = await complete(s);

    // A second visit in the next period.
    ctx.now = new Date("2026-06-01T18:00:00Z");
    const job = (await s.api.post("/jobs", { obligationId: s.contract.obligations[1].id, technicianId: s.tech.id, scheduledDate: "2026-06-01" })).json();
    const clientId = "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d02";
    const p = { ...payload(s), clientId, jobId: job.jobId, arrivedAt: "2026-06-01T15:00:00Z" };
    await s.techApi.put("/inspections/sync", p);
    // Photo ids are global, so the second visit's photos get their own.
    for (const [n, key] of [[1, "overview"], [2, "chlorinator"]] as const) {
      const res = await s.techApi.putImage(`/inspections/${clientId}/photos/00000000-0000-4000-8000-00000000001${n}`, JPEG, { "x-photo-key": key, "x-captured-at": "2026-06-01T15:10:00Z" });
      expect(res.statusCode).toBe(201);
    }
    const second = (await s.techApi.put("/inspections/sync", { ...p, status: "completed", completedAt: "2026-06-01T15:40:00Z", values: { ...completeValues(), air_pressure: 4.5 } })).json();
    expect(second.status).toBe("completed");
    await runWorker(ctx);

    const authorityReport = async (inspectionId: string) =>
      (await ctx.db.selectFrom("reports").select("id").where("inspectionId", "=", inspectionId).where("audience", "=", "authority").orderBy("version", "desc").executeTakeFirstOrThrow()).id;
    expect(await responsesOf(await authorityReport(first.id))).toEqual([expect.objectContaining({ outcome: "outstanding", carriedOver: false })]);
    expect(await responsesOf(await authorityReport(second.id))).toEqual([expect.objectContaining({ description: "Remote monitor: aerator alarm", outcome: "outstanding", carriedOver: true })]);

    // Resolved before a later inspection: it drops off reports after that.
    await s.api.post(`/service-requests/${alarm.id}/response`, { action: "Replaced the aerator motor", respondedAt: "2026-06-05T15:00:00Z", outcome: "resolved" });
    const { responsesForInspection } = await import("@aerowise/compliance");
    // For the June inspection it was still open on the day (resolved afterwards).
    expect((await responsesForInspection(ctx.db, s.org.id, second.id)).reported).toEqual([expect.objectContaining({ carriedOver: true, outcome: "resolved" })]);
    expect((await s.api.get("/inbox")).json().items.filter((i: { kind: string }) => i.kind === "complaint_unresolved")).toEqual([]);
  });
});

describe("draft authority profiles", () => {
  it("are never sent by the background: not on ready, not by sweeps, not by a stray queued task", async () => {
    mail.mode = "ok";
    mail.delivered.clear();
    const { s, filingId } = await readyLcraFiling(ctx);
    const calls = mail.calls;
    // The worker, the contract sweep and a recheck of every waiting filing send nothing.
    await runWorker(ctx);
    await runContractFilings(complianceContext(tasks(ctx)), s.org.id);
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
    expect((await detailOf(s, filingId)).status).toBe("ready");

    // Even a send task queued without a person asking (a bug, or a hand-edited row) is refused.
    await sql`update filings set status = 'queued' where id = ${filingId}`.execute(ctx.db);
    expect(await submitFiling(complianceContext(tasks(ctx)), s.org.id, filingId)).toBeNull();
    expect(mail.calls).toBe(calls);
    const held = await detailOf(s, filingId);
    expect(held).toMatchObject({ status: "ready", attempts: [] });
    expect(await ctx.db.selectFrom("complianceEvents").select("eventType").where("filingId", "=", filingId).where("eventType", "=", "filing_held").execute()).toHaveLength(1);
  });

  it("are sent when a person presses Send, and the queue may retry that same request", async () => {
    mail.mode = "fail";
    mail.delivered.clear();
    const { s, filingId } = await readyLcraFiling(ctx);
    expect((await s.api.post(`/filings/${filingId}/submit`, {})).statusCode).toBe(200);
    await runWorker(ctx);
    expect((await detailOf(s, filingId)).status).toBe("failed");
    // The queue's automatic retry of the office's request goes out with the same package.
    mail.mode = "ok";
    later(ctx, 60_000);
    await runWorker(ctx);
    const sent = await detailOf(s, filingId);
    expect(sent.status).toBe("sent");
    expect(mail.delivered.size).toBe(1);
    // A rejected one that is corrected goes back to Ready, not out: a new submission needs a new Send.
    await s.api.post(`/filings/${filingId}/reject`, { reason: "Wrong application number" });
    expect((await s.api.post(`/filings/${filingId}/resubmit`, {})).json()).toMatchObject({ status: "ready", submissionNo: 2 });
    await runWorker(ctx);
    expect(mail.delivered.size).toBe(1);
  });

  it("can always be filed by hand, with the package the office downloads", async () => {
    const { s, filingId } = await readyLcraFiling(ctx);
    expect((await s.api.post(`/filings/${filingId}/manual`, {})).json()).toMatchObject({ status: "ready", submissionMethod: "manual_export" });
    const sent = await s.api.post(`/filings/${filingId}/mark-sent`, { reference: null, note: "Emailed from the office mailbox" });
    expect(sent.json()).toMatchObject({ status: "sent", proof: { kind: "manual_submission" } });
    expect((await detailOf(s, filingId)).packages).toHaveLength(1);
  });
});

describe("delivery evidence", () => {
  it("keeps customer delivery apart from authority submission", async () => {
    mail.mode = "ok";
    mail.delivered.clear();
    const { s, filingId } = await readyLcraFiling(ctx);
    const reports = await ctx.db.selectFrom("reports").select(["id", "audience", "inspectionId", "sha256"]).where("organizationId", "=", s.org.id).execute();
    const customer = reports.find((r) => r.audience === "customer")!;
    const authority = reports.find((r) => r.audience === "authority")!;
    expect((await s.api.post(`/reports/${authority.id}/send-to-customer`, { to: "pat@example.com" })).statusCode).toBe(422);
    expect((await s.api.post(`/reports/${customer.id}/send-to-customer`, {})).statusCode).toBe(422);
    expect((await s.api.post(`/reports/${customer.id}/send-to-customer`, { to: "pat@example.com" })).statusCode).toBe(202);
    await runWorker(ctx);

    const deliveries = (await s.api.get(`/inspections/${customer.inspectionId}/deliveries`)).json().items;
    // The customer gets the copy signed with the authority report, never the unsigned one.
    const customerSignature = await ctx.db.selectFrom("reportSignatures").select("sha256").where("reportId", "=", customer.id).executeTakeFirstOrThrow();
    expect(customerSignature.sha256).not.toBe(customer.sha256);
    expect(deliveries).toEqual([expect.objectContaining({ documentKind: "inspection_report", recipient: "pat@example.com", documentSha256: customerSignature.sha256, status: "accepted", delivery: "provider" })]);
    expect([...mail.delivered.values()][0]!.attachments.map((a) => a.filename)).toEqual(["inspection-report-signed.pdf"]);
    // The customer email is not a filing attempt, and the filing is still waiting to be sent.
    expect((await detailOf(s, filingId))).toMatchObject({ status: "ready", attempts: [] });
    expect([...mail.delivered.values()].map((m) => m.to)).toEqual(["pat@example.com"]);

    await s.api.post(`/filings/${filingId}/submit`, {});
    await runWorker(ctx);
    const sent = await detailOf(s, filingId);
    expect(sent.attempts).toEqual([expect.objectContaining({ status: "succeeded", recipient: "ossf@lcra.org", packageId: sent.packages[0].id })]);
    expect(sent.attempts[0].response).toMatchObject({ manifestSha256: sent.packages[0].manifestSha256 });
    const toLcra = [...mail.delivered.values()].find((m) => m.to === "ossf@lcra.org")!;
    expect(toLcra.attachments.map((a) => a.filename)).toEqual(["cover-sheet.pdf", "inspection-report-v1-signed.pdf"]);
    // Customer delivery rows are untouched by the authority send.
    expect(await ctx.db.selectFrom("customerDeliveries").select("id").execute()).toHaveLength(1);
  });

  it("sends a package once however the retries go, with identical bytes", async () => {
    mail.delivered.clear();
    mail.mode = "lose_response_once";
    const { s, filingId } = await readyLcraFiling(ctx);
    await s.api.post(`/filings/${filingId}/submit`, {});
    await s.api.post(`/filings/${filingId}/submit`, {});
    await runWorker(ctx);
    expect((await detailOf(s, filingId)).status).toBe("failed");
    later(ctx, 60_000);
    await runWorker(ctx);
    const sent = await detailOf(s, filingId);
    expect(sent.status).toBe("sent");
    expect(mail.delivered.size).toBe(1);
    expect(sent.packages).toHaveLength(1);
    expect(new Set(sent.attempts.map((a: { packageId: string }) => a.packageId))).toEqual(new Set([sent.packages[0].id]));
  });

  it("records a rejection, then a corrected version linked to the original and a new package, never overwriting", async () => {
    mail.mode = "ok";
    const { s, filingId } = await readyLcraFiling(ctx);
    await s.api.post(`/filings/${filingId}/submit`, {});
    await runWorker(ctx);
    const first = await detailOf(s, filingId);
    expect((await s.api.post(`/filings/${filingId}/correct`, { reason: "too soon" })).statusCode).toBe(409);
    expect((await s.api.post(`/filings/${filingId}/reject`, { reason: "Chlorine residual was recorded in the wrong field" })).json()).toMatchObject({ status: "rejected", rejectionReason: expect.stringContaining("Chlorine") });

    expect((await s.api.post(`/filings/${filingId}/correct`, { reason: "Fix", amendments: { not_a_field: 1 } })).statusCode).toBe(422);
    const corrected = await s.api.post(`/filings/${filingId}/correct`, { reason: "Chlorine residual corrected from the technician's notes", amendments: { chlorine_level: 2 } });
    expect(corrected.statusCode).toBe(200);
    // The corrected version needs the provider's signature before it can go.
    expect(corrected.json()).toMatchObject({ status: "needs_review", submissionNo: 2, reviewReason: expect.stringContaining("(version 2)") });
    await signReport(s, filingId);
    expect(await detailOf(s, filingId)).toMatchObject({ status: "ready", submissionNo: 2 });
    const detail = await detailOf(s, filingId);
    expect(detail.reports.map((r: { version: number }) => r.version)).toEqual([2, 1]);
    expect(detail.reports[0]).toMatchObject({ supersedesReportId: detail.reports[1].id, correctionReason: "Chlorine residual corrected from the technician's notes" });
    expect(detail.packages.map((p: { submissionNo: number }) => p.submissionNo)).toEqual([2, 1]);
    // The first package is exactly as it was sent.
    expect(detail.packages[1]).toEqual(first.packages[0]);
    expect(detail.packages[0].documents[1]).toMatchObject({ sourceVersion: 2 });
    const snap = (await ctx.db.selectFrom("reports").select("snapshot").where("id", "=", detail.reports[0].id).executeTakeFirstOrThrow()).snapshot as { correction: { amendments: unknown } };
    expect(snap.correction.amendments).toEqual([{ key: "chlorine_level", value: 2 }]);
    // The inspection itself is not rewritten.
    const value = await ctx.db.selectFrom("inspectionValues").select("valueJson").where("fieldKey", "=", "chlorine_level").executeTakeFirstOrThrow();
    expect(value.valueJson).toBe(1.5);
    await expect(sql`update reports set sha256 = 'x' where version = 1`.execute(ctx.db)).rejects.toThrow(/immutable/);

    await s.api.post(`/filings/${filingId}/submit`, {});
    await runWorker(ctx);
    const resent = await detailOf(s, filingId);
    expect(resent.status).toBe("sent");
    expect(resent.attempts.map((a: { packageId: string }) => a.packageId)).toEqual([detail.packages[0].id, detail.packages[1].id]);
  });
});

describe("maintenance provider signature (30 TAC 285.7(b)(3))", () => {
  async function unsignedFiling() {
    const s = await lcraSetup(ctx);
    await complete(s);
    await runWorker(ctx);
    const j = await assignLcra(s);
    const creds = await credentialsAndIdentifier(s, j);
    const [f] = await filings(s, "inspection_report");
    await s.api.post(`/filings/${f!.id}/recheck`, {});
    const inspectionId = (await detailOf(s, f!.id)).inspection.id as string;
    return { s, ...creds, filingId: f!.id, sig: `/inspections/${inspectionId}/signature`, inspectionId };
  }

  it("lets only a licensed maintenance provider sign, attesting to the technician's supervision, and sends the signed copy", async () => {
    mail.mode = "ok";
    const { s, mp, mt, filingId, sig, inspectionId } = await unsignedFiling();
    const inbox = (await s.api.get("/inbox")).json().items as { kind: string; target: { id: string } }[];
    expect(inbox.find((i) => i.kind === "report_unsigned")).toMatchObject({ target: { id: filingId } });

    // Office staff and technicians without an MP license cannot sign; read-only users may not try.
    const office = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, s.org.id, "office")).email));
    expect((await office.get(sig)).json()).toMatchObject({ version: 1, signature: null, problems: [expect.stringContaining("Only a TCEQ licensed maintenance provider (MP) can sign")] });
    expect((await office.post(sig, { typedName: "office user" })).statusCode).toBe(422);
    expect((await s.techApi.post(sig, { typedName: "Tech Person" })).statusCode).toBe(422);
    const readOnly = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, s.org.id, "read_only")).email));
    expect((await readOnly.post(sig, { typedName: "x y" })).statusCode).toBe(403);

    // Someone else inspected: they must have been registered that day.
    await s.api.patch(`/credentials/${mt.id}`, { expiresOn: "2026-02-01" });
    expect((await s.api.get(sig)).json().problems).toEqual([expect.stringContaining("had no active TCEQ maintenance technician registration or MP license on record for 2026-03-01")]);
    await s.api.patch(`/credentials/${mt.id}`, { expiresOn: "2027-01-31" });

    const preview = (await s.api.get(sig)).json();
    expect(preview).toMatchObject({ problems: [], holderName: "Owner Person", signature: null, required: true });
    expect(preview.statement).toContain("I, Owner Person, TCEQ licensed maintenance provider MP0001234, have reviewed this maintenance report (version 1)");
    expect(preview.statement).toContain("by technician user (TCEQ registered maintenance technician MT0005678), who is employed by Org A and works under my direct supervision");
    expect((await s.api.post(sig, { typedName: "Someone Else" })).json()).toMatchObject({ message: expect.stringContaining("Type your name as it appears on your MP license: Owner Person") });

    const signed = await s.api.post(sig, { typedName: "  owner   person " });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().signature).toMatchObject({ signedByName: "owner user", typedName: "owner   person", licenseNumber: "MP0001234", statement: preview.statement });
    expect((await s.api.post(sig, { typedName: "Owner Person" })).json()).toMatchObject({ message: expect.stringContaining("already signed") });

    // The signed copy is stored beside the unsigned report, which is unchanged.
    const report = await ctx.db.selectFrom("reports").select(["id", "sha256", "storageKey"]).where("audience", "=", "authority").executeTakeFirstOrThrow();
    const row = await ctx.db.selectFrom("reportSignatures").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ reportId: report.id, reportSha256: report.sha256, credentialId: mp.id, signedBy: s.owner.id });
    const signedPdf = (await ctx.store.get(row.storageKey))!;
    expect(createHash("sha256").update(signedPdf).digest("hex")).toBe(row.sha256);
    expect(row.sha256).not.toBe(report.sha256);
    expect(createHash("sha256").update((await ctx.store.get(report.storageKey))!).digest("hex")).toBe(report.sha256);
    await expect(sql`update report_signatures set typed_name = 'x'`.execute(ctx.db)).rejects.toThrow(/immutable/);
    const event = await ctx.db.selectFrom("complianceEvents").select("summary").where("eventType", "=", "report_signed").where("inspectionId", "=", inspectionId).executeTakeFirstOrThrow();
    expect(event.summary).toBe("Authority report version 1 signed by Owner Person, MP MP0001234, with customer copy version 1");
    // The owner is the organization's responsible MP, so no delegation was needed.
    expect(preview).toMatchObject({ provider: { name: "Owner Person", number: "MP0001234", source: "organization" }, delegationRequired: false });
    // The customer copy was signed with it.
    const customerReport = await ctx.db.selectFrom("reports").select(["id", "sha256"]).where("audience", "=", "customer").executeTakeFirstOrThrow();
    const customerSig = await ctx.db.selectFrom("reportSignatures").selectAll().where("reportId", "=", customerReport.id).executeTakeFirstOrThrow();
    expect(customerSig).toMatchObject({ reportSha256: customerReport.sha256, credentialId: mp.id, delegationNote: null });
    expect(customerSig.statement).toContain("have reviewed this maintenance report (version 1)");
    expect((await s.api.get(sig)).json().customerCopy).toEqual({ reportId: customerReport.id, version: 1, signed: true });

    // The filing is ready with the signed copy, and the inbox no longer asks.
    const detail = await detailOf(s, filingId);
    expect(detail.status).toBe("ready");
    expect(detail.packages[0].documents[1]).toMatchObject({ filename: "inspection-report-v1-signed.pdf", sha256: row.sha256, sourceId: report.id });
    expect(((await s.api.get("/inbox")).json().items as { kind: string }[]).some((i) => i.kind === "report_unsigned")).toBe(false);
  });

  it("lets another licensed MP sign only with a documented delegation from the MP named for the site", async () => {
    const { s, sig } = await unsignedFiling();
    await s.api.post("/credentials", { userId: s.tech.id, holderName: "Tech Person", kind: "tceq_maintenance_provider", number: "MP0009999", verifiedOn: "2026-02-20", verificationSource: "TCEQ license search" });
    // Technicians cannot open filings, but signing is open to them.
    expect((await s.techApi.get(sig)).statusCode).toBe(403);
    // The owner is the MP named for this site (the organization's responsible MP), so the
    // technician signs for them only with a documented delegation and supervision.
    const refused = await s.techApi.post(sig, { typedName: "Tech Person" });
    expect(refused.json()).toMatchObject({ message: expect.stringContaining("You are not the organization's responsible maintenance provider (Owner Person, MP MP0001234). To sign for them, describe the documented delegation") });
    expect((await s.techApi.post(sig, { typedName: "Tech Person", delegationNote: "ok" })).statusCode).toBe(422);
    const note = "Written delegation from Owner Person dated 2026-01-05; Owner reviews each report weekly";
    const res = await s.techApi.post(sig, { typedName: "Tech Person", delegationNote: note });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ delegationRequired: true, signature: { delegationNote: note } });
    expect(res.json().signature.statement).toMatch(
      /^I, Tech Person, TCEQ licensed maintenance provider MP0009999, .* I performed the inspection on 2026-03-01\. I sign for Owner Person \(MP MP0001234\), the organization's responsible maintenance provider, under this documented delegation and supervision: Written delegation/,
    );
    const row = await ctx.db.selectFrom("reportSignatures as rs").innerJoin("reports as r", "r.id", "rs.reportId").select(["r.audience", "rs.onBehalfOfCredentialId", "rs.delegationNote"]).orderBy("r.audience").execute();
    const owner = await ctx.db.selectFrom("providerCredentials").select("id").where("number", "=", "MP0001234").executeTakeFirstOrThrow();
    expect(row).toEqual([
      { audience: "authority", onBehalfOfCredentialId: owner.id, delegationNote: note },
      { audience: "customer", onBehalfOfCredentialId: owner.id, delegationNote: note },
    ]);
    const event = await ctx.db.selectFrom("complianceEvents").select("summary").where("eventType", "=", "report_signed").executeTakeFirstOrThrow();
    expect(event.summary).toContain("for Owner Person (MP MP0001234) under a documented delegation");
  });

  it("defaults the signer to the MP named on the site's contract", async () => {
    const { s, sig } = await unsignedFiling();
    const techMp = (await s.api.post("/credentials", { userId: s.tech.id, holderName: "Tech Person", kind: "tceq_maintenance_provider", number: "MP0009999", verifiedOn: "2026-02-20", verificationSource: "TCEQ license search" })).json();
    const mt = (await s.api.get("/credentials")).json().items.find((c: { kind: string }) => c.kind === "tceq_maintenance_technician");
    expect((await s.api.put(`/contracts/${s.contract.id}/provider`, { credentialId: mt.id })).statusCode).toBe(422);
    expect((await s.techApi.put(`/contracts/${s.contract.id}/provider`, { credentialId: techMp.id })).statusCode).toBe(403);
    const named = await s.api.put(`/contracts/${s.contract.id}/provider`, { credentialId: techMp.id });
    expect(named.json()).toEqual({ provider: { credentialId: techMp.id, name: "Tech Person", number: "MP0009999", source: "contract" } });
    expect((await s.api.get(`/contracts/${s.contract.id}/filing-status`)).json().provider).toMatchObject({ name: "Tech Person", source: "contract" });
    // Now the owner is the one who would need a delegation; the technician signs as named.
    expect((await s.api.get(sig)).json()).toMatchObject({ provider: { name: "Tech Person", number: "MP0009999", source: "contract" }, delegationRequired: true });
    const res = await s.techApi.post(sig, { typedName: "Tech Person" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().signature).toMatchObject({ delegationNote: null });
    expect(res.json().signature.statement).not.toContain("I sign for");
  });
});

describe("unsigned packages left from before signatures were required", () => {
  /**
   * What PR #17 could leave behind: a ready inspection filing whose package was made from
   * the unsigned authority report, because signing did not exist yet.
   */
  async function readyUnsignedFiling() {
    const s = await lcraSetup(ctx);
    await complete(s);
    await runWorker(ctx);
    const j = await assignLcra(s);
    await credentialsAndIdentifier(s, j);
    const [listed] = await filings(s, "inspection_report");
    await s.api.post(`/filings/${listed!.id}/recheck`, {});
    const f = (await loadFiling(ctx.db, s.org.id, listed!.id))!;
    const r = await ctx.db.selectFrom("jurisdictionRulesets as r").innerJoin("jurisdictions as j", "j.id", "r.jurisdictionId").select(["r.id", "r.rules", "j.id as jurisdictionId", "j.key", "j.authorityName"]).where("r.id", "=", f.rulesetId!).executeTakeFirstOrThrow();
    const resolved: ResolvedJurisdiction = { jurisdictionId: r.jurisdictionId, key: r.key, authorityName: r.authorityName, rulesetId: r.id, rules: r.rules as RulesetRules, source: "county" };
    await ensurePackage({ db: ctx.db, store: ctx.store, now: () => ctx.now }, f, resolved);
    await ctx.db.updateTable("filings").set({ status: "ready", reviewReason: null }).where("id", "=", f.id).execute();
    const before = await detailOf(s, f.id);
    expect(before).toMatchObject({ status: "ready", submissionNo: 1 });
    expect(before.packages.map((p: { documents: { filename: string }[] }) => p.documents.map((d) => d.filename))).toEqual([["cover-sheet.pdf", "inspection-report-v1.pdf"]]);
    return { s, filingId: f.id };
  }

  const toLcra = () => [...mail.delivered.values()].filter((m) => m.to === "ossf@lcra.org");

  it("checks again before sending: an unsigned package is held and replaced, never sent", async () => {
    mail.mode = "ok";
    mail.delivered.clear();
    const { s, filingId } = await readyUnsignedFiling();
    expect((await s.api.post(`/filings/${filingId}/submit`, {})).statusCode).toBe(200);
    await runWorker(ctx);
    expect(toLcra()).toEqual([]);
    const held = await detailOf(s, filingId);
    expect(held).toMatchObject({ status: "needs_review", submissionNo: 2, reviewReason: expect.stringContaining("sign the authority report (version 1)"), attempts: [] });
    // Submission 1's package stays on record, never sent.
    expect(held.packages.map((p: { submissionNo: number }) => p.submissionNo)).toEqual([1]);
    const events = await ctx.db.selectFrom("complianceEvents").select("summary").where("filingId", "=", filingId).where("eventType", "=", "filing_reprepared").execute();
    expect(events).toEqual([{ summary: "Not sent: submission 1 would have sent an authority report the maintenance provider has not signed (30 TAC 285.7(b)(3)); it is replaced by submission 2" }]);

    // Signed: submission 2 gets its own package with the signed copy, and that one goes.
    expect(await signReport(s, filingId)).toMatchObject({ status: "ready" });
    await s.api.post(`/filings/${filingId}/submit`, {});
    await runWorker(ctx);
    const sent = await detailOf(s, filingId);
    expect(sent).toMatchObject({ status: "sent", submissionNo: 2 });
    expect(sent.packages.map((p: { submissionNo: number; documents: { filename: string }[] }) => [p.submissionNo, p.documents[1]!.filename]).sort()).toEqual([
      [1, "inspection-report-v1.pdf"],
      [2, "inspection-report-v1-signed.pdf"],
    ]);
    expect(toLcra().map((m) => m.attachments.map((a) => a.filename))).toEqual([["cover-sheet.pdf", "inspection-report-v1-signed.pdf"]]);
  });

  it("replaces unsigned packages in the filing sweep, once", async () => {
    mail.mode = "ok";
    mail.delivered.clear();
    const { s, filingId } = await readyUnsignedFiling();
    const swept = await runContractFilings(complianceContext(tasks(ctx)), s.org.id);
    expect(swept).toMatchObject({ replaced: 1 });
    expect(await detailOf(s, filingId)).toMatchObject({ status: "needs_review", submissionNo: 2 });
    // Running it again changes nothing.
    expect(await runContractFilings(complianceContext(tasks(ctx)), s.org.id)).toMatchObject({ replaced: 0 });

    expect(toLcra()).toEqual([]);
  });

  it("replaces the unsigned package of a ready filing when the report is signed", async () => {
    const { s, filingId } = await readyUnsignedFiling();
    expect(await signReport(s, filingId)).toMatchObject({ status: "ready" });
    const after = await detailOf(s, filingId);
    expect(after.submissionNo).toBe(2);
    expect(after.packages.map((p: { submissionNo: number; documents: { filename: string }[] }) => [p.submissionNo, p.documents[1]!.filename]).sort()).toEqual([
      [1, "inspection-report-v1.pdf"],
      [2, "inspection-report-v1-signed.pdf"],
    ]);
  });

  it("holds the customer's copy until the maintenance provider signs it", async () => {
    mail.mode = "ok";
    mail.delivered.clear();
    const { s, filingId } = await readyUnsignedFiling();
    const customer = await ctx.db.selectFrom("reports").select("id").where("organizationId", "=", s.org.id).where("audience", "=", "customer").executeTakeFirstOrThrow();
    const send = `/reports/${customer.id}/send-to-customer`;
    expect((await s.api.post(send, { to: "pat@example.com" })).json()).toMatchObject({ message: expect.stringContaining("has not signed this report yet (30 TAC 285.7(b)(3))") });
    await signReport(s, filingId);
    expect((await s.api.post(send, { to: "pat@example.com" })).statusCode).toBe(202);
    await runWorker(ctx);
    expect([...mail.delivered.values()].filter((m) => m.to === "pat@example.com").map((m) => m.attachments[0]!.filename)).toEqual(["inspection-report-signed.pdf"]);
  });

  it("will not let an unsigned package be marked as filed by hand", async () => {
    const { s, filingId } = await readyUnsignedFiling();
    expect((await s.api.post(`/filings/${filingId}/manual`, {})).statusCode).toBe(200);
    const res = await s.api.post(`/filings/${filingId}/mark-sent`, { reference: null, note: "Uploaded to the portal" });
    expect(res.json()).toMatchObject({ message: expect.stringContaining("has not signed (30 TAC 285.7(b)(3))") });
    expect((await detailOf(s, filingId)).status).toBe("ready");
  });
});

describe("contract deadlines by kind (30 TAC 285.7(c), (d))", () => {
  it("asks which kind of contract it is, then sets that kind's deadline until the filing goes out", async () => {
    mail.mode = "ok";
    const { s } = await readyLcraFiling(ctx);
    await runContractFilings(complianceContext(tasks(ctx)), s.org.id);
    const [cf] = await filings(s, "contract");
    const basisUrl = `/contracts/${s.contract.id}/filing-basis`;
    // A first contract in Aerowise: whether it follows an initial policy, renews another
    // provider's contract or replaces a terminated one is not guessed.
    expect(await detailOf(s, cf!.id)).toMatchObject({ deadlineOn: null, deadlineBasis: expect.stringContaining("record whether this is the initial two-year service policy") });
    expect((await s.api.get(`/contracts/${s.contract.id}/filing-status`)).json().basis).toEqual({ basis: null, basisOn: null, note: null, derived: false });

    expect((await s.api.put(basisUrl, { basis: "renewal" })).statusCode).toBe(400);
    const set = await s.api.put(basisUrl, { basis: "replacement", basisOn: "2025-11-20", note: "Previous provider ended service; the owner's letter is on file" });
    expect(set.json()).toEqual({ basis: "replacement", basisOn: "2025-11-20", note: "Previous provider ended service; the owner's letter is on file", derived: false });
    expect(await detailOf(s, cf!.id)).toMatchObject({ deadlineOn: "2025-12-20", deadlineBasis: expect.stringContaining("30 TAC 285.7(d)(3)(C)") });
    const changed = await ctx.db.selectFrom("complianceEvents").select("summary").where("filingId", "=", cf!.id).where("eventType", "=", "filing_deadline_changed").execute();
    expect(changed).toEqual([{ summary: expect.stringContaining("Contract filing due 2025-12-20") }]);

    await s.api.put(basisUrl, { basis: "after_initial_policy", basisOn: "2026-01-15" });
    expect(await detailOf(s, cf!.id)).toMatchObject({ deadlineOn: "2025-12-16", deadlineBasis: expect.stringContaining("initial two-year service policy expires on 2026-01-15") });
    await s.api.put(basisUrl, { basis: "initial_policy", basisOn: "2026-01-15" });
    expect(await detailOf(s, cf!.id)).toMatchObject({ deadlineOn: null, deadlineBasis: expect.stringContaining("before the system is approved for use (30 TAC 285.7(c))") });
    expect((await s.api.get(`/contracts/${s.contract.id}/filing-status`)).json()).toMatchObject({ basis: { basis: "initial_policy", basisOn: null }, authority: { deadlineBasis: expect.stringContaining("285.7(c)") } });

    // Once sent, the filing keeps the deadline it was sent against.
    await s.api.put(basisUrl, { basis: "renewal", basisOn: "2025-12-31" });
    await s.api.post(`/contracts/${s.contract.id}/document`, { filename: "Signed contract.pdf", contentBase64: PDF.toString("base64"), signedOn: "2025-11-20" });
    await s.api.post(`/filings/${cf!.id}/submit`, {});
    await runWorker(ctx);
    expect(await detailOf(s, cf!.id)).toMatchObject({ status: "sent", deadlineOn: "2025-12-01" });
    await s.api.put(basisUrl, { basis: "replacement", basisOn: "2025-11-20" });
    expect(await detailOf(s, cf!.id)).toMatchObject({ deadlineOn: "2025-12-01" });

    // Office staff record it; technicians cannot.
    expect((await s.techApi.put(basisUrl, { basis: "initial_policy" })).statusCode).toBe(403);
  });

  it("records who ended a contract and reminds the office of the written notice owed before service stops", async () => {
    const s = await lcraSetup(ctx);
    const notice = `/contracts/${s.contract.id}/discontinuation-notice`;
    expect((await s.api.post(notice, { sentOn: "2026-03-01", note: "Too early" })).json()).toMatchObject({ message: "Only a contract that is ending or cancelled has a discontinuation notice" });
    const cancel = await s.api.post(`/contracts/${s.contract.id}/cancel`, { reason: "Provider is leaving the area", discontinuedBy: "provider", serviceEndsOn: "2026-03-20" });
    expect(cancel.statusCode).toBe(200);
    // Service continues through the last day: the contract stays active with the visits
    // that can start by then. Only the ones that cannot are cancelled now.
    const ending = cancel.json();
    expect(ending).toMatchObject({ status: "active", state: "active", serviceEndsOn: "2026-03-20", discontinuedBy: "provider", cancelledAt: null });
    const kept = ending.obligations.filter((o: { windowStart: string }) => o.windowStart <= "2026-03-20");
    const dropped = ending.obligations.filter((o: { windowStart: string }) => o.windowStart > "2026-03-20");
    expect(kept.length).toBeGreaterThan(0);
    expect(dropped.length).toBeGreaterThan(0);
    expect(kept.map((o: { status: string }) => o.status)).toEqual(kept.map(() => "open"));
    expect(dropped.map((o: { status: string }) => o.status)).toEqual(dropped.map(() => "cancelled"));
    // The visit owed before the last day is still on the schedule.
    const job = await ctx.db.selectFrom("jobs").select("status").where("obligationId", "=", kept[0].id).executeTakeFirstOrThrow();
    expect(job.status).toBe("scheduled");
    expect((await s.api.get(`/obligations/due?through=2026-03-31`)).json().items.map((o: { id: string }) => o.id)).toContain(kept[0].id);
    // An ending contract is not renewed, and is not ended twice.
    expect((await s.api.post(`/contracts/${s.contract.id}/renew`, {})).json()).toMatchObject({ message: "This contract is ending: service stops after 2026-03-20" });
    expect((await s.api.post(`/contracts/${s.contract.id}/cancel`, { reason: "Again" })).statusCode).toBe(409);

    const status = (await s.api.get(`/contracts/${s.contract.id}/filing-status`)).json();
    // The provider ended it, so the owner is written to as well, 30 days ahead: already late here.
    expect(status.discontinuation).toEqual({
      discontinuedBy: "provider",
      serviceEndsOn: "2026-03-20",
      noticeDueOn: "2026-02-18",
      recipients: ["the permitting authority", "the system's manufacturer", "the owner"],
      noticeSentOn: null,
      noticeNote: null,
    });
    const item = ((await s.api.get("/inbox")).json().items as { kind: string; severity: string; title: string; detail: string; dueOn: string }[]).find((i) => i.kind === "discontinuation_notice_due");
    expect(item).toMatchObject({ severity: "high", title: "Notice that service is ending is late", dueOn: "2026-02-18", detail: expect.stringContaining("and the owner by 2026-02-18 (30 TAC 285.7(d)(3))") });
    // An ending contract is not offered for renewal in the inbox either.
    expect(((await s.api.get("/inbox")).json().items as { kind: string }[]).some((i) => i.kind === "contract_expiring")).toBe(false);

    const recorded = await s.api.post(notice, { sentOn: "2026-03-01", note: "Emailed the county and the owner, letter to the manufacturer" });
    expect(recorded.json()).toMatchObject({ noticeSentOn: "2026-03-01", noticeNote: "Emailed the county and the owner, letter to the manufacturer" });
    expect((await s.api.post(notice, { sentOn: "2026-03-02", note: "Again" })).json()).toMatchObject({ message: "The notice is already recorded" });
    expect(((await s.api.get("/inbox")).json().items as { kind: string }[]).some((i) => i.kind === "discontinuation_notice_due")).toBe(false);

    // The next contract can start the day after service ends, even before the old one is closed.
    const next = await s.api.post(`/sites/${s.site.id}/contracts`, { planId: s.contract.planId, startOn: "2026-03-21" });
    expect(next.statusCode, next.body).toBe(201);
    expect((await s.api.post(`/sites/${s.site.id}/contracts`, { planId: s.contract.planId, startOn: "2026-03-20" })).statusCode).toBe(409);

    // The day after the last day of service, the sweep ends it and drops what is still open.
    ctx.now = new Date("2026-03-21T18:00:00Z");
    expect(await runContractFilings(complianceContext(tasks(ctx)), s.org.id)).toMatchObject({ ended: 1 });
    const ended = (await s.api.get(`/contracts/${s.contract.id}`)).json();
    expect(ended).toMatchObject({ status: "cancelled", state: "cancelled", serviceEndsOn: "2026-03-20" });
    expect(ended.obligations.filter((o: { status: string }) => o.status === "open")).toEqual([]);
    expect(await runContractFilings(complianceContext(tasks(ctx)), s.org.id)).toMatchObject({ ended: 0 });

    // The owner ended the next one: the provider writes to the authority and the manufacturer.
    await s.api.post(`/contracts/${next.json().id}/cancel`, { reason: "Owner switched providers", discontinuedBy: "owner", serviceEndsOn: "2026-06-30" });
    expect((await s.api.get(`/contracts/${next.json().id}/filing-status`)).json().discontinuation).toMatchObject({ recipients: ["the permitting authority", "the system's manufacturer"], noticeDueOn: "2026-05-31" });
    const later = ((await s.api.get("/inbox")).json().items as { kind: string; severity: string; title: string }[]).find((i) => i.kind === "discontinuation_notice_due");
    expect(later).toMatchObject({ severity: "medium", title: "Send notice that service is ending" });
  });

  it("cancels at once when the last day of service has already passed", async () => {
    const s = await lcraSetup(ctx);
    const res = await s.api.post(`/contracts/${s.contract.id}/cancel`, { reason: "Owner sold the house", discontinuedBy: "owner", serviceEndsOn: "2026-02-15" });
    expect(res.json()).toMatchObject({ status: "cancelled", serviceEndsOn: "2026-02-15" });
    expect(res.json().obligations.filter((o: { status: string }) => o.status === "open")).toEqual([]);
  });
});

describe("ending service and the technician's route", () => {
  const route = async (s: Setup, date: string) => ((await s.techApi.get(`/route?date=${date}`)).json().items as { jobId: string }[]).map((i) => i.jobId);

  it("takes cancelled visits off the route, flags kept ones booked too late, and refuses days after service ends", async () => {
    const s = await lcraSetup(ctx);
    const [first, second] = s.contract.obligations as { id: string; windowStart: string }[];
    expect(first!.windowStart <= "2026-03-20" && second!.windowStart > "2026-03-20").toBe(true);
    // The first visit is booked for after the coming last day; the second has its own job.
    expect((await s.api.patch(`/jobs/${s.job.jobId}`, { scheduledDate: "2026-03-25" })).statusCode).toBe(200);
    const later = (await s.api.post("/jobs", { obligationId: second!.id, technicianId: s.tech.id, scheduledDate: "2026-04-10" })).json();
    expect(await route(s, "2026-03-25")).toEqual([s.job.jobId]);
    expect(await route(s, "2026-04-10")).toEqual([later.jobId]);

    await s.api.post(`/contracts/${s.contract.id}/cancel`, { reason: "Owner switched providers", discontinuedBy: "owner", serviceEndsOn: "2026-03-20" });
    // The visit that cannot start by the last day is cancelled with its job: off the route.
    expect(await route(s, "2026-04-10")).toEqual([]);
    expect(await ctx.db.selectFrom("jobs").select(["status", "cancelReason"]).where("id", "=", later.jobId).executeTakeFirstOrThrow()).toEqual({ status: "cancelled", cancelReason: "Service ends after 2026-03-20" });
    // The kept visit stays, but its job is after the last day: the office is told to move it.
    expect(await route(s, "2026-03-25")).toEqual([s.job.jobId]);
    const flagged = ((await s.api.get("/inbox")).json().items as { kind: string; target: { id: string }; detail: string }[]).find((i) => i.kind === "visit_after_service_end");
    expect(flagged).toMatchObject({ target: { id: first!.id }, detail: expect.stringContaining("move it to 2026-03-20 or earlier") });

    // Nothing can be booked or moved past the last day.
    expect((await s.api.patch(`/jobs/${s.job.jobId}`, { scheduledDate: "2026-03-21" })).json()).toMatchObject({ message: expect.stringContaining("ends after 2026-03-20") });
    expect((await s.api.patch(`/jobs/${s.job.jobId}`, { scheduledDate: "2026-03-18" })).statusCode).toBe(200);
    expect(await route(s, "2026-03-18")).toEqual([s.job.jobId]);
    expect(((await s.api.get("/inbox")).json().items as { kind: string }[]).some((i) => i.kind === "visit_after_service_end")).toBe(false);
    await s.api.post(`/jobs/${s.job.jobId}/cancel`, { reason: "Owner asked to rebook" });
    expect((await s.api.post("/jobs", { obligationId: first!.id, technicianId: s.tech.id, scheduledDate: "2026-03-22" })).statusCode).toBe(422);
    const rebooked = (await s.api.post("/jobs", { obligationId: first!.id, technicianId: s.tech.id, scheduledDate: "2026-03-19" })).json();
    expect(await route(s, "2026-03-19")).toEqual([rebooked.jobId]);

    // The visit was not done by the last day: the sweep closes the contract and the job leaves the route.
    ctx.now = new Date("2026-03-21T18:00:00Z");
    expect(await runContractFilings(complianceContext(tasks(ctx)), s.org.id)).toMatchObject({ ended: 1 });
    expect(await route(s, "2026-03-19")).toEqual([]);
    expect(await ctx.db.selectFrom("jobs").select("status").where("id", "=", rebooked.jobId).executeTakeFirstOrThrow()).toEqual({ status: "cancelled" });
  });

  it("keeps completed visits and takes unstarted jobs off the route when a contract is cancelled at once", async () => {
    const s = await lcraSetup(ctx);
    await complete(s);
    const second = s.contract.obligations[1] as { id: string };
    const next = (await s.api.post("/jobs", { obligationId: second.id, technicianId: s.tech.id, scheduledDate: "2026-04-10" })).json();
    expect(await route(s, "2026-04-10")).toEqual([next.jobId]);
    await s.api.post(`/contracts/${s.contract.id}/cancel`, { reason: "Owner sold the house", discontinuedBy: "owner" });
    expect(await route(s, "2026-04-10")).toEqual([]);
    const jobs = await ctx.db.selectFrom("jobs").select(["id", "status"]).where("organizationId", "=", s.org.id).execute();
    expect(jobs.find((j) => j.id === s.job.jobId)!.status).toBe("completed");
    expect(jobs.find((j) => j.id === next.jobId)!.status).toBe("cancelled");
    const visits = await ctx.db.selectFrom("serviceObligations").select(["id", "status"]).where("organizationId", "=", s.org.id).execute();
    expect(visits.find((v) => v.id === s.visit.id)!.status).toBe("completed");
  });
});

describe("readiness access", () => {
  it("keeps credentials, packages, requests and contract files inside their organization", async () => {
    mail.mode = "ok";
    const { s: a, filingId } = await readyLcraFiling(ctx, "Org A");
    const b = await lcraSetup(ctx, "Org B");
    const credsA = (await a.api.get("/credentials")).json().items;
    expect((await b.api.get("/credentials")).json().items).toEqual([]);
    expect((await b.api.patch(`/credentials/${credsA[0].id}`, { active: false })).statusCode).toBe(404);
    expect((await b.api.put("/settings/responsible-provider", { credentialId: credsA[0].id })).statusCode).toBe(404);
    const jA = await lcra(a);
    expect((await b.api.put(`/sites/${a.site.id}/authority-identifiers/${LCRA_ID}`, { jurisdictionId: jA.id, value: "X", sourceNote: null })).statusCode).toBe(404);
    const reqA = (await a.api.post("/service-requests", { siteId: a.site.id, kind: "odor", description: "Smell near the tank" })).json();
    expect((await b.api.post("/service-requests", { siteId: a.site.id, kind: "odor", description: "Smell near the tank" })).statusCode).toBe(404);
    expect((await b.api.post(`/service-requests/${reqA.id}/classify`, { classification: "not_reportable" })).statusCode).toBe(404);
    expect((await b.api.get(`/sites/${a.site.id}/service-requests`)).statusCode).toBe(404);
    expect((await b.api.post(`/contracts/${a.contract.id}/document`, { filename: "x.pdf", contentBase64: PDF.toString("base64") })).statusCode).toBe(404);
    expect((await b.api.get(`/contracts/${a.contract.id}/filing-status`)).statusCode).toBe(404);
    expect((await b.api.get(`/filings/${filingId}`)).statusCode).toBe(404);
    // A package link for one organization's file does not open another's.
    const url: string = (await detailOf(a, filingId)).packages[0].documents[0].url;
    expect((await client(ctx.app).get(url.replace(/sig=[^&]+/, "sig=forged"))).statusCode).toBe(404);
  });

  it("lets the owner manage credentials, office staff work requests, and technicians neither", async () => {
    const s = await lcraSetup(ctx);
    const office = await createUser(ctx.db, s.org.id, "office");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    expect((await officeApi.post("/credentials", { holderName: "X", kind: "tceq_maintenance_provider", number: "MP1" })).statusCode).toBe(403);
    expect((await officeApi.get("/credentials")).statusCode).toBe(200);
    const r = (await officeApi.post("/service-requests", { siteId: s.site.id, kind: "odor", description: "Smell near the tank" })).json();
    expect((await officeApi.post(`/service-requests/${r.id}/classify`, { classification: "owner_complaint" })).statusCode).toBe(200);
    expect((await s.techApi.post(`/service-requests/${r.id}/classify`, { classification: "not_reportable" })).statusCode).toBe(403);
    expect((await s.techApi.get("/credentials")).statusCode).toBe(403);
  });
});
