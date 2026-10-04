import { createHash } from "node:crypto";
import { bundledRulesets, contractDeadline, explainSite, loadCatalog, submitFiling } from "@aerowise/compliance";
import { complianceContext, drainTasks, runContractFilings } from "@aerowise/tasks";
import { contractFilingRequired, mayAutoSubmit, profileStatus, type RulesetRules } from "@aerowise/domain";
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
  expect((await s.api.post(`/filings/${f!.id}/recheck`, {})).json()).toMatchObject({ status: "ready" });
  return { s, j, filingId: f!.id };
}

describe("authority profiles", () => {
  const ruleset = (key: string) => bundledRulesets().find((r) => r.jurisdiction.key === key)!;

  it("never let a draft profile send on its own", () => {
    const example = ruleset("tx-example-county");
    expect(profileStatus(example)).toBe("fictional");
    expect(mayAutoSubmit(example)).toBe(true);
    const draft = { ...example, profile: { status: "draft" as const, sourcesCheckedOn: "2026-10-04", requirementEffective: { date: null, basis: "x" }, sources: [], unresolved: ["x"] } };
    expect(mayAutoSubmit(draft)).toBe(false);
    expect(mayAutoSubmit({ ...draft, profile: { ...draft.profile, status: "verified" as const, unresolved: [] } })).toBe(true);
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
    expect(before.candidates.map((c: { key: string }) => c.key)).toEqual(["tx-lcra-ossf"]);

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
    for (const county of ["Travis", "Burnet County", "llano"]) {
      const r = explainSite(catalog, site(county), "2026-03-01");
      expect(r.resolved).toBeNull();
      expect(r.candidates.map((c) => c.jurisdiction.key)).toEqual(["tx-lcra-ossf"]);
    }
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
    const ready = (await s.api.post(`/filings/${f!.id}/recheck`, {})).json();
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
    expect(contractDeadline(rules, "2026-11-30")).toMatchObject({ deadlineOn: "2026-10-31" });
    // A first contract in Aerowise: the end of what it replaces is unknown, so no date is invented.
    expect(contractDeadline(rules, null)).toMatchObject({ deadlineOn: null, basis: expect.stringContaining("initial two-year service policy") });
    expect(contractDeadline({ contracts: { filingRequired: true, note: "" } } as unknown as RulesetRules, "2026-11-30")).toMatchObject({ deadlineOn: null });

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
    // Marking it not reportable releases the filing at once; nothing else holds it.
    await s.api.post(`/service-requests/${inPeriod.id}/classify`, { classification: "not_reportable" });
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

    // Recording the responses checked the held filing again: nothing waits on a repair.
    const [f] = await filings(s, "inspection_report");
    expect(f!.status).toBe("ready");
    const detail = await detailOf(s, f!.id);
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
    const redone = await detailOf(s, f!.id);
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
    expect(deliveries).toEqual([expect.objectContaining({ documentKind: "inspection_report", recipient: "pat@example.com", documentSha256: customer.sha256, status: "accepted" })]);
    // The customer email is not a filing attempt, and the filing is still waiting to be sent.
    expect((await detailOf(s, filingId))).toMatchObject({ status: "ready", attempts: [] });
    expect([...mail.delivered.values()].map((m) => m.to)).toEqual(["pat@example.com"]);

    await s.api.post(`/filings/${filingId}/submit`, {});
    await runWorker(ctx);
    const sent = await detailOf(s, filingId);
    expect(sent.attempts).toEqual([expect.objectContaining({ status: "succeeded", recipient: "ossf@lcra.org", packageId: sent.packages[0].id })]);
    expect(sent.attempts[0].response).toMatchObject({ manifestSha256: sent.packages[0].manifestSha256 });
    const toLcra = [...mail.delivered.values()].find((m) => m.to === "ossf@lcra.org")!;
    expect(toLcra.attachments.map((a) => a.filename)).toEqual(["cover-sheet.pdf", "inspection-report-v1.pdf"]);
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
    const after = corrected.json();
    expect(after).toMatchObject({ status: "ready", submissionNo: 2 });
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
