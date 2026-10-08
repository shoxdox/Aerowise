import type { Database, DB } from "@aerowise/db";
import {
  addDays,
  addMonths,
  canTransitionFiling,
  contractFilingRequired,
  exportLayoutFor,
  FILING_STATE_MACHINE,
  filingFees,
  lateFeeOwed,
  mayAutoSubmit,
  serviceIntervalMonths,
  siteScheduleProblem,
  type FilingKind,
  type FilingProof,
  type SiteUseCategory,
  type FilingStatus,
  type InspectionValues,
  type SubmissionMethod,
  type TemplateDefinition,
} from "@aerowise/domain";
import type { ObjectStore } from "@aerowise/storage";
import { sql, type Transaction, type Updateable } from "kysely";
import { adapterFor, adapterVersion, type CanonicalInspection, type JurisdictionAdapter } from "./adapter.ts";
import type { EmailTransport } from "./email.ts";
import { providerSignatureRequired, reportSignature } from "./signatures.ts";
import { contractBasisOf, contractDeadline, ensurePackage, findPackage, PackageNotReady, packageProblems } from "./packages.ts";
import { amendmentsOf, currentAuthorityResponses, latestAuthorityReport, responsesForInspection, sameResponses, writeReportVersion } from "./reports.ts";
import { siteMonitoredOn } from "./monitoring.ts";
import { dateInZone, explainSite, loadCatalog, NO_AUTHORITY, type ResolvedJurisdiction } from "./rulesets.ts";

type Executor = Database | Transaction<DB>;

export const SUBMIT_FILING = "filings.submit";

/** Queues a background task in the caller's transaction (the tasks package's `enqueue`). */
export type Enqueue = (
  trx: Executor,
  task: { kind: string; organizationId: string | null; payload: Record<string, unknown>; dedupeKey?: string; runAt?: Date },
) => Promise<void>;

export interface ComplianceContext {
  db: Database;
  store: ObjectStore;
  mail: EmailTransport;
  now: () => Date;
  enqueue: Enqueue;
  /** The From address on filing emails. */
  from?: string;
}

/** A filing action that the filing's current status does not allow. */
export class FilingStateError extends Error {}

export { dateInZone } from "./rulesets.ts";

type FilingRow = {
  id: string;
  organizationId: string;
  kind: FilingKind;
  siteId: string;
  inspectionId: string | null;
  contractId: string | null;
  signedDocumentId: string | null;
  contractDocumentId: string | null;
  status: FilingStatus;
  submissionMethod: SubmissionMethod | null;
  submissionNo: number;
  sendRequestedSubmission: number | null;
  rulesetId: string | null;
  jurisdictionId: string | null;
  nextDueOn: string | null;
};

const filingColumns = [
  "id",
  "organizationId",
  "kind",
  "siteId",
  "inspectionId",
  "contractId",
  "signedDocumentId",
  "contractDocumentId",
  "status",
  "submissionMethod",
  "submissionNo",
  "sendRequestedSubmission",
  "rulesetId",
  "jurisdictionId",
  "nextDueOn",
] as const;

export async function loadFiling(db: Executor, organizationId: string, filingId: string, forUpdate = false): Promise<FilingRow | null> {
  let q = db.selectFrom("filings").select(filingColumns).where("organizationId", "=", organizationId).where("id", "=", filingId);
  if (forUpdate) q = q.forUpdate();
  return (await q.executeTakeFirst()) ?? null;
}

interface EventInput {
  type: string;
  summary: string;
  details?: Record<string, unknown>;
}

async function recordEvent(trx: Executor, f: FilingRow, at: Date, actorUserId: string | null, e: EventInput) {
  await trx
    .insertInto("complianceEvents")
    .values({
      organizationId: f.organizationId,
      siteId: f.siteId,
      eventType: e.type,
      occurredAt: at,
      actorUserId,
      inspectionId: f.inspectionId,
      reportId: null,
      filingId: f.id,
      summary: e.summary,
      details: JSON.stringify(e.details ?? {}),
    })
    .execute();
}

const DELIVERY_PROBLEM_WORDS = {
  bounced: "bounced: the receiving mail server rejected it",
  complained: "was marked as spam by the recipient",
  failed: "could not be delivered",
  suppressed: "was not delivered: the mail provider holds this address on its suppression list",
} as const;

/**
 * The mail provider reported that a filing's email did not get through (or was marked as
 * spam). The filing keeps its status (the provider did accept it), but the site's ledger
 * says so and the inbox asks the office to file it another way. Not a filing email: no-op.
 */
export async function recordFilingDeliveryProblem(
  trx: Executor,
  e: { organizationId: string; idempotencyKey: string; recipient: string; status: keyof typeof DELIVERY_PROBLEM_WORDS; detail: string | null; at: Date },
) {
  const attempt = await trx
    .selectFrom("filingAttempts")
    .select(["filingId", "submissionNo"])
    .where("organizationId", "=", e.organizationId)
    .where("idempotencyKey", "=", e.idempotencyKey)
    .where("status", "=", "succeeded")
    .executeTakeFirst();
  if (!attempt) return;
  const f = await loadFiling(trx, e.organizationId, attempt.filingId);
  if (!f) return;
  const summary = `The filing email to ${e.recipient} (submission ${attempt.submissionNo}) ${DELIVERY_PROBLEM_WORDS[e.status]}${e.detail ? ` (${e.detail.slice(0, 300)})` : ""}`;
  await recordEvent(trx, f, e.at, null, { type: `filing_email_${e.status}`, summary, details: { submissionNo: attempt.submissionNo, recipient: e.recipient, detail: e.detail } });
}

/**
 * Moves a filing to a new status if the state machine allows it and nobody moved it
 * first, then records the step on the site's compliance ledger. Mutates `f.status`.
 */
async function move(
  trx: Transaction<DB>,
  f: FilingRow,
  to: FilingStatus,
  at: Date,
  set: Updateable<DB["filings"]>,
  event: EventInput | null,
  actorUserId: string | null = null,
) {
  if (!canTransitionFiling(f.status, to)) throw new FilingStateError(`A ${f.status.replace("_", " ")} filing cannot become ${to.replace("_", " ")}`);
  const late = to === "sent" ? await lateFeeOnFirstSend(trx, f, at) : null;
  if (late) {
    set = { ...set, lateFeeCents: late.cents };
    if (late.cents > 0 && event) event = { ...event, summary: `${event.summary} Sent after the ${late.deadlineOn} deadline: late fee ${dollars(late.cents)}.`, details: { ...event.details, lateFeeCents: late.cents } };
  }
  const res = await trx
    .updateTable("filings")
    .set({ ...set, status: to, updatedAt: at })
    .where("organizationId", "=", f.organizationId)
    .where("id", "=", f.id)
    .where("status", "=", f.status)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) !== 1) throw new FilingStateError("The filing changed while this was happening; reload and try again");
  f.status = to;
  if (event) await recordEvent(trx, f, at, actorUserId, event);
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The late fee a filing owes, decided the first time it reaches the authority (by email or
 * by hand) on the organization's date: its recorded late fee when that is after the
 * deadline, else 0. A resubmission after a rejection does not decide it again.
 */
async function lateFeeOnFirstSend(trx: Executor, f: FilingRow, at: Date) {
  const row = await trx
    .selectFrom("filings as f")
    .innerJoin("organizations as o", "o.id", "f.organizationId")
    .select(["f.deadlineOn", "f.lateFeeRuleCents", "f.lateFeeCents", "f.filingFeeCents", "o.timezone"])
    .where("f.organizationId", "=", f.organizationId)
    .where("f.id", "=", f.id)
    .executeTakeFirstOrThrow();
  if (row.lateFeeCents !== null || row.filingFeeCents === null) return null;
  return { cents: lateFeeOwed(row.lateFeeRuleCents, row.deadlineOn, dateInZone(at, row.timezone)), deadlineOn: row.deadlineOn };
}

