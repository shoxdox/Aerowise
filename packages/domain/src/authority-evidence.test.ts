import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authorityEvidenceInput, buildRulesetProposal, evidenceClass, ProposalError, questionState, rulesetProposalInput, unifiedDiff, type EvidenceAnswer } from "./authority-evidence.ts";
import { rulesetRules } from "./filings.ts";

const draft = rulesetRules.parse(JSON.parse(readFileSync(new URL("../../../apps/api/test/fixtures/rulesets/tx-fixture-draft/v1.json", import.meta.url), "utf8")));
const OPEN = "FICTIONAL: whether the authority accepts reports by email";

let n = 0;
function answer(over: Partial<EvidenceAnswer>): EvidenceAnswer {
  const kind = over.kind ?? "email";
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    evidenceId: "00000000-0000-4000-8000-ffffffffffff",
    question: "May providers email this report?",
    unresolvedItem: OPEN,
    topic: "report_channel",
    field: null,
    answer: "Yes, to the filings inbox.",
    outcome: "confirms",
    kind,
    evidenceClass: evidenceClass(kind),
    obtainedOn: "2026-03-01",
    contactName: "OSSF clerk",
    contactOrganization: "Draft Fixture County",
    ...over,
  };
}
const acceptance = () => (["report_format", "signature", "contract_destination", "receipt_acceptance"] as const).map((topic) => answer({ topic, unresolvedItem: null }));
const VERIFICATION = { confirmedWith: "OSSF clerk, Draft Fixture County", confirmedBy: "Justin", confirmedOn: "2026-03-01", method: "email" as const, evidence: "Reply email 2026-03-01" };
const input = (over: Record<string, unknown>) => rulesetProposalInput.parse({ effectiveFrom: "2026-03-02", ...over });

describe("recording evidence", () => {
  it("needs who answered when the authority answered", () => {
    const base = { kind: "call", obtainedOn: "2026-03-01", references: ["Call notes 2026-03-01"], answers: [{ question: "Q", topic: "deadline", answer: "A", outcome: "partial" }] };
    const r = authorityEvidenceInput.safeParse(base);
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join("."))).toEqual(["contactName", "contactOrganization"]);
    expect(authorityEvidenceInput.safeParse({ ...base, contactName: "Clerk", contactOrganization: "County" }).success).toBe(true);
    // A provider's document or a published rule has no authority contact to name.
    expect(authorityEvidenceInput.safeParse({ ...base, kind: "accepted_report" }).success).toBe(true);
    expect(authorityEvidenceInput.safeParse({ ...base, references: [] }).success).toBe(false);
  });

  it("keeps the three kinds of evidence apart", () => {
    expect([evidenceClass("call"), evidenceClass("letter"), evidenceClass("published_rule"), evidenceClass("accepted_report"), evidenceClass("permit")]).toEqual([
      "authority",
      "authority",
      "public_rule",
      "provider",
      "provider",
    ]);
  });
});

describe("question state", () => {
  it("lets the authority's latest answer decide, and never counts other evidence as confirmation", () => {
    expect(questionState([])).toBe("open");
    expect(questionState([answer({ kind: "published_rule" })])).toBe("public_rule");
    expect(questionState([answer({ kind: "published_rule" }), answer({ kind: "accepted_report" })])).toBe("provider_evidence");
    expect(questionState([answer({ kind: "accepted_report" }), answer({ kind: "call", outcome: "partial" })])).toBe("authority_partial");
    expect(questionState([answer({ obtainedOn: "2026-01-01", outcome: "partial" }), answer({ obtainedOn: "2026-02-01" })])).toBe("authority_confirmed");
    expect(questionState([answer({ obtainedOn: "2026-02-01", outcome: "partial" }), answer({ obtainedOn: "2026-01-01" })])).toBe("authority_partial");
    expect(questionState([answer({ kind: "permit", outcome: "contradicts" }), answer({ kind: "accepted_report" })])).toBe("conflict");
    expect(questionState([answer({ outcome: "no_answer" })])).toBe("open");
  });
});

