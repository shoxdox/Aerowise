import type { DB } from "@aerowise/db";
import {
  canTransitionEstimate,
  canonicalJson,
  estimateLabel,
  estimateLineAmount,
  estimateTotals,
  selectedLines,
  WORK_ORDER_STATE_MACHINE,
  workOrderLabel,
  type EstimateAcceptanceKind,
  type EstimateLine,
  type EstimateStatus,
} from "@aerowise/domain";
import { sha256Hex, systemAudit } from "@aerowise/renewals";
import { sql, type Kysely, type Transaction, type Updateable } from "kysely";
import { HttpError, notFound, unprocessable } from "./errors.ts";
import { nextWorkOrderNumber, workOrderEvent } from "./work-orders.ts";

// Estimate lifecycle helpers shared by the office routes and the homeowner's link. Every
// change runs in the caller's transaction with the estimate row locked.

type Trx = Transaction<DB>;

export const estimatesOff = () => new HttpError(409, "feature_off", "Estimates are not switched on for this deployment");

export const ESTIMATE_COLUMNS = [
  "id",
  "organizationId",
  "number",
  "customerId",
  "siteId",
  "workTypeId",
  "title",
  "status",
  "currentVersion",
  "taxRateBps",
  "discountCents",
  "termsText",
  "expiresOn",
  "sourceKind",
  "sourceId",
  "sentAt",
  "acceptedVersion",
  "workOrderId",
] as const;

export async function lockEstimate(trx: Trx, organizationId: string, estimateId: string) {
  const e = await trx.selectFrom("estimates").select(ESTIMATE_COLUMNS).where("organizationId", "=", organizationId).where("id", "=", estimateId).forUpdate().executeTakeFirst();
  if (!e) throw notFound("Estimate");
  return e;
}
export type LockedEstimate = Awaited<ReturnType<typeof lockEstimate>>;

/** Appends to the estimate's timeline. */
export async function estimateEvent(trx: Trx, e: { organizationId: string; estimateId: string; eventType: string; summary: string; actorUserId: string | null; details?: Record<string, unknown>; at: Date }) {
  await trx
    .insertInto("estimateEvents")
    .values({ organizationId: e.organizationId, estimateId: e.estimateId, eventType: e.eventType, summary: e.summary, actorUserId: e.actorUserId, details: JSON.stringify(e.details ?? {}), occurredAt: e.at })
    .execute();
}

export async function setEstimateStatus(trx: Trx, e: { id: string; status: EstimateStatus }, to: EstimateStatus, at: Date, extra: Updateable<DB["estimates"]> = {}) {
  if (!canTransitionEstimate(e.status, to)) {
    throw new HttpError(409, "invalid_transition", `A ${e.status} estimate cannot become ${to}`);
  }
  await trx
    .updateTable("estimates")
    .set({ status: to, updatedAt: at, ...extra })
    .where("id", "=", e.id)
    .execute();
}

/** The next gapless number for the company (a rolled-back insert gives its number back). */
export async function nextEstimateNumber(trx: Trx, organizationId: string) {
  const r = await trx
    .updateTable("organizations")
    .set((eb) => ({ nextEstimateNumber: eb("nextEstimateNumber", "+", 1) }))
    .where("id", "=", organizationId)
    .returning("nextEstimateNumber")
    .executeTakeFirstOrThrow();
  return r.nextEstimateNumber - 1;
}

/** The draft's lines as the homeowner would see them. */
export async function draftLines(ex: Kysely<DB>, organizationId: string, estimateId: string): Promise<EstimateLine[]> {
  const rows = await ex
    .selectFrom("estimateLines")
    .select(["id", "description", "quantityMilli", "unitPriceCents", "taxable", "optional", "selectedByDefault"])
    .where("organizationId", "=", organizationId)
    .where("estimateId", "=", estimateId)
    .orderBy("position")
    .execute();
  return rows.map((l) => ({ ...l, selectedByDefault: l.optional ? l.selectedByDefault : true, amountCents: estimateLineAmount(l) }));
}

/**
 * Freezes the draft as version `currentVersion`: its lines, rate, discount, terms and expiry,
 * with their totals and hash. A version is written once; sending again only resends it.
 */