/** The jurisdiction and exact ruleset version a filing recorded. */
async function recordedJurisdiction(db: Executor, f: FilingRow): Promise<ResolvedJurisdiction | null> {
  if (!f.rulesetId) return null;
  const row = await db
    .selectFrom("jurisdictionRulesets as r")
    .innerJoin("jurisdictions as j", "j.id", "r.jurisdictionId")
    .select(["r.id", "r.rules", "j.id as jurisdictionId", "j.key", "j.authorityName"])
    .where("r.id", "=", f.rulesetId)
    .executeTakeFirst();
  if (!row) return null;
  return { jurisdictionId: row.jurisdictionId, key: row.key, authorityName: row.authorityName, rulesetId: row.id, rules: row.rules as ResolvedJurisdiction["rules"], source: "county" };
}

/** The completed inspection in the shape adapters read. */
export async function loadCanonicalInspection(db: Executor, organizationId: string, inspectionId: string): Promise<CanonicalInspection> {
  const insp = await db
    .selectFrom("inspections as i")
    .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "i.siteId").onRef("s.organizationId", "=", "i.organizationId"))
    .innerJoin("inspectionTemplates as t", "t.id", "i.templateId")
    .innerJoin("memberships as m", (j) => j.onRef("m.userId", "=", "i.technicianUserId").onRef("m.organizationId", "=", "i.organizationId"))
    .select(["i.id", "i.siteId", "i.templateId", "i.validationStatus", "i.completedAt", "t.definition", "m.technicianLicense", "s.county", "s.state", "s.permitNumber", "s.customerType"])
    .where("i.organizationId", "=", organizationId)
    .where("i.id", "=", inspectionId)
    .executeTakeFirstOrThrow();
  if (!insp.completedAt) throw new Error(`inspection ${inspectionId} is not completed`);
  const [values, photos, report] = await Promise.all([
    db.selectFrom("inspectionValues").select(["fieldKey", "valueJson"]).where("organizationId", "=", organizationId).where("inspectionId", "=", inspectionId).execute(),
    db
      .selectFrom("attachments")
      .select(["photoKey", sql<number>`count(*)::int`.as("n")])
      .where("organizationId", "=", organizationId)
      .where("inspectionId", "=", inspectionId)
      .groupBy("photoKey")
      .execute(),
    latestAuthorityReport(db, organizationId, inspectionId),
  ]);
  return {
    organizationId,
    id: insp.id,
    site: { siteId: insp.siteId, county: insp.county, state: insp.state, permitNumber: insp.permitNumber, customerType: insp.customerType },
    templateId: insp.templateId,
    definition: insp.definition as TemplateDefinition,
    // Answers corrected on a later report version count over the originals.
    values: { ...Object.fromEntries(values.map((v) => [v.fieldKey, v.valueJson as InspectionValues[string]])), ...amendmentsOf(report?.snapshot) },
    photoCounts: Object.fromEntries(photos.map((p) => [p.photoKey, Number(p.n)])),
    technicianLicense: insp.technicianLicense,
    validationStatus: insp.validationStatus,
    completedAt: insp.completedAt,
  };
}

/**
 * What decides the site's interval on a date: whether the site is residential or commercial,
 * whether it had qualifying electronic monitoring, and any interval its own permit sets.
 */
async function siteServiceBasis(db: Executor, organizationId: string, siteId: string, onDate: string) {
  const [site, monitored] = await Promise.all([siteTypeAndPermit(db, organizationId, siteId), siteMonitoredOn(db, organizationId, siteId, onDate)]);
  return { customerType: site?.customerType ?? "residential", monitored, permitIntervalMonths: site?.permitIntervalMonths ?? null, useCategory: site?.useCategory ?? null };
}

/** The site's own type ("commercial" belongs to the property, not the plan) and permit interval. */
async function siteTypeAndPermit(db: Executor, organizationId: string, siteId: string) {
  return db.selectFrom("sites").select(["customerType", "permitIntervalMonths", "useCategory"]).where("organizationId", "=", organizationId).where("id", "=", siteId).executeTakeFirst();
}

/**
 * The hold reason for an inspection filing, with why the site's schedule isn't settled yet
 * (Montgomery food establishments): the next due date it carries is the general one until
 * the site's own interval is recorded.
 */
function withScheduleProblem(problem: string | null, resolved: ResolvedJurisdiction, basis: { useCategory: SiteUseCategory | null; permitIntervalMonths: number | null }) {
  const schedule = siteScheduleProblem(resolved.rules, resolved.authorityName, basis);
  if (!schedule) return problem;
  return problem ? `${problem} ${schedule}.` : `${schedule}.`;
}

/** Deadline, next due date and method for an inspection filing under a resolved jurisdiction. */
function termsFor(resolved: ResolvedJurisdiction, completedOn: string, basis: { customerType: "residential" | "commercial"; monitored: boolean; permitIntervalMonths: number | null; useCategory: SiteUseCategory | null }) {
  const r = resolved.rules;
  return {
    jurisdictionId: resolved.jurisdictionId,
    rulesetId: resolved.rulesetId,
    rulesetVersion: r.version,
    submissionMethod: r.submission.method,
    methodVersion: adapterVersion(resolved.key),
    deadlineOn: addDays(completedOn, r.filing.deadlineDays),
    deadlineBasis: `${r.filing.deadlineDays} days after the inspection on ${completedOn}`,
    warningDays: r.filing.warningDays,
    nextDueOn: addMonths(completedOn, serviceIntervalMonths(r, basis.customerType, basis.monitored, basis.permitIntervalMonths, basis.useCategory)),
    ...feeColumns(r, "inspection_report"),
  };
}

/**
 * Where an authority counts report due dates from the contract's start (Hays 10.V.2), a
 * contract visit's report is due by that visit's due date when that comes before the usual
 * deadline. An extra visit (a retest) keeps the usual deadline.
 */
async function contractVisitDeadline<T extends { deadlineOn: string; deadlineBasis: string }>(db: Executor, organizationId: string, inspectionId: string, resolved: ResolvedJurisdiction, terms: T): Promise<T> {
  const visit = await db
    .selectFrom("inspections as i")
    .innerJoin("jobs as j", (x) => x.onRef("j.id", "=", "i.jobId").onRef("j.organizationId", "=", "i.organizationId"))
    .innerJoin("serviceObligations as o", (x) => x.onRef("o.id", "=", "j.obligationId").onRef("o.organizationId", "=", "j.organizationId"))
    .select(["o.dueOn", "o.sequence"])
    .where("i.organizationId", "=", organizationId)
    .where("i.id", "=", inspectionId)
    .executeTakeFirst();
  if (!visit || visit.dueOn >= terms.deadlineOn) return terms;
  return {
    ...terms,
    deadlineOn: visit.dueOn,
    deadlineBasis:
      `${resolved.authorityName} counts report due dates from the contract's start: visit ${visit.sequence}'s test and report are due by ${visit.dueOn}` +
      (resolved.rules.service.contractVisits?.unconfirmed ? ` (${resolved.rules.service.contractVisits.unconfirmed})` : ""),
  };
}

/** The fee columns a filing records under a ruleset (all null when it sets no fee). */
function feeColumns(rules: ResolvedJurisdiction["rules"], kind: FilingKind) {
  const fees = filingFees(rules, kind);
  return { filingFeeCents: fees?.filingFeeCents ?? null, lateFeeRuleCents: fees?.lateFeeRuleCents ?? null, feeBasis: fees?.feeBasis ?? null };
}

