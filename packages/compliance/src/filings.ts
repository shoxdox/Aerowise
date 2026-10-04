import type { Database, DB } from "@aerowise/db";
import {
  addDays,
  addMonths,
  canTransitionFiling,
  FILING_STATE_MACHINE,
  type FilingProof,
  type FilingStatus,
  type InspectionValues,
  type SubmissionMethod,
  type TemplateDefinition,
} from "@aerowise/domain";
import type { ObjectStore } from "@aerowise/storage";
import { sql, type Transaction, type Updateable } from "kysely";
import { adapterFor, adapterVersion, type CanonicalInspection, type JurisdictionAdapter } from "./adapter.ts";
import type { EmailTransport } from "./email.ts";
import { dateInZone, loadCatalog, resolveSite, type ResolvedJurisdiction } from "./rulesets.ts";

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
  siteId: string;
  inspectionId: string;
  status: FilingStatus;
  submissionMethod: SubmissionMethod | null;
  submissionNo: number;
  rulesetId: string | null;
  jurisdictionId: string | null;
  nextDueOn: string | null;
};

const filingColumns = ["id", "organizationId", "siteId", "inspectionId", "status", "submissionMethod", "submissionNo", "rulesetId", "jurisdictionId", "nextDueOn"] as const;

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
    .select(["i.id", "i.siteId", "i.templateId", "i.validationStatus", "i.completedAt", "t.definition", "m.technicianLicense", "s.county", "s.state", "s.permitNumber"])
    .where("i.organizationId", "=", organizationId)
    .where("i.id", "=", inspectionId)
    .executeTakeFirstOrThrow();
  if (!insp.completedAt) throw new Error(`inspection ${inspectionId} is not completed`);
  const [values, photos] = await Promise.all([
    db.selectFrom("inspectionValues").select(["fieldKey", "valueJson"]).where("organizationId", "=", organizationId).where("inspectionId", "=", inspectionId).execute(),
    db
      .selectFrom("attachments")
      .select(["photoKey", sql<number>`count(*)::int`.as("n")])
      .where("organizationId", "=", organizationId)
      .where("inspectionId", "=", inspectionId)
      .groupBy("photoKey")
      .execute(),
  ]);
  return {
    organizationId,
    id: insp.id,
    site: { siteId: insp.siteId, county: insp.county, state: insp.state, permitNumber: insp.permitNumber },
    templateId: insp.templateId,
    definition: insp.definition as TemplateDefinition,
    values: Object.fromEntries(values.map((v) => [v.fieldKey, v.valueJson as InspectionValues[string]])),
    photoCounts: Object.fromEntries(photos.map((p) => [p.photoKey, Number(p.n)])),
    technicianLicense: insp.technicianLicense,
    validationStatus: insp.validationStatus,
    completedAt: insp.completedAt,
  };
}

/** Deadline, next due date and method for a filing under a resolved jurisdiction. */
function termsFor(resolved: ResolvedJurisdiction, completedOn: string) {
  const r = resolved.rules;
  return {
    jurisdictionId: resolved.jurisdictionId,
    rulesetId: resolved.rulesetId,
    rulesetVersion: r.version,
    submissionMethod: r.submission.method,
    methodVersion: adapterVersion(resolved.key),
    deadlineOn: addDays(completedOn, r.filing.deadlineDays),
    warningDays: r.filing.warningDays,
    nextDueOn: addMonths(completedOn, r.service.intervalMonths),
  };
}

const NO_AUTHORITY = "No reporting authority matches this site. Set the site's county, or choose its authority on the site page.";
const NO_ADAPTER = "There is no way to file with this authority yet.";

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
  const resolved = resolveSite(await loadCatalog(trx), insp, completedOn);
  const terms = resolved ? termsFor(resolved, completedOn) : null;
  const reviewReason = !resolved ? NO_AUTHORITY : !terms?.methodVersion ? NO_ADAPTER : null;
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
      warningDays: terms?.warningDays ?? 0,
      nextDueOn: terms?.nextDueOn ?? null,
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
 * Checks a pending filing once its authority report exists and moves it to ready, or to
 * needs_review with the reasons. Ready email filings are queued straight away when the
 * ruleset says so. Safe to call any number of times.
 */