describe("proposing the next version", () => {
  it("closes a question only on the authority's own settling answer, and stays a draft", () => {
    const provider = answer({ kind: "accepted_report" });
    const partial = answer({ outcome: "partial" });
    const p = buildRulesetProposal(draft, [provider, partial], input({ answerIds: [provider.id, partial.id] }));
    expect(p.stillOpen).toEqual([OPEN]);
    expect(p.closes).toEqual([]);
    expect(p.refusals.map((r) => r.answerId)).toEqual([provider.id, partial.id]);
    expect(p.refusals[0]!.reason).toMatch(/does not close the question/);
    expect(p.verified).toBe(false);

    const yes = answer({});
    const q = buildRulesetProposal(draft, [yes], input({ answerIds: [yes.id] }));
    expect(q).toMatchObject({ fromVersion: 1, version: 2, filePath: "packages/compliance/rulesets/tx-fixture-draft/v2.json", stillOpen: [], verified: false });
    const next = JSON.parse(q.json);
    expect(next.profile.status).toBe("draft");
    expect(next.profile.unresolved).toEqual([]);
    expect(next.effectiveFrom).toBe("2026-03-02");
    // The rules themselves are untouched.
    expect(next.filing).toEqual(draft.filing);
    expect(next.submission).toEqual(draft.submission);
    expect(q.diff).toContain(`-      "${OPEN}"`);
    expect(q.diff).toContain('+  "version": 2,');
  });

  it("lists contradicting answers as rule changes for a person to make, and never applies them", () => {
    const wrong = answer({ outcome: "contradicts", field: "filing.deadlineDays", answer: "Ten days, not fourteen" });
    const p = buildRulesetProposal(draft, [wrong], input({ answerIds: [wrong.id], verification: VERIFICATION }));
    expect(p.ruleChanges).toEqual([{ answerId: wrong.id, field: "filing.deadlineDays", question: wrong.question, answer: "Ten days, not fourteen" }]);
    expect(JSON.parse(p.json).filing.deadlineDays).toBe(14);
    expect(p.verified).toBe(false);
  });

  it("proposes verified only with nothing open, every acceptance topic confirmed by the authority, and the full record", () => {
    const yes = answer({});
    // One settling answer is not enough: the acceptance topics are unconfirmed.
    const p = buildRulesetProposal(draft, [yes], input({ answerIds: [yes.id], verification: VERIFICATION }));
    expect(p.verified).toBe(false);
    expect(JSON.parse(p.json).profile.status).toBe("draft");
    expect(p.refusals.map((r) => r.reason).join(" ")).toMatch(/report format, signature, where contracts go, receipt and acceptance/);

    // Provider documents covering every topic still are not the authority's confirmation.
    const providerTopics = acceptance().map((a) => ({ ...a, kind: "accepted_report" as const, evidenceClass: "provider" as const }));
    expect(buildRulesetProposal(draft, [yes, ...providerTopics], input({ answerIds: [yes.id], verification: VERIFICATION })).verified).toBe(false);

    // Everything confirmed, but no verification record: still a draft.
    const all = [yes, ...acceptance()];
    expect(buildRulesetProposal(draft, all, input({ answerIds: [yes.id] })).verified).toBe(false);

    const v = buildRulesetProposal(draft, all, input({ answerIds: [yes.id], verification: VERIFICATION }));
    expect(v.verified).toBe(true);
    const next = rulesetRules.parse(JSON.parse(v.json));
    expect(next.profile).toMatchObject({ status: "verified", unresolved: [], verification: VERIFICATION });
  });

  it("refuses fictional rules, unknown answers and an earlier start", () => {
    const fictional = { ...draft, profile: undefined };
    expect(() => buildRulesetProposal(fictional, [], input({}))).toThrow(ProposalError);
    expect(() => buildRulesetProposal(draft, [], input({ answerIds: ["00000000-0000-4000-8000-999999999999"] }))).toThrow(/not recorded/);
    expect(() => buildRulesetProposal(draft, [], input({ effectiveFrom: "2019-01-01" }))).toThrow(/cannot start before/);
  });
});

describe("unifiedDiff", () => {
  it("shows changed lines with context and nothing when equal", () => {
    expect(unifiedDiff("a\nb\nc", "a\nb\nc", "x", "y")).toBe("");
    expect(unifiedDiff("1\n2\n3\n4\n5\n6\n7\n8\n9", "1\n2\n3\n4\nfive\n6\n7\n8\n9", "x", "y", 1)).toBe(["--- x", "+++ y", "@@", " 4", "-5", "+five", " 6"].join("\n"));
  });
});