const NO_ADAPTER = "There is no way to file with this authority yet.";
/** The review reason while a filing waits only for the maintenance provider's signature. */
export const AWAITING_SIGNATURE = "Waiting for a licensed maintenance provider to sign the authority report";
export const awaitingSignature = (version: number) => `${AWAITING_SIGNATURE} (version ${version}), as 30 TAC 285.7(b)(3) requires`;
const reportsUnknown = (resolved: ResolvedJurisdiction) =>
  resolved.rules.inspectionReports?.submission === "unknown" ? `${resolved.authorityName} has not published how inspection reports are submitted, so this report cannot be filed through Aerowise.` : null;

/**
 * Opens the filing for a just-completed inspection, in the completing transaction. It
 * resolves the site's authority as of the inspection date and records that exact
 * ruleset. The filing waits (`pending`) until the authority report exists.
 */
export async function openFiling(trx: Transaction<DB>, args: { organizationId: string; inspectionId: string; actorUserId: string | null; at: Date }) {
  const insp = await trx
    .selectFrom("inspections as i")
    .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "i.siteId").onRef("s.organizationId", "=", "i.organizationId"))
    .innerJoin("organizations as o", "o.id", "i.organizationId")
    .select(["i.id", "i.siteId", "i.templateId", "i.completedAt", "s.county", "s.state", "s.jurisdictionId", "o.timezone"])
    .where("i.organizationId", "=", args.organizationId)
    .where("i.id", "=", args.inspectionId)
    .executeTakeFirstOrThrow();
  const completedOn = dateInZone(insp.completedAt ?? args.at, insp.timezone);
  const resolution = explainSite(await loadCatalog(trx), insp, completedOn);
  const resolved = resolution.resolved;
  const basis = resolved ? await siteServiceBasis(trx, args.organizationId, insp.siteId, completedOn) : null;
  let terms = resolved && basis ? termsFor(resolved, completedOn, basis) : null;
  if (terms && resolved?.rules.service.contractVisits) terms = await contractVisitDeadline(trx, args.organizationId, insp.id, resolved, terms);
  const reviewReason = !resolved ? (resolution.reviewReason ?? NO_AUTHORITY) : !terms?.methodVersion ? NO_ADAPTER : withScheduleProblem(reportsUnknown(resolved), resolved, basis!);
  const inserted = await trx
    .insertInto("filings")
    .values({
      organizationId: args.organizationId,
      inspectionId: insp.id,
      siteId: insp.siteId,
      templateId: insp.templateId,
      status: reviewReason ? "needs_review" : "pending",
      stateMachineVersion: FILING_STATE_MACHINE.version,
      jurisdictionId: terms?.jurisdictionId ?? null,
      rulesetId: terms?.rulesetId ?? null,
      rulesetVersion: terms?.rulesetVersion ?? null,
      submissionMethod: terms?.submissionMethod ?? null,
      methodVersion: terms?.methodVersion ?? null,
      deadlineOn: terms?.deadlineOn ?? null,
      deadlineBasis: terms?.deadlineBasis ?? null,
      warningDays: terms?.warningDays ?? 0,
      nextDueOn: terms?.nextDueOn ?? null,
      filingFeeCents: terms?.filingFeeCents ?? null,
      lateFeeRuleCents: terms?.lateFeeRuleCents ?? null,
      feeBasis: terms?.feeBasis ?? null,
      reportId: null,
      sentAt: null,
      confirmedAt: null,
      confirmationReference: null,
      confirmationNote: null,
      confirmedBy: null,
      rejectionReason: null,
      reviewReason,
      lastError: null,
    })
    .onConflict((oc) => oc.columns(["organizationId", "inspectionId"]).doNothing())
    .returning(filingColumns)
    .executeTakeFirst();
  if (!inserted) return null;
  await recordEvent(
    trx,
    inserted,
    args.at,
    args.actorUserId,
    resolved && !reviewReason
      ? {
          type: "filing_opened",
          summary: `Filing with ${resolved.authorityName} opened; due ${terms!.deadlineOn}. Next inspection due by ${terms!.nextDueOn}`,
          details: { jurisdiction: resolved.key, rulesetVersion: resolved.rules.version, deadlineOn: terms!.deadlineOn, nextDueOn: terms!.nextDueOn },
        }
      : { type: "filing_needs_review", summary: `Filing needs review: ${reviewReason}` },
  );
  return inserted;
}

/** Queues an automatic submission, reusing a retry that is already waiting. */
async function queueSubmit(trx: Transaction<DB>, ctx: Pick<ComplianceContext, "enqueue">, f: FilingRow, at: Date) {
  const waiting = await trx
    .selectFrom("backgroundTasks")
    .select("id")
    .where("kind", "=", SUBMIT_FILING)
    .where("organizationId", "=", f.organizationId)
    .where(sql<boolean>`payload->>'filingId' = ${f.id}`)
    .where("completedAt", "is", null)
    .where("failedAt", "is", null)
    .executeTakeFirst();
  if (waiting) {
    await trx.updateTable("backgroundTasks").set({ runAt: at }).where("id", "=", waiting.id).execute();
    return;
  }
  await ctx.enqueue(trx, {
    kind: SUBMIT_FILING,
    organizationId: f.organizationId,
    payload: { filingId: f.id },
    dedupeKey: `${SUBMIT_FILING}:${f.id}:${f.submissionNo}:${at.getTime()}`,
    runAt: at,
  });
}

function makeAdapter(ctx: Pick<ComplianceContext, "db" | "store" | "mail" | "from">, resolved: ResolvedJurisdiction): JurisdictionAdapter | null {
  return adapterFor(resolved, { db: ctx.db, store: ctx.store, mail: ctx.mail, from: ctx.from });
}

/**
 * Opens the filing of a signed maintenance contract, when the site's authority requires
 * contracts on file. Contracts at sites whose authority is undecided, but where a
 * possible authority requires them, open in review. Safe to call again: one filing per
 * contract. Runs in the caller's transaction.
 */