export async function freezeVersion(trx: Trx, e: LockedEstimate, at: Date, sentBy: string | null) {
  const existing = await trx.selectFrom("estimateVersions").select(["version"]).where("estimateId", "=", e.id).where("version", "=", e.currentVersion).executeTakeFirst();
  if (existing) return;
  const lines = await draftLines(trx, e.organizationId, e.id);
  if (!lines.length) throw unprocessable("Add at least one line before sending the estimate");
  const totals = estimateTotals(lines, e.discountCents, e.taxRateBps);
  const snapshot = { estimate: estimateLabel(e.number), version: e.currentVersion, title: e.title, lines, taxRateBps: e.taxRateBps, discountCents: e.discountCents, totals, termsText: e.termsText, expiresOn: e.expiresOn };
  await trx
    .insertInto("estimateVersions")
    .values({
      organizationId: e.organizationId,
      estimateId: e.id,
      version: e.currentVersion,
      lines: JSON.stringify(lines),
      taxRateBps: e.taxRateBps,
      discountCents: e.discountCents,
      totals: JSON.stringify(totals),
      termsText: e.termsText,
      expiresOn: e.expiresOn,
      contentSha256: sha256Hex(canonicalJson(snapshot)),
      sentAt: at,
      sentBy,
    })
    .execute();
}

export async function versionOf(trx: Trx, estimateId: string, version: number) {
  const v = await trx.selectFrom("estimateVersions").selectAll().where("estimateId", "=", estimateId).where("version", "=", version).executeTakeFirst();
  if (!v) return null;
  return { ...v, lines: v.lines as EstimateLine[], totals: v.totals as ReturnType<typeof estimateTotals> };
}

/** The selection checked against the version: only its optional lines can be chosen. */
export function checkSelection(lines: readonly EstimateLine[], selected: readonly string[]) {
  const optional = new Set(lines.filter((l) => l.optional).map((l) => l.id));
  const chosen = [...new Set(selected)];
  if (chosen.some((id) => !optional.has(id))) throw unprocessable("A chosen option is not on this estimate. Reload the page.");
  return chosen;
}

async function workTypeFor(trx: Trx, organizationId: string, workTypeId: string | null) {
  if (workTypeId) {
    const t = await trx.selectFrom("workTypes").select(["id", "name", "category"]).where("organizationId", "=", organizationId).where("id", "=", workTypeId).where("active", "=", true).executeTakeFirst();
    if (t) return t;
  }
  // The company's repair kind, else the first one switched on.
  const t =
    (await trx.selectFrom("workTypes").select(["id", "name", "category"]).where("organizationId", "=", organizationId).where("key", "=", "repair").where("active", "=", true).executeTakeFirst()) ??
    (await trx.selectFrom("workTypes").select(["id", "name", "category"]).where("organizationId", "=", organizationId).where("active", "=", true).orderBy("position").limit(1).executeTakeFirst());
  if (!t) throw unprocessable("No kind of work is switched on; switch one on under Settings first");
  return t;
}

/**
 * Accepts version `version` with the chosen options and, in the same transaction, creates
 * its work order with the accepted lines. The estimate row is locked by the caller; the
 * unique work order source index makes a second conversion impossible even so.
 */