export async function prepareFiling(ctx: ComplianceContext, organizationId: string, inspectionId: string, actorUserId: string | null = null) {
  const found = await ctx.db.selectFrom("filings").select("id").where("organizationId", "=", organizationId).where("inspectionId", "=", inspectionId).executeTakeFirst();
  if (!found) return null;
  const f = await loadFiling(ctx.db, organizationId, found.id);
  if (!f || f.status !== "pending") return f;
  const resolved = await recordedJurisdiction(ctx.db, f);
  const adapter = resolved && makeAdapter(ctx, resolved);
  const at = ctx.now();
  if (!resolved || !adapter) {
    await ctx.db.transaction().execute((trx) => move(trx, f, "needs_review", at, { reviewReason: resolved ? NO_ADAPTER : NO_AUTHORITY }, null));
    return f;
  }
  const insp = await loadCanonicalInspection(ctx.db, organizationId, inspectionId);
  const artifacts = await adapter.render(insp);
  // The authority report is not made yet; the reports task calls again when it is.
  if (artifacts.length === 0) return f;
  const check = await adapter.validate(insp);
  await ctx.db.transaction().execute(async (trx) => {
    if (!check.ok) {
      const reason = check.problems.join("; ");
      await move(trx, f, "needs_review", at, { reviewReason: reason }, { type: "filing_needs_review", summary: `Filing needs review: ${reason}`, details: { problems: check.problems } }, actorUserId);
      return;
    }
    await move(
      trx,
      f,
      "ready",
      at,
      { reportId: artifacts[0]!.reportId, reviewReason: null },
      { type: "filing_ready", summary: `Authority report ready to file with ${resolved.authorityName}` },
      actorUserId,
    );
    if (resolved.rules.filing.autoSubmit && f.submissionMethod === "email") {
      await move(trx, f, "queued", at, {}, null);
      await queueSubmit(trx, ctx, f, at);
    }
  });
  return f;
}

/**
 * The `filings.submit` task: sends one email filing. Idempotent end to end: a filing
 * already sent (or taken over by hand) is left alone, and every retry of the same
 * submission reuses one idempotency key, so the transport delivers it at most once even
 * if an earlier try sent it but crashed before recording that. A failure is recorded on
 * the filing and rethrown so the queue retries with backoff.
 */