export async function openContractFiling(trx: Executor, args: { organizationId: string; contractId: string; actorUserId: string | null; at: Date }) {
  const c = await trx
    .selectFrom("contracts as c")
    .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "c.siteId").onRef("s.organizationId", "=", "c.organizationId"))
    .innerJoin("organizations as o", "o.id", "c.organizationId")
    .leftJoin("contracts as p", (j) => j.onRef("p.id", "=", "c.previousContractId").onRef("p.organizationId", "=", "c.organizationId"))
    .select(["c.id", "c.siteId", "c.status", "c.signedDocumentId", "c.startOn", "c.endOn", "c.planName", "c.filingBasis", "c.filingBasisOn", "p.endOn as previousEndOn", "s.county", "s.state", "s.jurisdictionId", "o.timezone"])
    .where("c.organizationId", "=", args.organizationId)
    .where("c.id", "=", args.contractId)
    .executeTakeFirst();
  if (!c || c.status !== "active") return null;
  const exists = await trx.selectFrom("filings").select("id").where("organizationId", "=", args.organizationId).where("contractId", "=", c.id).executeTakeFirst();
  if (exists) return null;
  const today = dateInZone(args.at, c.timezone);
  const catalog = await loadCatalog(trx);
  const resolution = explainSite(catalog, c, today);
  const resolved = resolution.resolved;
  if (resolved && !contractFilingRequired(resolved.rules)) return null;
  if (!resolved) {
    // Undecided: open in review only if one of the possible authorities wants contracts.
    const wants = resolution.candidates.some((e) => {
      const rs = e.rulesets.find((r) => r.effectiveFrom <= today && (r.effectiveTo === null || today < r.effectiveTo));
      return rs ? contractFilingRequired(rs.rules) : false;
    });
    if (!wants) return null;
  }
  const document = c.signedDocumentId
    ? null
    : await trx.selectFrom("contractDocuments").select("id").where("organizationId", "=", args.organizationId).where("contractId", "=", c.id).orderBy("createdAt", "desc").executeTakeFirst();
  const deadline = resolved ? contractDeadline(resolved.rules, contractBasisOf(c)) : { deadlineOn: null, basis: null };
  const reviewReason = !resolved ? resolution.reviewReason : !c.signedDocumentId && !document ? NO_SIGNED_CONTRACT : null;
  const inserted = await trx
    .insertInto("filings")
    .values({
      organizationId: args.organizationId,
      kind: "contract",
      inspectionId: null,
      contractId: c.id,
      signedDocumentId: c.signedDocumentId,
      contractDocumentId: document?.id ?? null,
      siteId: c.siteId,
      templateId: null,
      status: reviewReason ? "needs_review" : "pending",
      stateMachineVersion: FILING_STATE_MACHINE.version,
      jurisdictionId: resolved?.jurisdictionId ?? null,
      rulesetId: resolved?.rulesetId ?? null,
      rulesetVersion: resolved?.rules.version ?? null,
      submissionMethod: resolved?.rules.submission.method ?? null,
      methodVersion: resolved ? adapterVersion(resolved.key) : null,
      deadlineOn: deadline.deadlineOn,
      deadlineBasis: deadline.basis,
      warningDays: resolved?.rules.filing.warningDays ?? 0,
      nextDueOn: null,
      ...(resolved ? feeColumns(resolved.rules, "contract") : {}),
      reportId: null,
      sentAt: null,
      confirmedAt: null,
      confirmationReference: null,
      confirmationNote: null,
      confirmedBy: null,
      rejectionReason: null,
      reviewReason,
      lastError: null,
    })
    .onConflict((oc) => oc.columns(["organizationId", "contractId"]).where("contractId", "is not", null).doNothing())
    .returning(filingColumns)
    .executeTakeFirst();
  if (!inserted) return null;
  await recordEvent(
    trx,
    inserted,
    args.at,
    args.actorUserId,
    resolved && !reviewReason
      ? {
          type: "filing_opened",
          summary: `Contract filing with ${resolved.authorityName} opened (${c.planName}, ${c.startOn} to ${c.endOn})${deadline.deadlineOn ? `; due ${deadline.deadlineOn}` : ""}`,
          details: { jurisdiction: resolved.key, contractId: c.id, deadlineOn: deadline.deadlineOn, deadlineBasis: deadline.basis },
        }
      : { type: "filing_needs_review", summary: `Contract filing needs review: ${reviewReason}` },
  );
  return inserted;
}

const NO_SIGNED_CONTRACT = "No signed copy of this contract is in Aerowise. Upload the signed contract on the site page, then check the filing again.";

/**
 * Opens contract filings for every active contract that needs one and has none. The
 * worker runs this regularly, so contracts made anywhere (renewals, imports, the office)
 * are picked up. Returns how many were opened.
 */
export async function syncContractFilings(ctx: Pick<ComplianceContext, "db" | "now">, organizationId: string) {
  const missing = await ctx.db
    .selectFrom("contracts as c")
    .leftJoin("filings as f", (j) => j.onRef("f.contractId", "=", "c.id").onRef("f.organizationId", "=", "c.organizationId"))
    .select("c.id")
    .where("c.organizationId", "=", organizationId)
    .where("c.status", "=", "active")
    .where("f.id", "is", null)
    .where("c.endOn", ">=", sql<string>`current_date`)
    .execute();
  let opened = 0;
  for (const m of missing) {
    const f = await ctx.db.transaction().execute((trx) => openContractFiling(trx, { organizationId, contractId: m.id, actorUserId: null, at: ctx.now() }));
    if (f) opened++;
  }
  return opened;
}

/** Why an inspection filing cannot go yet, from its answers and its complaint history. */
async function inspectionProblems(ctx: ComplianceContext, f: FilingRow, adapter: JurisdictionAdapter): Promise<string[]> {
  const insp = await loadCanonicalInspection(ctx.db, f.organizationId, f.inspectionId!);
  const problems = (await adapter.validate(insp)).problems;
  const responses = await responsesForInspection(ctx.db, f.organizationId, f.inspectionId!);
  if (responses.unreviewed.length) {
    problems.push(
      `${responses.unreviewed.length} service request${responses.unreviewed.length === 1 ? "" : "s"} at this site since the last report ${responses.unreviewed.length === 1 ? "has" : "have"} not been reviewed for reporting (owner complaint, monitoring notice or not reportable)`,
    );
  }
  // A reportable request without a response, or with a problem still outstanding, does not
  // hold the filing: the report says so, and the inbox escalates it.
  return problems;
}

/**
 * Checks a pending filing once its documents exist and moves it to ready, with its
 * submission package stored, or to needs_review with the reasons. Ready email filings
 * are queued straight away when the profile allows automatic submission. Safe to call
 * any number of times.
 */
export async function prepareFilingById(ctx: ComplianceContext, organizationId: string, filingId: string, actorUserId: string | null = null) {
  const f = await loadFiling(ctx.db, organizationId, filingId);
  if (!f || f.status !== "pending") return f;
  const resolved = await recordedJurisdiction(ctx.db, f);
  const adapter = resolved && makeAdapter(ctx, resolved);
  const at = ctx.now();
  if (!resolved || !adapter) {
    await ctx.db.transaction().execute((trx) => move(trx, f, "needs_review", at, { reviewReason: resolved ? NO_ADAPTER : NO_AUTHORITY }, null));
    return f;
  }
  const problems: string[] = [];
  if (f.kind === "inspection_report") {
    const report = await latestAuthorityReport(ctx.db, organizationId, f.inspectionId!);
    // The authority report is not made yet; the reports task calls again when it is.
    if (!report) return f;
    problems.push(...(await inspectionProblems(ctx, f, adapter)));
    // Complaint responses reviewed after the report was drawn: once nothing else holds the
    // filing, draw it again (a linked version) so what goes out has them.
    const responses = await currentAuthorityResponses(ctx.db, organizationId, f.inspectionId!);
    if (!problems.length && !sameResponses((report.snapshot as { responses?: typeof responses }).responses, responses)) {
      await writeReportVersion(ctx.db, ctx.store, {
        organizationId,
        inspectionId: f.inspectionId!,
        audience: "authority",
        reason: "Owner complaint and monitoring notice responses updated before filing",
        actorUserId,
        now: at,
      });
    }
  }
  problems.push(...(await packageProblems(ctx.db, f, resolved, at)));
  // Last, so it asks for a signature only on the version that will go out.
  if (f.kind === "inspection_report" && !problems.length && providerSignatureRequired(resolved.rules)) {
    const report = (await latestAuthorityReport(ctx.db, organizationId, f.inspectionId!))!;
    if (!(await reportSignature(ctx.db, organizationId, report.id))) problems.push(awaitingSignature(report.version));
  }
  if (problems.length) {
    const reason = problems.join("; ");
    await ctx.db
      .transaction()
      .execute((trx) => move(trx, f, "needs_review", at, { reviewReason: reason }, { type: "filing_needs_review", summary: `Filing needs review: ${reason}`, details: { problems } }, actorUserId));
    return f;
  }
  let pkg;
  try {
    pkg = await ensurePackage(ctx, f, resolved);
  } catch (err) {
    if (!(err instanceof PackageNotReady)) throw err;
    if (f.kind === "contract" && !f.signedDocumentId) {
      await ctx.db.transaction().execute((trx) => move(trx, f, "needs_review", at, { reviewReason: NO_SIGNED_CONTRACT }, { type: "filing_needs_review", summary: `Filing needs review: ${NO_SIGNED_CONTRACT}` }, actorUserId));
    }
    // Otherwise a document is still rendering; its task calls again.
    return f;
  }
  const reportId = pkg.documents.find((d) => d.role === "inspection_report")?.sourceId ?? null;
  await ctx.db.transaction().execute(async (trx) => {
    await move(
      trx,
      f,
      "ready",
      at,
      { reportId, reviewReason: null },
      { type: "filing_ready", summary: `${f.kind === "contract" ? "Contract" : "Authority report"} package ready to file with ${resolved.authorityName}`, details: { packageId: pkg.id, manifestSha256: pkg.manifestSha256 } },
      actorUserId,
    );
    // The CSV is made, not filed: the filing stays ready until someone uploads it and says so.
    const csv = pkg.documents.find((d) => d.role === "authority_csv");
    if (csv) {
      await recordEvent(trx, f, at, actorUserId, {
        type: "filing_exported",
        summary: `Authority CSV ${csv.filename} made for ${resolved.authorityName}. Not sent: upload it, then record the filing as filed.`,
        details: { packageId: pkg.id, filename: csv.filename, sha256: csv.sha256 },
      });
    }
    if (mayAutoSubmit(resolved.rules) && f.submissionMethod === "email") {
      await move(trx, f, "queued", at, {}, null);
      await queueSubmit(trx, ctx, f, at);
    }
  });
  return f;
}