export async function acceptAndConvert(
  trx: Trx,
  e: LockedEstimate,
  a: { version: number; selectedOptionalLineIds: string[]; kind: EstimateAcceptanceKind; documentId: string | null; evidence: string | null; actorUserId: string | null; requestId: string | null; at: Date; by: string },
) {
  const v = await versionOf(trx, e.id, a.version);
  if (!v) throw unprocessable("That version of the estimate was never sent");
  const chosen = checkSelection(v.lines, a.selectedOptionalLineIds);
  const totals = estimateTotals(v.lines, v.discountCents, v.taxRateBps, chosen);
  const lines = selectedLines(v.lines, chosen);
  const type = await workTypeFor(trx, e.organizationId, e.workTypeId);

  const number = await nextWorkOrderNumber(trx, e.organizationId);
  const wo = await trx
    .insertInto("workOrders")
    .values({
      organizationId: e.organizationId,
      number,
      customerId: e.customerId,
      siteId: e.siteId,
      workTypeId: type.id,
      category: type.category,
      title: e.title,
      description: `From ${estimateLabel(e.number)}, version ${a.version}, accepted ${a.kind === "signature" ? "by the customer" : "as recorded by the office"}.`,
      priority: "normal",
      status: "open",
      stateMachineVersion: WORK_ORDER_STATE_MACHINE.version,
      requestedOn: null,
      createdBy: a.actorUserId,
      sourceKind: "estimate",
      sourceId: e.id,
      updatedAt: a.at,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
    .catch((err) => {
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "already_converted", "This estimate already has its work order");
      throw err;
    });
  await trx
    .insertInto("workOrderLines")
    .values(
      lines.map((l, i) => ({
        organizationId: e.organizationId,
        workOrderId: wo.id,
        position: i + 1,
        description: l.description,
        quantityMilli: l.quantityMilli,
        unitPriceCents: l.unitPriceCents,
        taxable: l.taxable,
        source: "planned" as const,
        updatedAt: a.at,
      })),
    )
    .execute();
  await workOrderEvent(trx, null, {
    organizationId: e.organizationId,
    workOrderId: wo.id,
    eventType: "created",
    summary: `Created from accepted ${estimateLabel(e.number)}`,
    details: { sourceKind: "estimate", sourceId: e.id, version: a.version },
    homeownerVisible: true,
    at: a.at,
  });

  await setEstimateStatus(trx, e, "accepted", a.at, {
    acceptedVersion: a.version,
    acceptedAt: a.at,
    acceptanceKind: a.kind,
    acceptedDocumentId: a.documentId,
    officeEvidence: a.evidence,
    acceptedBy: a.kind === "office_recorded" ? a.actorUserId : null,
    acceptedSelection: JSON.stringify({ selectedOptionalLineIds: chosen, totals }),
    workOrderId: wo.id,
  });
  await estimateEvent(trx, {
    organizationId: e.organizationId,
    estimateId: e.id,
    eventType: "accepted",
    summary: `Version ${a.version} accepted ${a.by}, ${chosen.length ? `with ${chosen.length} option${chosen.length === 1 ? "" : "s"}` : "with no options"}`,
    actorUserId: a.actorUserId,
    details: { version: a.version, kind: a.kind, selectedOptionalLineIds: chosen, totalCents: totals.totalCents, documentId: a.documentId },
    at: a.at,
  });
  await estimateEvent(trx, {
    organizationId: e.organizationId,
    estimateId: e.id,
    eventType: "converted",
    summary: `Work order ${workOrderLabel(number)} created`,
    actorUserId: a.actorUserId,
    details: { workOrderId: wo.id },
    at: a.at,
  });
  await systemAudit(trx, {
    organizationId: e.organizationId,
    actorUserId: a.actorUserId,
    requestId: a.requestId,
    action: "estimate.accepted",
    entityType: "estimate",
    entityId: e.id,
    changes: { version: a.version, kind: a.kind, selectedOptionalLineIds: chosen, workOrderId: wo.id, documentId: a.documentId },
  });
  return { workOrderId: wo.id, totals, chosen };
}

/** Whether the accepted estimate's work order can still be cancelled with it. */
export async function cancellationBlocker(trx: Trx, organizationId: string, workOrderId: string): Promise<string | null> {
  const done = await trx
    .selectFrom("jobs")
    .select("id")
    .where("organizationId", "=", organizationId)
    .where("type", "=", "work")
    .where("workOrderId", "=", workOrderId)
    .where("status", "=", "completed")
    .executeTakeFirst();
  const wo = await trx.selectFrom("workOrders").select(["status"]).where("organizationId", "=", organizationId).where("id", "=", workOrderId).executeTakeFirstOrThrow();
  if (done || wo.status === "completed") return "Work has already been done on its work order. Invoice the completed visits and cancel the rest of the work order instead.";
  const invoiced = await sql<{ n: number }>`
    select count(*)::int as n from invoices i
    where i.organization_id = ${organizationId} and i.status <> 'void'
      and exists (select 1 from invoice_lines l join jobs j on j.id = l.job_id and j.organization_id = l.organization_id
                  where l.invoice_id = i.id and l.organization_id = i.organization_id and j.type = 'work' and j.work_order_id = ${workOrderId})`.execute(trx);
  if (invoiced.rows[0]!.n > 0) return "Its work order has an invoice. Void or delete the invoice first.";
  return null;
}
