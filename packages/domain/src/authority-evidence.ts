import { z } from "zod";
import { PROFILE_STATUSES, rulesetRules, verificationBadge, verificationRecord, type RulesetRules } from "./filings.ts";

// W12.1: dated evidence about what a reporting authority requires, and what it says to
// each open question. Recording evidence never changes a ruleset: rules change only by a
// new, reviewed version (W6.5). The proposal below prepares that version and its diff for
// the pull request; it never publishes anything.

const isoDate = z.iso.date();

/**
 * Where an answer comes from. A call, email, letter or meeting is the authority itself;
 * a published rule is what the authority wrote for everyone; a permit, signed contract or
 * accepted report is what a provider holds. They are kept apart because only the
 * authority's own answer confirms how it accepts filings.
 */
export const EVIDENCE_KINDS = ["call", "email", "letter", "meeting", "published_rule", "permit", "signed_contract", "accepted_report"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const EVIDENCE_KIND_LABELS: Record<EvidenceKind, string> = {
  call: "Call with the authority",
  email: "Email from the authority",
  letter: "Letter from the authority",
  meeting: "Meeting with the authority",
  published_rule: "Published rule or form",
  permit: "Provider's permit",
  signed_contract: "Provider's signed contract",
  accepted_report: "Provider's accepted report",
};

export const EVIDENCE_CLASSES = ["authority", "public_rule", "provider"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];
export const EVIDENCE_CLASS_LABELS: Record<EvidenceClass, string> = {
  authority: "Authority's own answer",
  public_rule: "Published rule",
  provider: "Provider document",
};
export function evidenceClass(kind: EvidenceKind): EvidenceClass {
  if (kind === "published_rule") return "public_rule";
  if (kind === "permit" || kind === "signed_contract" || kind === "accepted_report") return "provider";
  return "authority";
}

export const QUESTION_TOPICS = [
  "report_channel",
  "contract_destination",
  "report_format",
  "signature",
  "receipt_acceptance",
  "deadline",
  "schedule",
  "lab_tests",
  "required_fields",
  "assignment",
  "fees",
  "effective_date",
  "registration",
  "other",
] as const;
export type QuestionTopic = (typeof QUESTION_TOPICS)[number];
export const QUESTION_TOPIC_LABELS: Record<QuestionTopic, string> = {
  report_channel: "Where reports go",
  contract_destination: "Where contracts go",
  report_format: "Report format",
  signature: "Signature",
  receipt_acceptance: "Receipt and acceptance",
  deadline: "Deadline",
  schedule: "Visit schedule",
  lab_tests: "Lab tests",
  required_fields: "Required report fields",
  assignment: "Which sites are theirs",
  fees: "Fees",
  effective_date: "Effective date and approval",
  registration: "Provider registration",
  other: "Other",
};

/**
 * What an authority must confirm itself before its profile can be verified, whatever its
 * published rules say: that it takes this report, signed this way, where contracts go,
 * and what it sends back.
 */
export const ACCEPTANCE_TOPICS = ["report_format", "signature", "contract_destination", "receipt_acceptance"] as const satisfies readonly QuestionTopic[];

export const ANSWER_OUTCOMES = ["confirms", "partial", "contradicts", "no_answer"] as const;
export type AnswerOutcome = (typeof ANSWER_OUTCOMES)[number];
export const ANSWER_OUTCOME_LABELS: Record<AnswerOutcome, string> = {
  confirms: "Settles it",
  partial: "Answers part of it",
  contradicts: "Contradicts the current rule",
  no_answer: "No answer",
};

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  text(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** A ruleset field path, such as `filing.deadlineDays` or `submission.email.to`. */
const fieldPath = z
  .string()
  .trim()
  .max(200)
  .regex(/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$/, "A ruleset field such as filing.deadlineDays");

export const evidenceAnswerInput = z.object({
  /** The question exactly as asked, or as read against the document. */
  question: text(2000).min(1, "Enter the question"),
  /** The ruleset's open question this answers, word for word, when it answers one. */
  unresolvedItem: optionalText(2000),
  topic: z.enum(QUESTION_TOPICS),
  field: fieldPath
    .nullish()
    .or(z.literal(""))
    .transform((v) => (v ? v : null)),
  answer: text(4000).min(1, "Enter the answer"),
  outcome: z.enum(ANSWER_OUTCOMES),
});
export type EvidenceAnswerInput = z.input<typeof evidenceAnswerInput>;

export const authorityEvidenceInput = z
  .object({
    kind: z.enum(EVIDENCE_KINDS),
    obtainedOn: isoDate,
    contactName: optionalText(200),
    /** Their title or office. */
    contactRole: optionalText(200),
    /** The authority, or the provider company, they speak for. */
    contactOrganization: optionalText(200),
    /** Phone number or email address used. */
    contactDetail: optionalText(300),
    /** Where the evidence is kept: URL and page, file name, an email's subject and date. */
    references: z.array(text(1000).min(1)).min(1, "Add where the evidence is kept").max(20),
    note: optionalText(4000),
    answers: z.array(evidenceAnswerInput).min(1, "Record at least one question and answer").max(50),
  })
  .superRefine((e, ctx) => {
    if (evidenceClass(e.kind) !== "authority") return;
    if (!e.contactName) ctx.addIssue({ code: "custom", path: ["contactName"], message: "Name who at the authority answered" });
    if (!e.contactOrganization) ctx.addIssue({ code: "custom", path: ["contactOrganization"], message: "Name the office they speak for" });
  });
export type AuthorityEvidenceInput = z.input<typeof authorityEvidenceInput>;

export const evidenceAnswer = z.object({
  id: z.uuid(),
  evidenceId: z.uuid(),
  question: z.string(),
  unresolvedItem: z.string().nullable(),
  topic: z.enum(QUESTION_TOPICS),
  field: z.string().nullable(),
  answer: z.string(),
  outcome: z.enum(ANSWER_OUTCOMES),
  kind: z.enum(EVIDENCE_KINDS),
  evidenceClass: z.enum(EVIDENCE_CLASSES),
  obtainedOn: isoDate,
  contactName: z.string().nullable(),
  contactOrganization: z.string().nullable(),
});
export type EvidenceAnswer = z.infer<typeof evidenceAnswer>;

export const authorityEvidence = z.object({
  id: z.uuid(),
  kind: z.enum(EVIDENCE_KINDS),
  evidenceClass: z.enum(EVIDENCE_CLASSES),
  obtainedOn: isoDate,
  /** The newest ruleset version when it was recorded. */
  rulesetVersion: z.number().int(),
  contactName: z.string().nullable(),
  contactRole: z.string().nullable(),
  contactOrganization: z.string().nullable(),
  contactDetail: z.string().nullable(),
  references: z.array(z.string()),
  note: z.string().nullable(),
  recordedBy: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  answers: z.array(evidenceAnswer),
});
export type AuthorityEvidence = z.infer<typeof authorityEvidence>;

/**
 * How far one question is answered, strongest first:
 * - authority_confirmed: the authority's latest answer settles it (the ruleset still lists
 *   it until a new version is reviewed)
 * - authority_partial: the authority's latest answer covers part of it
 * - conflict: an answer contradicts the current rule
 * - provider_evidence: a provider's document supports an answer; the authority has not said
 * - public_rule: a published rule supports an answer; the authority has not said
 * - open: nothing recorded
 */
export const QUESTION_STATES = ["authority_confirmed", "authority_partial", "conflict", "provider_evidence", "public_rule", "open"] as const;
export type QuestionState = (typeof QUESTION_STATES)[number];
export const QUESTION_STATE_LABELS: Record<QuestionState, string> = {
  authority_confirmed: "Confirmed by the authority",
  authority_partial: "Partly confirmed by the authority",
  conflict: "Conflicting answer",
  provider_evidence: "Provider evidence only",
  public_rule: "Published rule only",
  open: "Open",
};

type Answered = Pick<EvidenceAnswer, "outcome" | "evidenceClass" | "obtainedOn">;

export function questionState(answers: Answered[]): QuestionState {
  const authority = answers.filter((a) => a.evidenceClass === "authority" && a.outcome !== "no_answer").sort((a, b) => b.obtainedOn.localeCompare(a.obtainedOn));
  // The authority's most recent answer decides what the authority has said.
  const latest = authority[0];
  if (latest?.outcome === "confirms") return "authority_confirmed";
  if (latest?.outcome === "partial") return "authority_partial";
  if (answers.some((a) => a.outcome === "contradicts")) return "conflict";
  const supports = (c: EvidenceClass) => answers.some((a) => a.evidenceClass === c && (a.outcome === "confirms" || a.outcome === "partial"));
  if (supports("provider")) return "provider_evidence";
  if (supports("public_rule")) return "public_rule";
  return "open";
}

export const rulesetEvidencePage = z.object({
  key: z.string(),
  authorityName: z.string(),
  profileStatus: z.enum(PROFILE_STATUSES),
  verified: verificationBadge.nullable(),
  /** The newest published version: the one a new version would follow. */
  version: z.number().int(),
  effectiveFrom: isoDate,
  versionInForce: z.number().int().nullable(),
  today: isoDate,
  /** The newest version's open questions, each with what has been recorded against it. */
  unresolved: z.array(z.object({ item: z.string(), state: z.enum(QUESTION_STATES), answers: z.array(evidenceAnswer) })),
  /** What the authority itself must confirm before the profile can be verified. */
  acceptance: z.array(z.object({ topic: z.enum(QUESTION_TOPICS), label: z.string(), state: z.enum(QUESTION_STATES), answers: z.array(evidenceAnswer) })),
  /** Answers for open questions of earlier versions, or no open question. */
  otherAnswers: z.array(evidenceAnswer),
  evidence: z.array(authorityEvidence),
});
export type RulesetEvidencePage = z.infer<typeof rulesetEvidencePage>;

export const rulesetProposalInput = z.object({
  /** The answers to apply: only the authority's own answers that settle an open question close it. */
  answerIds: z.array(z.uuid()).max(200).default([]),
  /** When the new version would start applying. */
  effectiveFrom: isoDate,
  /** To propose a verified version: the full W6.5 record. */
  verification: verificationRecord.nullish(),
});
export type RulesetProposalInput = z.input<typeof rulesetProposalInput>;

export const rulesetProposal = z.object({
  key: z.string(),
  fromVersion: z.number().int(),
  version: z.number().int(),
  /** Where the new file goes in the repository. */
  filePath: z.string(),
  /** The proposed file, ready to commit in a reviewed pull request. */
  json: z.string(),
  /** Line diff against the current newest version. */
  diff: z.string(),
  verified: z.boolean(),
  closes: z.array(z.object({ item: z.string(), answerIds: z.array(z.uuid()) })),
  stillOpen: z.array(z.string()),
  /** Rule values an answer says are wrong. The proposal never changes them; the pull request does. */
  ruleChanges: z.array(z.object({ answerId: z.uuid(), field: z.string().nullable(), question: z.string(), answer: z.string() })),
  /** Why something asked for was not applied. */
  refusals: z.array(z.object({ answerId: z.uuid().nullable(), reason: z.string() })),
});
export type RulesetProposal = z.infer<typeof rulesetProposal>;

/**
 * Prepares the next ruleset version from recorded answers, for a reviewed pull request.
 * Nothing here publishes or changes the rules in force.
 *
 * Only the authority's own answer that settles an open question closes it; a provider's
 * document or a published rule is listed as support but leaves the question open. An
 * answer that contradicts a rule is listed for a person to change by hand. The version is
 * proposed as verified only when nothing is left open, the authority itself has confirmed
 * every acceptance topic, and the full W6.5 record is given; otherwise it stays a draft.
 */
export function buildRulesetProposal(current: RulesetRules, allAnswers: EvidenceAnswer[], input: z.output<typeof rulesetProposalInput>): RulesetProposal {
  const profile = current.profile;
  if (!profile || profile.status === "fictional") throw new ProposalError("Fictional rules are never verified; there is nothing to propose.");
  if (input.effectiveFrom < current.effectiveFrom) throw new ProposalError(`The new version cannot start before v${current.version} (${current.effectiveFrom}).`);
  const byId = new Map(allAnswers.map((a) => [a.id, a]));
  const unknown = input.answerIds.filter((id) => !byId.has(id));
  if (unknown.length) throw new ProposalError("Some answers are not recorded for this authority.");

  const refusals: RulesetProposal["refusals"] = [];
  const ruleChanges: RulesetProposal["ruleChanges"] = [];
  const closing = new Map<string, string[]>();
  for (const id of input.answerIds) {
    const a = byId.get(id)!;
    if (a.outcome === "contradicts") {
      ruleChanges.push({ answerId: a.id, field: a.field, question: a.question, answer: a.answer });
      continue;
    }
    if (!a.unresolvedItem || !profile.unresolved.includes(a.unresolvedItem)) {
      refusals.push({ answerId: a.id, reason: "It does not answer one of this version's open questions." });
    } else if (a.evidenceClass !== "authority") {
      refusals.push({ answerId: a.id, reason: `${EVIDENCE_CLASS_LABELS[a.evidenceClass]} supports an answer but does not close the question; only the authority's own answer does.` });
    } else if (a.outcome !== "confirms") {
      refusals.push({ answerId: a.id, reason: "It does not settle the question, so the question stays open." });
    } else {
      closing.set(a.unresolvedItem, [...(closing.get(a.unresolvedItem) ?? []), a.id]);
    }
  }
  const stillOpen = profile.unresolved.filter((u) => !closing.has(u));

  let verified = false;
  const next: RulesetRules = structuredClone(current);
  next.version = current.version + 1;
  next.effectiveFrom = input.effectiveFrom;
  next.effectiveTo = null;
  next.profile = { ...profile, status: "draft", unresolved: stillOpen };
  delete next.profile.verification;

  if (input.verification) {
    const reasons: string[] = [];
    if (stillOpen.length) reasons.push(`${stillOpen.length} open question${stillOpen.length === 1 ? " has" : "s have"} no settling answer from the authority.`);
    const confirmed = new Set(allAnswers.filter((a) => a.evidenceClass === "authority" && a.outcome === "confirms").map((a) => a.topic));
    const missing = ACCEPTANCE_TOPICS.filter((t) => !confirmed.has(t));
    if (missing.length) reasons.push(`The authority has not confirmed: ${missing.map((t) => QUESTION_TOPIC_LABELS[t].toLowerCase()).join(", ")}.`);
    if (ruleChanges.length) reasons.push("An answer contradicts the current rules; change them first.");
    if (reasons.length) {
      for (const reason of reasons) refusals.push({ answerId: null, reason: `Not proposed as verified. ${reason}` });
    } else {
      next.profile = { ...next.profile, status: "verified", verification: input.verification };
      verified = true;
    }
  }

  // The same checks as a bundled file, so the proposal is never something the repo refuses.
  const parsed = rulesetRules.safeParse(next);
  if (!parsed.success) throw new ProposalError(`The proposed version is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);

  const before = `${JSON.stringify(current, null, 2)}\n`;
  const json = `${JSON.stringify(next, null, 2)}\n`;
  return {
    key: current.jurisdiction.key,
    fromVersion: current.version,
    version: next.version,
    filePath: `packages/compliance/rulesets/${current.jurisdiction.key}/v${next.version}.json`,
    json,
    diff: unifiedDiff(before, json, `v${current.version}.json`, `v${next.version}.json`),
    verified,
    closes: [...closing].map(([item, answerIds]) => ({ item, answerIds })),
    stillOpen,
    ruleChanges,
    refusals,
  };
}

export class ProposalError extends Error {}

/** A line diff with three lines of context around each change. */
export function unifiedDiff(a: string, b: string, fromName: string, toName: string, context = 3): string {
  const x = a.split("\n");
  const y = b.split("\n");
  // Longest common subsequence table; ruleset files are a few hundred lines.
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: { op: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) ops.push({ op: " ", line: x[i++]! }), j++;
    // Removed lines before added ones, as diff tools show them.
    else if (i < x.length && (j === y.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push({ op: "-", line: x[i++]! });
    else ops.push({ op: "+", line: y[j++]! });
  }
  const keep = ops.map(() => false);
  ops.forEach((o, k) => {
    if (o.op === " ") return;
    for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) keep[c] = true;
  });
  const out = [`--- ${fromName}`, `+++ ${toName}`];
  let gap = false;
  ops.forEach((o, k) => {
    if (!keep[k]) {
      gap = true;
      return;
    }
    if (gap || out.length === 2) out.push("@@");
    gap = false;
    out.push(`${o.op}${o.line}`);
  });
  return out.length === 2 ? "" : out.join("\n");
}