/** `prepareFilingById` for the filing of a completed inspection. */
export async function prepareFiling(ctx: ComplianceContext, organizationId: string, inspectionId: string, actorUserId: string | null = null) {
  const found = await ctx.db.selectFrom("filings").select("id").where("organizationId", "=", organizationId).where("inspectionId", "=", inspectionId).executeTakeFirst();
  return found ? prepareFilingById(ctx, organizationId, found.id, actorUserId) : null;
}

/**
 * The package for this submission would send an authority report the maintenance provider
 * has not signed (30 TAC 285.7(b)(3)): no signature on its report version, or a package
 * made from the unsigned copy before the report was signed (a filing prepared before
 * signatures were required, or signed after it was ready).
 */
async function unsignedPackage(db: Executor, f: FilingRow, resolved: ResolvedJurisdiction) {
  if (f.kind !== "inspection_report" || !f.inspectionId || !providerSignatureRequired(resolved.rules)) return false;
  const pkg = await findPackage(db, f.organizationId, f.id, f.submissionNo);
  if (!pkg) {
    const report = await latestAuthorityReport(db, f.organizationId, f.inspectionId);
    return !report || !(await reportSignature(db, f.organizationId, report.id));
  }
  const doc = pkg.documents.find((d) => d.role === "inspection_report");
  if (!doc?.sourceId) return true;
  const signature = await reportSignature(db, f.organizationId, doc.sourceId);
  return !signature || signature.sha256 !== doc.sha256;
}

/**
 * Takes an unsent submission out of the way: the filing goes back to pending under the next
 * submission number, so it is prepared again with a new package. The old package stays on
 * record as never sent. Mutates `f`. Call `prepareFilingById` after committing.
 */
async function replaceUnsentSubmission(trx: Transaction<DB>, f: FilingRow, at: Date, actorUserId: string | null, summary: string) {
  // A send that was tried and not recorded as failed before it reached the transport may
  // have delivered the old package; say so instead of claiming it never went out.
  const tried = await trx.selectFrom("filingAttempts").select("id").where("filingId", "=", f.id).where("submissionNo", "=", f.submissionNo).where("status", "!=", "failed").executeTakeFirst();
  if (tried) summary += `. An earlier attempt of submission ${f.submissionNo} did not record a result, so it may have been delivered: check the sending log`;
  if (f.status === "submitting") await move(trx, f, "failed", at, { lastError: summary }, null);
  if (f.status === "queued" || f.status === "failed") await move(trx, f, "ready", at, {}, null);
  f.submissionNo += 1;
  await move(trx, f, "pending", at, { submissionNo: f.submissionNo, sendRequestedBy: null, sendRequestedSubmission: null }, { type: "filing_reprepared", summary }, actorUserId);
}

const unsignedSummary = (f: FilingRow) =>
  `Not sent: submission ${f.submissionNo} would have sent an authority report the maintenance provider has not signed (30 TAC 285.7(b)(3)); it is replaced by submission ${f.submissionNo + 1}`;

/**
 * Replaces every unsent inspection package that carries an unsigned authority report, so
 * nothing prepared before signatures were required (or before the report was signed) can
 * go out. Part of the filing sweep; safe to run any number of times.
 */
export async function replaceUnsignedPackages(ctx: ComplianceContext, organizationId: string) {
  const open = await ctx.db
    .selectFrom("filings")
    .select("id")
    .where("organizationId", "=", organizationId)
    .where("kind", "=", "inspection_report")
    .where("status", "in", ["ready", "queued", "failed"])
    .execute();
  let replaced = 0;
  for (const { id } of open) {
    const done = await ctx.db.transaction().execute(async (trx) => {
      const f = await loadFiling(trx, organizationId, id, true);
      if (!f || !["ready", "queued", "failed"].includes(f.status)) return false;
      const resolved = await recordedJurisdiction(trx, f);
      if (!resolved || !(await unsignedPackage(trx, f, resolved))) return false;
      await replaceUnsentSubmission(trx, f, ctx.now(), null, unsignedSummary(f));
      return true;
    });
    if (done) {
      replaced += 1;
      await prepareFilingById(ctx, organizationId, id);
    }
  }
  return replaced;
}

/**
 * The `filings.submit` task: sends one email filing. Idempotent end to end: a filing
 * already sent (or taken over by hand) is left alone, and every retry of the same
 * submission sends the same stored package under one idempotency key, so the transport
 * delivers it at most once even if an earlier try sent it but crashed before recording
 * that. A failure is recorded on the filing and rethrown so the queue retries with backoff.
 */
