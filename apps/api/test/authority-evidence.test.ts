import { fileURLToPath } from "node:url";
import { bundledRulesets, loadCatalog, syncRulesets } from "@aerowise/compliance";
import type { AuthorityConfirmation, AuthorityEvidence, PublicOverview, RulesetCoverage, RulesetEvidencePage, RulesetProposal } from "@aerowise/domain";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminLogin, client, createAdmin, createTenant, setupTestApp } from "./helpers.ts";
import { pdfFonts, pdfText } from "./pdf-text.ts";

const ctx = setupTestApp();
const FIXTURES = bundledRulesets(fileURLToPath(new URL("./fixtures/rulesets", import.meta.url)));
const OPEN = "FICTIONAL: whether the authority accepts reports by email";

beforeEach(async () => {
  await syncRulesets(ctx.db);
  await syncRulesets(ctx.db, FIXTURES);
});

// Other test files list the authorities, so leave only the bundled ones behind.
afterAll(async () => {
  await sql`truncate jurisdiction_rulesets, jurisdictions cascade`.execute(ctx.db);
  await syncRulesets(ctx.db);
});

const call = {
  kind: "call",
  obtainedOn: "2026-02-20",
  contactName: "Pat Example",
  contactRole: "OSSF clerk",
  contactOrganization: "Draft Fixture County (fictional)",
  contactDetail: "555-0100",
  references: ["Call notes, 2026-02-20"],
  answers: [
    { question: "May licensed providers email the report to filings@?", unresolvedItem: OPEN, topic: "report_channel", answer: "Yes, as a PDF attachment.", outcome: "confirms" },
    { question: "Is a typed signature accepted?", topic: "signature", answer: "Only a drawn or wet-ink signature.", outcome: "partial" },
  ],
};

async function admin() {
  return client(ctx.app, (await createAdmin(ctx), await adminLogin(ctx)));
}