export async function submitFiling(ctx: ComplianceContext, organizationId: string, filingId: string) {
  const at = ctx.now();
  const claimed = await ctx.db.transaction().execute(async (trx) => {
    const f = await loadFiling(trx, organizationId, filingId, true);
    if (!f || f.submissionMethod !== "email" || !["queued", "failed", "submitting"].includes(f.status)) return null;
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
  const { f, attemptId } = claimed;

  let resolved: ResolvedJurisdiction | null = null;
  try {
    resolved = await recordedJurisdiction(ctx.db, f);
    const adapter = resolved && makeAdapter(ctx, resolved);
    if (!resolved || !adapter?.submit) throw new Error("No email adapter for this filing's authority");
    const insp = await loadCanonicalInspection(ctx.db, organizationId, f.inspectionId);
    const artifacts = await adapter.render(insp);
    if (artifacts.length === 0) throw new Error("The authority report is missing");
    const pkg = await adapter.buildSubmission(insp, artifacts, { filingId: f.id, submissionNo: f.submissionNo });
    const result = await adapter.submit(pkg, organizationId);
    const done = ctx.now();
    const proof: FilingProof = { kind: "email_message_id", reference: result.reference, at: result.acceptedAt };
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("filingAttempts")
        .set({ status: "succeeded", finishedAt: done, response: JSON.stringify({ ...result.response, messageId: result.reference, to: pkg.destination }) })
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
          summary: `Sent to ${resolved!.authorityName} by email; waiting for their confirmation`,
          details: { messageId: result.reference, to: pkg.destination, nextDueOn: f.nextDueOn },
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
  await move(trx, f, "queued", a.at, {}, null, a.actorUserId);
  await queueSubmit(trx, ctx, f, a.at);
}

/** Retries a failed email filing now. The retry reuses the submission's idempotency key. */
export async function retryFiling(trx: Transaction<DB>, ctx: Pick<ComplianceContext, "enqueue">, f: FilingRow, a: ActionArgs) {
  if (f.status !== "failed") throw new FilingStateError("Only a failed filing can be retried");
  await move(trx, f, "queued", a.at, {}, { type: "filing_retried", summary: "Sending retried by the office" }, a.actorUserId);
  await queueSubmit(trx, ctx, f, a.at);
}

/** A new submission after the authority rejected the last one. */
export async function resubmitFiling(trx: Transaction<DB>, ctx: Pick<ComplianceContext, "enqueue">, f: FilingRow, a: ActionArgs) {
  if (f.status !== "rejected") throw new FilingStateError("Only a rejected filing can be resubmitted");
  f.submissionNo += 1;
  const set = { submissionNo: f.submissionNo, sentAt: null, proof: null, lastError: null };
  if (f.submissionMethod === "email") {
    await move(trx, f, "queued", a.at, set, { type: "filing_resubmitted", summary: "Filing resubmitted" }, a.actorUserId);
    await queueSubmit(trx, ctx, f, a.at);
  } else {
    await move(trx, f, "ready", a.at, set, { type: "filing_resubmitted", summary: "Filing reopened to file again by hand" }, a.actorUserId);
  }
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

/** Records that the office filed it by hand (portal, mail, counter), with any reference. */
export async function markFiledManually(trx: Transaction<DB>, f: FilingRow, a: ActionArgs & { reference: string | null; note: string | null; actorName: string }) {
  if (f.status !== "ready" || f.submissionMethod !== "manual_export") throw new FilingStateError("Only a ready filing that is filed by hand can be marked as sent");
  const last = await trx.selectFrom("filingAttempts").select(sql<number>`coalesce(max(attempt_no), 0)::int`.as("n")).where("filingId", "=", f.id).executeTakeFirstOrThrow();
  await trx
    .insertInto("filingAttempts")
    .values({
      organizationId: f.organizationId,
      filingId: f.id,
      attemptNo: Number(last.n) + 1,
      submissionNo: f.submissionNo,
      method: "manual_export",
      idempotencyKey: `filing-${f.id}-submission-${f.submissionNo}`,
      status: "succeeded",
      startedAt: a.at,
      finishedAt: a.at,
      response: JSON.stringify({ reference: a.reference, note: a.note, by: a.actorUserId }),
      error: null,
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
    { type: "filing_sent", summary: `Filed by hand with ${name}${a.reference ? ` (portal reference ${a.reference})` : ""}; waiting for their confirmation`, details: { nextDueOn: f.nextDueOn } },
    a.actorUserId,
  );
}

/** The authority acknowledged the filing. Only this makes a filing confirmed. */
export async function confirmFiling(trx: Transaction<DB>, f: FilingRow, a: ActionArgs & { reference: string; note: string | null }) {
  if (f.status !== "sent") throw new FilingStateError("Only a sent filing can be confirmed");
  const name = await authorityName(trx, f);
  await move(
    trx,
    f,
    "confirmed",
    a.at,
    { confirmedAt: a.at, confirmationReference: a.reference, confirmationNote: a.note, confirmedBy: a.actorUserId },
    { type: "filing_confirmed", summary: `${name} confirmed receipt (reference ${a.reference})`, details: { reference: a.reference } },
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
 * site's authority, for example). Re-resolves the authority as of the inspection date
 * and puts the filing back to pending; call `prepareFiling` after committing.
 */
export async function recheckFiling(trx: Transaction<DB>, f: FilingRow, a: ActionArgs) {
  if (f.status !== "needs_review") throw new FilingStateError("Only a filing that needs review can be checked again");
  const insp = await trx
    .selectFrom("inspections as i")
    .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "i.siteId").onRef("s.organizationId", "=", "i.organizationId"))
    .innerJoin("organizations as o", "o.id", "i.organizationId")
    .select(["i.completedAt", "s.county", "s.state", "s.jurisdictionId", "o.timezone"])
    .where("i.organizationId", "=", f.organizationId)
    .where("i.id", "=", f.inspectionId)
    .executeTakeFirstOrThrow();
  const completedOn = dateInZone(insp.completedAt!, insp.timezone);
  const resolved = resolveSite(await loadCatalog(trx), insp, completedOn);
  if (!resolved || !adapterVersion(resolved.key)) {
    await move(trx, f, "needs_review", a.at, { reviewReason: resolved ? NO_ADAPTER : NO_AUTHORITY }, null, a.actorUserId);
    return;
  }
  const terms = termsFor(resolved, completedOn);
  await move(trx, f, "pending", a.at, { ...terms, reviewReason: null }, { type: "filing_rechecked", summary: `Filing checked again for ${resolved.authorityName}` }, a.actorUserId);
  f.rulesetId = terms.rulesetId;
  f.jurisdictionId = terms.jurisdictionId;
  f.submissionMethod = terms.submissionMethod;
  f.nextDueOn = terms.nextDueOn;
}