export async function submitFiling(ctx: ComplianceContext, organizationId: string, filingId: string) {
  const at = ctx.now();
  const claimed = await ctx.db.transaction().execute(async (trx) => {
    const f = await loadFiling(trx, organizationId, filingId, true);
    if (!f || f.submissionMethod !== "email" || !["queued", "failed", "submitting"].includes(f.status)) return null;
    // Draft requirements: only a submission a person asked for goes out (Send now or Retry
    // now; the queue's automatic retries of that same request are fine). Anything else that
    // got queued (a sweep, a recheck) goes back to Ready.
    const rules = await recordedJurisdiction(trx, f);
    if (rules && !mayAutoSubmit(rules.rules) && f.sendRequestedSubmission !== f.submissionNo) {
      if (f.status === "queued" || f.status === "failed") {
        await move(trx, f, "ready", at, {}, { type: "filing_held", summary: `Not sent: ${rules.authorityName}'s requirements are a draft, so a person has to press Send` });
      }
      return null;
    }
    // Last check before anything goes out: never an unsigned report (285.7(b)(3)).
    if (rules && (await unsignedPackage(trx, f, rules))) {
      await replaceUnsentSubmission(trx, f, at, null, unsignedSummary(f));
      return { held: true as const };
    }
    if (f.status !== "submitting") await move(trx, f, "submitting", at, {}, null);
    const last = await trx.selectFrom("filingAttempts").select(sql<number>`coalesce(max(attempt_no), 0)::int`.as("n")).where("filingId", "=", f.id).executeTakeFirstOrThrow();
    const attemptNo = Number(last.n) + 1;
    const idempotencyKey = `filing-${f.id}-submission-${f.submissionNo}`;
    const attempt = await trx
      .insertInto("filingAttempts")
      .values({ organizationId, filingId: f.id, attemptNo, submissionNo: f.submissionNo, method: "email", idempotencyKey, status: "started", startedAt: at, finishedAt: null, error: null })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { f, attemptId: attempt.id };
  });
  if (!claimed) return null;
  if ("held" in claimed) {
    await prepareFilingById(ctx, organizationId, filingId);
    return null;
  }
  const { f, attemptId } = claimed;

  let resolved: ResolvedJurisdiction | null = null;
  try {
    resolved = await recordedJurisdiction(ctx.db, f);
    const adapter = resolved && makeAdapter(ctx, resolved);
    if (!resolved || !adapter?.submit) throw new Error("No email adapter for this filing's authority");
    const stored = await ensurePackage(ctx, f, resolved);
    await ctx.db.updateTable("filingAttempts").set({ packageId: stored.id, recipient: stored.recipient }).where("id", "=", attemptId).execute();
    const result = await adapter.submit(
      {
        method: stored.method,
        destination: stored.recipient,
        portalUrl: resolved.rules.submission.portalUrl,
        subject: stored.subject,
        body: stored.body,
        artifacts: stored.documents.map((d) => ({ reportId: d.sourceId ?? "", storageKey: d.storageKey, filename: d.filename, contentType: d.contentType, sha256: d.sha256 })),
        idempotencyKey: `filing-${f.id}-submission-${f.submissionNo}`,
      },
      organizationId,
    );
    const done = ctx.now();
    const proof: FilingProof = { kind: "email_message_id", reference: result.reference, at: result.acceptedAt };
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("filingAttempts")
        .set({ status: "succeeded", finishedAt: done, response: JSON.stringify({ ...result.response, messageId: result.reference, to: stored.recipient, manifestSha256: stored.manifestSha256 }) })
        .where("id", "=", attemptId)
        .execute();
      await move(
        trx,
        f,
        "sent",
        done,
        { sentAt: done, proof: JSON.stringify(proof), lastError: null },
        {
          type: "filing_sent",
          summary: `Sent to ${resolved!.authorityName} by email (${stored.recipient}); the mail provider accepted it. ${resolved!.rules.confirmation.mode === "none_published" ? "This authority publishes no acknowledgment." : "Waiting for their confirmation."}`,
          details: { messageId: result.reference, to: stored.recipient, packageId: stored.id, manifestSha256: stored.manifestSha256, nextDueOn: f.nextDueOn },
        },
      );
    });
    return f;
  } catch (err) {
    const message = (err as Error).message || String(err);
    const done = ctx.now();
    await ctx.db.transaction().execute(async (trx) => {
      await trx.updateTable("filingAttempts").set({ status: "failed", finishedAt: done, error: message.slice(0, 2000) }).where("id", "=", attemptId).execute();
      // One ledger entry per failed submission, not one per automatic retry.
      const earlier = await trx
        .selectFrom("filingAttempts")
        .select("id")
        .where("filingId", "=", f.id)
        .where("submissionNo", "=", f.submissionNo)
        .where("status", "=", "failed")
        .where("id", "<>", attemptId)
        .executeTakeFirst();
      const current = await loadFiling(trx, organizationId, f.id, true);
      if (current?.status !== "submitting") return;
      await move(
        trx,
        current,
        "failed",
        done,
        { lastError: message.slice(0, 2000) },
        earlier ? null : { type: "filing_failed", summary: `Sending to ${resolved?.authorityName ?? "the authority"} failed: ${message.slice(0, 200)}. Retrying automatically.` },
      );
    });
    throw err;
  }
}

// Office actions. Each runs inside the caller's transaction so the API can audit it too.

interface ActionArgs {
  organizationId: string;
  filingId: string;
  actorUserId: string;
  at: Date;
}

async function authorityName(trx: Executor, f: FilingRow) {
  if (!f.jurisdictionId) return "the authority";
  const j = await trx.selectFrom("jurisdictions").select("authorityName").where("id", "=", f.jurisdictionId).executeTakeFirst();
  return j?.authorityName ?? "the authority";
}

/** Sends a ready email filing now (for rulesets that do not submit automatically). */
export async function submitNow(trx: Transaction<DB>, ctx: Pick<ComplianceContext, "enqueue">, f: FilingRow, a: ActionArgs) {
  if (f.status !== "ready" || f.submissionMethod !== "email") throw new FilingStateError("Only a ready email filing can be sent");
  await move(trx, f, "queued", a.at, { sendRequestedBy: a.actorUserId, sendRequestedSubmission: f.submissionNo }, null, a.actorUserId);
  f.sendRequestedSubmission = f.submissionNo;
  await queueSubmit(trx, ctx, f, a.at);
}

/** Retries a failed email filing now. The retry reuses the submission's idempotency key. */
export async function retryFiling(trx: Transaction<DB>, ctx: Pick<ComplianceContext, "enqueue">, f: FilingRow, a: ActionArgs) {
  if (f.status !== "failed") throw new FilingStateError("Only a failed filing can be retried");
  await move(trx, f, "queued", a.at, { sendRequestedBy: a.actorUserId, sendRequestedSubmission: f.submissionNo }, { type: "filing_retried", summary: "Sending retried by the office" }, a.actorUserId);
  f.sendRequestedSubmission = f.submissionNo;
  await queueSubmit(trx, ctx, f, a.at);
}

/** A new submission after the authority rejected the last one. */
export async function resubmitFiling(trx: Transaction<DB>, _ctx: Pick<ComplianceContext, "enqueue">, f: FilingRow, a: ActionArgs) {
  if (f.status !== "rejected") throw new FilingStateError("Only a rejected filing can be resubmitted");
  // A new submission with its own package, built from the latest report version and the
  // site's current identifiers once the filing is checked again (call prepareFilingById
  // after committing). The rejected submission's package stays as it was.
  f.submissionNo += 1;
  await move(
    trx,
    f,
    "pending",
    a.at,
    { submissionNo: f.submissionNo, sentAt: null, proof: null, lastError: null, reviewReason: null },
    { type: "filing_resubmitted", summary: `Filing resubmitted (submission ${f.submissionNo})` },
    a.actorUserId,
  );
}

/**
 * A corrected authority report after a rejection: a new report version linked to the one
 * the authority refused, with the reason (and any corrected answers) printed on it, then
 * a new submission. Earlier versions and packages are never changed.
 */
export async function correctFiling(
  ctx: ComplianceContext,
  f: FilingRow,
  a: ActionArgs & { reason: string; amendments: InspectionValues },
): Promise<{ reportId: string; version: number }> {
  if (f.status !== "rejected") throw new FilingStateError("Only a rejected filing can be corrected");
  if (f.kind !== "inspection_report" || !f.inspectionId) throw new FilingStateError("Contract filings are corrected by uploading the corrected signed contract");
  const report = await writeReportVersion(ctx.db, ctx.store, {
    organizationId: f.organizationId,
    inspectionId: f.inspectionId,
    audience: "authority",
    reason: a.reason,
    amendments: a.amendments,
    actorUserId: a.actorUserId,
    now: a.at,
  });
  return { reportId: report.id, version: report.version };
}