describe("authority evidence", () => {
  it("records dated evidence per question without changing the ruleset", async () => {
    const api = await admin();
    const before = (await loadCatalog(ctx.db)).find((e) => e.jurisdiction.key === "tx-fixture-draft")!;

    const res = await api.post("/admin/rulesets/tx-fixture-draft/evidence", call);
    expect(res.statusCode, res.body).toBe(201);
    const saved = res.json() as AuthorityEvidence;
    expect(saved).toMatchObject({ kind: "call", evidenceClass: "authority", rulesetVersion: 1, contactName: "Pat Example", recordedBy: expect.any(String), references: ["Call notes, 2026-02-20"] });
    expect(saved.answers.map((a) => [a.topic, a.outcome])).toEqual([
      ["report_channel", "confirms"],
      ["signature", "partial"],
    ]);

    // A provider's accepted report on the same question is kept apart from the authority's answer.
    const provider = await api.post("/admin/rulesets/tx-fixture-draft/evidence", {
      kind: "accepted_report",
      obtainedOn: "2026-02-01",
      contactName: "Owner",
      contactOrganization: "Example Aerobic Services (fictional)",
      references: ["report-2026-01.pdf and the county's reply"],
      answers: [{ question: "Was an emailed PDF accepted?", unresolvedItem: OPEN, topic: "receipt_acceptance", answer: "County replied 'received'.", outcome: "partial" }],
    });
    expect(provider.statusCode, provider.body).toBe(201);

    const page = (await api.get("/admin/rulesets/tx-fixture-draft")).json() as RulesetEvidencePage;
    expect(page).toMatchObject({ key: "tx-fixture-draft", profileStatus: "draft", verified: null, version: 1 });
    expect(page.unresolved).toEqual([{ item: OPEN, state: "authority_confirmed", answers: expect.any(Array) }]);
    expect(page.unresolved[0]!.answers.map((a) => a.evidenceClass).sort()).toEqual(["authority", "provider"]);
    expect(Object.fromEntries(page.acceptance.map((x) => [x.topic, x.state]))).toEqual({
      report_format: "open",
      signature: "authority_partial",
      contract_destination: "open",
      receipt_acceptance: "provider_evidence",
    });
    expect(page.otherAnswers.map((a) => a.topic)).toEqual(["signature"]);
    expect(page.evidence.map((e) => e.kind)).toEqual(["call", "accepted_report"]);

    // Nothing about the rules changed: same versions, same status, nothing closed.
    const after = (await loadCatalog(ctx.db)).find((e) => e.jurisdiction.key === "tx-fixture-draft")!;
    expect(after.rulesets).toEqual(before.rulesets);
    const audit = await ctx.db.selectFrom("platformAuditEvents").select("action").where("action", "!=", "admin.signed_in").orderBy("id").execute();
    expect(audit.map((a) => a.action)).toEqual(["authority_evidence.recorded", "authority_evidence.recorded"]);
  });

  it("refuses evidence without who answered, from the future, or naming a question the rulesets do not list", async () => {
    const api = await admin();
    const anon = await api.post("/admin/rulesets/tx-fixture-draft/evidence", { ...call, contactName: null });
    expect(anon.statusCode).toBe(400);
    const future = await api.post("/admin/rulesets/tx-fixture-draft/evidence", { ...call, obtainedOn: "2026-03-02" });
    expect(future.statusCode).toBe(422);
    const stray = await api.post("/admin/rulesets/tx-fixture-draft/evidence", { ...call, answers: [{ ...call.answers[0], unresolvedItem: "Something else" }] });
    expect(stray.statusCode).toBe(422);
    expect((await api.post("/admin/rulesets/tx-nowhere/evidence", call)).statusCode).toBe(404);
    expect(await ctx.db.selectFrom("authorityEvidence").select("id").execute()).toEqual([]);
  });

  it("is append-only", async () => {
    const api = await admin();
    const saved = (await api.post("/admin/rulesets/tx-fixture-draft/evidence", call)).json() as AuthorityEvidence;
    await expect(ctx.db.updateTable("authorityEvidence").set({ note: "edited" }).where("id", "=", saved.id).execute()).rejects.toThrow(/immutable/);
    await expect(ctx.db.deleteFrom("authorityEvidenceAnswers").where("evidenceId", "=", saved.id).execute()).rejects.toThrow(/immutable/);
  });

  it("prepares the next version as a diff for review, and never publishes it", async () => {
    const api = await admin();
    const saved = (await api.post("/admin/rulesets/tx-fixture-draft/evidence", call)).json() as AuthorityEvidence;
    const res = await api.post("/admin/rulesets/tx-fixture-draft/proposal", {
      answerIds: saved.answers.map((a) => a.id),
      effectiveFrom: "2026-03-01",
      verification: { confirmedWith: "Pat Example, OSSF clerk", confirmedBy: "Justin", confirmedOn: "2026-02-20", method: "phone", evidence: "Call notes, 2026-02-20" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json() as RulesetProposal;
    expect(p).toMatchObject({ version: 2, filePath: "packages/compliance/rulesets/tx-fixture-draft/v2.json", stillOpen: [], verified: false });
    expect(p.closes).toEqual([{ item: OPEN, answerIds: [saved.answers[0]!.id] }]);
    // One settled question is not a verified authority.
    expect(p.refusals.map((r) => r.reason).join(" ")).toMatch(/Not proposed as verified.*report format/);
    expect(JSON.parse(p.json).profile.status).toBe("draft");
    expect(p.diff).toContain(`-      "${OPEN}"`);

    const versions = await ctx.db
      .selectFrom("jurisdictionRulesets as r")
      .innerJoin("jurisdictions as j", "j.id", "r.jurisdictionId")
      .select("r.version")
      .where("j.key", "=", "tx-fixture-draft")
      .execute();
    expect(versions).toEqual([{ version: 1 }]);
    const audit = await ctx.db.selectFrom("platformAuditEvents").select("action").where("action", "!=", "admin.signed_in").orderBy("id").execute();
    expect(audit.map((a) => a.action)).toEqual(["authority_evidence.recorded", "ruleset.proposal_prepared"]);

    const bad = await api.post("/admin/rulesets/tx-example-county/proposal", { effectiveFrom: "2026-03-01" });
    expect(bad.statusCode).toBe(422);
  });

  it("shows partial confirmation per field on coverage, to offices, and only the authority's own confirmations publicly", async () => {
    const api = await admin();
    const empty = (await api.get("/admin/rulesets")).json() as RulesetCoverage;
    expect(empty.items.find((i) => i.key === "tx-fixture-draft")?.confirmation).toBe("Nothing recorded with the authority yet");

    expect((await api.post("/admin/rulesets/tx-fixture-draft/evidence", call)).statusCode).toBe(201);
    // A provider's accepted report and a published rule support answers but confirm nothing.
    const provider = await api.post("/admin/rulesets/tx-fixture-draft/evidence", {
      kind: "accepted_report",
      obtainedOn: "2026-02-01",
      contactName: "Owner",
      contactOrganization: "Example Aerobic Services (fictional)",
      references: ["report-2026-01.pdf"],
      answers: [{ question: "Was an emailed PDF accepted?", topic: "report_format", answer: "Yes, once.", outcome: "confirms" }],
    });
    expect(provider.statusCode, provider.body).toBe(201);

    const line = "Where reports go confirmed by the authority; signature partly confirmed by the authority; report format provider evidence only; where contracts go and receipt and acceptance open";
    const coverage = (await api.get("/admin/rulesets")).json() as RulesetCoverage;
    expect(coverage.items.find((i) => i.key === "tx-fixture-draft")?.confirmation).toBe(line);

    const t = await createTenant(ctx, "Org A");
    const id = (await loadCatalog(ctx.db)).find((e) => e.jurisdiction.key === "tx-fixture-draft")!.jurisdiction.id;
    const res = await t.api.get(`/jurisdictions/${id}/confirmation`);
    expect(res.statusCode, res.body).toBe(200);
    const office = res.json() as AuthorityConfirmation;
    expect(office.summary).toBe(line);
    expect(Object.fromEntries(office.fields.map((f) => [f.topic, f.state]))).toEqual({
      report_channel: "authority_confirmed",
      report_format: "provider_evidence",
      signature: "authority_partial",
      contract_destination: "open",
      receipt_acceptance: "open",
    });
    // States only: who answered and what they said stay with platform admins.
    expect(res.body).not.toContain("Pat Example");
    expect(res.body).not.toContain("555-0100");
    expect((await t.api.get("/jurisdictions/00000000-0000-4000-8000-000000000000/confirmation")).statusCode).toBe(404);

    const overview = (await ctx.app.inject({ method: "GET", url: "/public/overview" })).json() as PublicOverview;
    expect(overview.coverage.find((c) => c.key === "tx-fixture-draft")?.confirmedWithAuthority).toEqual(["Where reports go"]);
    expect(overview.coverage.find((c) => c.key === "tx-fixture-verified")?.confirmedWithAuthority).toEqual([]);
  });

  it("is for platform admins only", async () => {
    const t = await createTenant(ctx, "Org A");
    expect((await t.api.get("/admin/rulesets/tx-fixture-draft")).statusCode).toBe(401);
    expect((await t.api.post("/admin/rulesets/tx-fixture-draft/evidence", call)).statusCode).toBe(401);
    expect((await t.api.post("/admin/rulesets/tx-fixture-draft/proposal", { effectiveFrom: "2026-03-01" })).statusCode).toBe(401);
    expect((await t.api.get("/admin/rulesets/tx-fixture-draft/call-sheet.pdf")).statusCode).toBe(401);
  });

  it("prints a call sheet from the open questions and dated evidence, naming no contact and claiming nothing", async () => {
    const api = await admin();
    // Before any evidence: every question open, the sheet says draft, sources are dated.
    const blank = await api.get("/admin/rulesets/tx-fixture-draft/call-sheet.pdf");
    expect(blank.statusCode, blank.body).toBe(200);
    expect(blank.headers["content-type"]).toBe("application/pdf");
    expect(blank.headers["content-disposition"]).toMatch(/^inline; filename="aerowise-call-sheet-tx-fixture-draft-\d{4}-\d{2}-\d{2}\.pdf"$/);
    const before = pdfText(blank.rawPayload).replace(/\s+/g, " ");
    expect(before).toContain("DRAFT / UNVERIFIED");
    expect(before).toContain("NOT A RECORD OF CONTACT");
    expect(before).toContain(OPEN);
    expect(before).toContain("No evidence recorded yet.");
    expect(before).toContain("FICTIONAL fixture source (read 2026-01-10) https://tx-fixture-draft.example/rules");
    expect(before).toContain("This sheet gives no phone number, email or address.");
    // Room to record who was asked, when and what they said.
    for (const label of ["Contact name", "Date and time", "Channel (call, email, letter, meeting)", "Answer, scope and exact words:"]) expect(before).toContain(label);
    // Every font is embedded, so it prints evenly anywhere.
    expect(pdfFonts(blank.rawPayload).every((f) => f.embedded)).toBe(true);

    // With evidence: each answer appears dated and attributed; the contact's number does not.
    expect((await api.post("/admin/rulesets/tx-fixture-draft/evidence", call)).statusCode).toBe(201);
    const after = pdfText((await api.get("/admin/rulesets/tx-fixture-draft/call-sheet.pdf")).rawPayload).replace(/\s+/g, " ");
    expect(after).toContain("Now: Confirmed by the authority");
    expect(after).toContain("On record: 2026-02-20, Authority's own answer (call with the authority, Draft Fixture County (fictional)): Settles it. Yes, as a PDF attachment. Sources: Call notes, 2026-02-20");
    expect(after).toContain("Now: Partly confirmed by the authority");
    expect(after).not.toContain("555-0100");
    expect(after).not.toContain("Pat Example");
    // Still a draft: recorded evidence verifies nothing.
    expect(after).toContain("DRAFT / UNVERIFIED");

    // Example rules have no authority to ask; an unknown authority is not found.
    expect((await api.get("/admin/rulesets/tx-example-county/call-sheet.pdf")).statusCode).toBe(422);
    expect((await api.get("/admin/rulesets/tx-nowhere/call-sheet.pdf")).statusCode).toBe(404);
  });
});