/** Switches a filing to the manual portal/export fallback. */
export async function useManualFiling(trx: Transaction<DB>, f: FilingRow, a: ActionArgs) {
  if (f.submissionMethod === "manual_export") throw new FilingStateError("This filing is already filed by hand");
  const resolved = await recordedJurisdiction(trx, f);
  if (resolved && resolved.rules.submission.fallback !== "manual_export") throw new FilingStateError("This authority does not accept filings by hand");
  const event = { type: "filing_switched_manual", summary: "Switched to filing by hand" };
  if (f.status === "ready") {
    await trx.updateTable("filings").set({ submissionMethod: "manual_export", updatedAt: a.at }).where("organizationId", "=", f.organizationId).where("id", "=", f.id).execute();
    f.submissionMethod = "manual_export";
    await recordEvent(trx, f, a.at, a.actorUserId, event);
    return;
  }
  if (f.status !== "failed") throw new FilingStateError("Only a ready or failed filing can be switched to filing by hand");
  await move(trx, f, "ready", a.at, { submissionMethod: "manual_export" }, event, a.actorUserId);
  f.submissionMethod = "manual_export";
}

/**
 * Files this one by uploading the authority's CSV instead (its rules must have a CSV layout
 * for this kind of filing). A package is never changed, so the CSV comes in a new
 * submission: the filing goes back to pending under the next submission number and is
 * prepared again; call `prepareFilingById` after committing. The old package stays on
 * record as never sent.
 */
export async function useCsvExport(trx: Transaction<DB>, f: FilingRow, a: ActionArgs) {
  if (f.submissionMethod === "csv_export") throw new FilingStateError("This filing is already filed by CSV export");
  const resolved = await recordedJurisdiction(trx, f);
  if (!resolved || !exportLayoutFor(resolved.rules, f.kind)) throw new FilingStateError("This authority's rules have no CSV layout for this filing");
  if (f.status !== "ready" && f.status !== "failed") throw new FilingStateError("Only a ready or failed filing can be switched to CSV export");
  await trx.updateTable("filings").set({ submissionMethod: "csv_export", updatedAt: a.at }).where("organizationId", "=", f.organizationId).where("id", "=", f.id).execute();
  f.submissionMethod = "csv_export";
  await replaceUnsentSubmission(trx, f, a.at, a.actorUserId, `Switched to filing by CSV export; submission ${f.submissionNo + 1} is prepared with the authority's CSV`);
}

/** Records that the office filed it by hand (portal, mail, counter) or uploaded its CSV, with any reference. */
export async function markFiledManually(trx: Transaction<DB>, f: FilingRow, a: ActionArgs & { reference: string | null; note: string | null; actorName: string }) {
  if (f.status !== "ready" || (f.submissionMethod !== "manual_export" && f.submissionMethod !== "csv_export")) {
    throw new FilingStateError("Only a ready filing that is filed by hand or by CSV export can be marked as sent");
  }
  const method = f.submissionMethod;
  const resolved = await recordedJurisdiction(trx, f);
  if (resolved && (await unsignedPackage(trx, f, resolved))) {
    throw new FilingStateError("This package has an authority report the maintenance provider has not signed (30 TAC 285.7(b)(3)). Check the filing again to get a signed package.");
  }
  const pkg = await findPackage(trx, f.organizationId, f.id, f.submissionNo);
  const last = await trx.selectFrom("filingAttempts").select(sql<number>`coalesce(max(attempt_no), 0)::int`.as("n")).where("filingId", "=", f.id).executeTakeFirstOrThrow();
  await trx
    .insertInto("filingAttempts")
    .values({
      organizationId: f.organizationId,
      filingId: f.id,
      attemptNo: Number(last.n) + 1,
      submissionNo: f.submissionNo,
      method,
      idempotencyKey: `filing-${f.id}-submission-${f.submissionNo}`,
      status: "succeeded",
      startedAt: a.at,
      finishedAt: a.at,
      response: JSON.stringify({ reference: a.reference, note: a.note, by: a.actorUserId, manifestSha256: pkg?.manifestSha256 ?? null }),
      error: null,
      packageId: pkg?.id ?? null,
      recipient: pkg?.recipient ?? null,
    })
    .execute();
  const proof: FilingProof = { kind: "manual_submission", reference: a.reference, at: a.at.toISOString(), note: a.note, by: a.actorName };
  const name = await authorityName(trx, f);
  await move(
    trx,
    f,
    "sent",
    a.at,
    { sentAt: a.at, proof: JSON.stringify(proof), lastError: null },
    {
      type: "filing_sent",
      summary: `${method === "csv_export" ? "CSV uploaded to" : "Filed by hand with"} ${name}${a.reference ? ` (reference ${a.reference})` : ""}, as recorded by ${a.actorName}`,
      details: { nextDueOn: f.nextDueOn, packageId: pkg?.id ?? null },
    },
    a.actorUserId,
  );
}

/** The authority acknowledged the filing. Only this makes a filing confirmed. */
export async function confirmFiling(
  trx: Transaction<DB>,
  f: FilingRow,
  a: ActionArgs & { reference: string; note: string | null; evidence?: { kind: string; receivedOn: string; from?: string | null } | null },
) {
  if (f.status !== "sent") throw new FilingStateError("Only a sent filing can be confirmed");
  const name = await authorityName(trx, f);
  const evidence = a.evidence ? { kind: a.evidence.kind, receivedOn: a.evidence.receivedOn, from: a.evidence.from ?? null } : null;
  await move(
    trx,
    f,
    "confirmed",
    a.at,
    { confirmedAt: a.at, confirmationReference: a.reference, confirmationNote: a.note, confirmedBy: a.actorUserId, confirmationEvidence: evidence ? JSON.stringify(evidence) : null },
    { type: "filing_confirmed", summary: `${name} acknowledged it (reference ${a.reference}${evidence ? `, ${evidence.kind.replaceAll("_", " ")} received ${evidence.receivedOn}` : ""})`, details: { reference: a.reference, evidence } },
    a.actorUserId,
  );
}

export async function rejectFiling(trx: Transaction<DB>, f: FilingRow, a: ActionArgs & { reason: string }) {
  if (f.status !== "sent") throw new FilingStateError("Only a sent filing can be marked rejected");
  const name = await authorityName(trx, f);
  await move(trx, f, "rejected", a.at, { rejectionReason: a.reason }, { type: "filing_rejected", summary: `${name} rejected the filing: ${a.reason}` }, a.actorUserId);
}

/**
 * Looks again at a filing that needs review, after the office fixed the cause (set the
 * site's authority, added an identifier, uploaded the signed contract). Re-resolves the
 * authority and puts the filing back to pending; call `prepareFilingById` after committing.
 */
export async function recheckFiling(trx: Transaction<DB>, f: FilingRow, a: ActionArgs) {
  if (f.status !== "needs_review") throw new FilingStateError("Only a filing that needs review can be checked again");
  const catalog = await loadCatalog(trx);
  if (f.kind === "contract") {
    const c = await trx
      .selectFrom("contracts as c")
      .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "c.siteId").onRef("s.organizationId", "=", "c.organizationId"))
      .innerJoin("organizations as o", "o.id", "c.organizationId")
      .leftJoin("contracts as p", (j) => j.onRef("p.id", "=", "c.previousContractId").onRef("p.organizationId", "=", "c.organizationId"))
      .select(["c.signedDocumentId", "c.filingBasis", "c.filingBasisOn", "p.endOn as previousEndOn", "s.county", "s.state", "s.jurisdictionId", "o.timezone"])
      .where("c.organizationId", "=", f.organizationId)
      .where("c.id", "=", f.contractId!)
      .executeTakeFirstOrThrow();
    const resolution = explainSite(catalog, c, dateInZone(a.at, c.timezone));
    const resolved = resolution.resolved;
    const document = c.signedDocumentId
      ? null
      : await trx.selectFrom("contractDocuments").select("id").where("organizationId", "=", f.organizationId).where("contractId", "=", f.contractId!).orderBy("createdAt", "desc").executeTakeFirst();
    const problem = !resolved
      ? (resolution.reviewReason ?? NO_AUTHORITY)
      : !contractFilingRequired(resolved.rules)
        ? `${resolved.authorityName} does not ask for contracts to be filed.`
        : !c.signedDocumentId && !document
          ? NO_SIGNED_CONTRACT
          : null;
    if (problem || !resolved) {
      await move(trx, f, "needs_review", a.at, { reviewReason: problem }, null, a.actorUserId);
      return;
    }
    const deadline = contractDeadline(resolved.rules, contractBasisOf(c));
    const set = {
      jurisdictionId: resolved.jurisdictionId,
      rulesetId: resolved.rulesetId,
      rulesetVersion: resolved.rules.version,
      submissionMethod: resolved.rules.submission.method,
      methodVersion: adapterVersion(resolved.key),
      deadlineOn: deadline.deadlineOn,
      deadlineBasis: deadline.basis,
      warningDays: resolved.rules.filing.warningDays,
      ...feeColumns(resolved.rules, "contract"),
      signedDocumentId: c.signedDocumentId,
      contractDocumentId: document?.id ?? null,
      reviewReason: null,
    };
    await move(trx, f, "pending", a.at, set, { type: "filing_rechecked", summary: `Contract filing checked again for ${resolved.authorityName}` }, a.actorUserId);
    Object.assign(f, { rulesetId: set.rulesetId, jurisdictionId: set.jurisdictionId, submissionMethod: set.submissionMethod, signedDocumentId: set.signedDocumentId, contractDocumentId: set.contractDocumentId });
    return;
  }
  const insp = await trx
    .selectFrom("inspections as i")
    .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "i.siteId").onRef("s.organizationId", "=", "i.organizationId"))
    .innerJoin("organizations as o", "o.id", "i.organizationId")
    .select(["i.completedAt", "i.siteId", "s.county", "s.state", "s.jurisdictionId", "o.timezone"])
    .where("i.organizationId", "=", f.organizationId)
    .where("i.id", "=", f.inspectionId!)
    .executeTakeFirstOrThrow();
  const completedOn = dateInZone(insp.completedAt!, insp.timezone);
  const resolution = explainSite(catalog, insp, completedOn);
  const resolved = resolution.resolved;
  const basis = await siteServiceBasis(trx, f.organizationId, insp.siteId, completedOn);
  const problem = !resolved ? (resolution.reviewReason ?? NO_AUTHORITY) : !adapterVersion(resolved.key) ? NO_ADAPTER : withScheduleProblem(reportsUnknown(resolved), resolved, basis);
  if (problem || !resolved) {
    await move(trx, f, "needs_review", a.at, { reviewReason: problem }, null, a.actorUserId);
    return;
  }
  let terms = termsFor(resolved, completedOn, basis);
  if (resolved.rules.service.contractVisits) terms = await contractVisitDeadline(trx, f.organizationId, f.inspectionId!, resolved, terms);
  await move(trx, f, "pending", a.at, { ...terms, reviewReason: null }, { type: "filing_rechecked", summary: `Filing checked again for ${resolved.authorityName}` }, a.actorUserId);
  f.rulesetId = terms.rulesetId;
  f.jurisdictionId = terms.jurisdictionId;
  f.submissionMethod = terms.submissionMethod;
  f.nextDueOn = terms.nextDueOn;
}

/**
 * Checks a filing again after something it was waiting on changed (a signed contract
 * uploaded, a complaint response recorded): a filing held in review is re-evaluated, and a
 * pending one is prepared. Filings past that point are left alone.
 */
export async function refreshFiling(ctx: ComplianceContext, organizationId: string, filingId: string, actorUserId: string) {
  const at = ctx.now();
  await ctx.db.transaction().execute(async (trx) => {
    const f = await loadFiling(trx, organizationId, filingId, true);
    if (f?.status === "needs_review") await recheckFiling(trx, f, { organizationId, filingId, actorUserId, at });
    // Ready but not sent, and the complaint responses changed since its package was made:
    // that package must not go out. It stays on record as never sent; a new submission
    // gets a redrawn report and its own package.
    if (f && ["ready", "queued", "failed"].includes(f.status) && f.kind === "inspection_report" && f.inspectionId) {
      const report = await latestAuthorityReport(trx, organizationId, f.inspectionId);
      const responses = await currentAuthorityResponses(trx, organizationId, f.inspectionId);
      const resolved = await recordedJurisdiction(trx, f);
      if (report && !sameResponses((report.snapshot as { responses?: typeof responses }).responses, responses)) {
        await replaceUnsentSubmission(
          trx,
          f,
          at,
          actorUserId,
          `Complaint responses changed before sending; submission ${f.submissionNo} was not sent and is replaced by submission ${f.submissionNo + 1}`,
        );
      } else if (resolved && (await unsignedPackage(trx, f, resolved))) {
        // Signed after its package was made from the unsigned copy, or prepared before
        // signatures were required: that package must not go out.
        await replaceUnsentSubmission(trx, f, at, actorUserId, unsignedSummary(f));
      }
    }
  });
  return prepareFilingById(ctx, organizationId, filingId, actorUserId);
}

/**
 * Works out a contract filing's deadline again after its 285.7 basis was recorded. Only a
 * filing that has not gone out changes; one already sent keeps the deadline it was sent
 * against. Runs in the caller's transaction.
 */
export async function updateContractFilingDeadline(trx: Transaction<DB>, args: { organizationId: string; contractId: string; actorUserId: string | null; at: Date }) {
  const filing = await trx.selectFrom("filings").select("id").where("organizationId", "=", args.organizationId).where("contractId", "=", args.contractId).executeTakeFirst();
  if (!filing) return null;
  const f = (await loadFiling(trx, args.organizationId, filing.id, true))!;
  if (!["pending", "needs_review", "ready", "queued", "failed"].includes(f.status)) return f;
  const resolved = await recordedJurisdiction(trx, f);
  if (!resolved) return f;
  const c = await trx
    .selectFrom("contracts as c")
    .leftJoin("contracts as p", (j) => j.onRef("p.id", "=", "c.previousContractId").onRef("p.organizationId", "=", "c.organizationId"))
    .select(["c.filingBasis", "c.filingBasisOn", "p.endOn as previousEndOn"])
    .where("c.organizationId", "=", args.organizationId)
    .where("c.id", "=", args.contractId)
    .executeTakeFirstOrThrow();
  const deadline = contractDeadline(resolved.rules, contractBasisOf(c));
  const current = await trx.selectFrom("filings").select(["deadlineOn", "deadlineBasis"]).where("organizationId", "=", args.organizationId).where("id", "=", f.id).executeTakeFirstOrThrow();
  if (deadline.deadlineOn === current.deadlineOn && deadline.basis === current.deadlineBasis) return f;
  await trx.updateTable("filings").set({ deadlineOn: deadline.deadlineOn, deadlineBasis: deadline.basis, updatedAt: args.at }).where("organizationId", "=", args.organizationId).where("id", "=", f.id).execute();
  await recordEvent(trx, f, args.at, args.actorUserId, {
    type: "filing_deadline_changed",
    summary: deadline.deadlineOn ? `Contract filing due ${deadline.deadlineOn}: ${deadline.basis}` : `Contract filing has no deadline: ${deadline.basis}`,
    details: { deadlineOn: deadline.deadlineOn, previousDeadlineOn: current.deadlineOn },
  });
  return f;
}
