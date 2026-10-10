import type { Database, DB } from "@aerowise/db";
import {
  DEFAULT_ESTIMATE_TERMS,
  ESTIMATE_CONSENT_TEXT,
  ISSUE_LABELS,
  SERVICE_REQUEST_LABELS,
  estimateAcceptInput,
  estimateDeclineInput,
  estimateDetail,
  estimateFields,
  estimateFromSourceInput,
  estimateInput,
  estimateLabel,
  estimateLineAmount,
  estimateListQuery,
  estimateReasonInput,
  estimateRecordAcceptanceInput,
  estimateSummary,
  estimateTotals,
  dateInZone,
  id,
  isEstimateOpen,
  publicEstimate,
  toMilli,
  workOrderLabel,
  type EstimateDetail,
  type EstimateLineInput,
  type EstimateSourceKind,
  type EstimateStatus,
  type EstimateSummary,
  type Feature,
  type PublicEstimate,
} from "@aerowise/domain";
import { canonicalJson, sha256Hex, systemAudit } from "@aerowise/renewals";
import { createEstimateLink, payUrlFor, estimateExpired, estimateUrlFor, hashEstimateToken, queueEstimateEmail, queueEstimateExpiry } from "@aerowise/tasks";
import { dollars } from "@aerowise/payments";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { perAddress, type PublicLinkLimits } from "../lib/rate-limits.ts";
import {
  acceptAndConvert,
  cancellationBlocker,
  checkSelection,
  draftLines,
  estimateEvent,
  estimatesOff,
  freezeVersion,
  lockEstimate,
  nextEstimateNumber,
  setEstimateStatus,
  versionOf,
  type LockedEstimate,
} from "../lib/estimates.ts";
import { depositViewFor, lockDepositForWorkOrder, settleDepositAtCancel } from "../lib/deposits.ts";
import type { PaymentsConfig } from "../lib/invoices.ts";
import { lockWorkOrder, setWorkOrderStatus, workOrderEvent } from "../lib/work-orders.ts";

// Estimates (SW-5 part 1, service workflows plan §3.3–§3.5): the office's list and editor,
// sending, revising, voiding, recording a paper or phone approval and cancelling after
// acceptance; and the link the homeowner opens without signing in to choose options, sign
// and accept, or decline. Accepting creates the estimate's work order exactly once.

type Trx = Transaction<DB>;
const params = z.object({ id });
const token = z.object({ token: z.string().min(20).max(64).regex(/^[A-Za-z0-9_-]+$/) });
const publicLimit = { max: 30, timeWindow: "1 minute" };
const notFoundLink = () => new HttpError(404, "not_found", "This estimate link is not valid. Contact your service provider for a new one.");
const iso = (d: Date | null) => d?.toISOString() ?? null;
const joinAddress = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");

const CLOSED_MESSAGE: Partial<Record<EstimateStatus, string>> = {
  draft: "This estimate is being revised. Your service provider will send you the new version.",
  accepted: "This estimate is already accepted",
  declined: "This estimate was declined",
  expired: "This estimate has expired. Contact your service provider for a new one.",
  void: "This estimate was withdrawn",
  cancelled: "This estimate was cancelled",
};

const clientMeta = (req: FastifyRequest) => {
  const forwarded = req.headers["x-forwarded-for"];
  const chain = Array.isArray(forwarded) ? forwarded.join(", ") : forwarded;
  return { ipAddress: (chain ? `${chain} (via ${req.ip})` : req.ip).slice(0, 300), userAgent: (req.headers["user-agent"] ?? "").slice(0, 500) || null };
};

export const estimateRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; features: ReadonlySet<Feature>; appUrl: string; payments: PaymentsConfig; linkLimits: PublicLinkLimits }> = async (
  app,
  { db, now, features, appUrl, payments, linkLimits },
) => {
  // Accepting and declining: a few tries per address (lib/rate-limits.ts).
  const actionLimit = perAddress("estimate-action", linkLimits.actions);
  const enabled = features.has("estimates");
  const requireFeature = () => {
    if (!enabled) throw estimatesOff();
  };
  /** Asking for a deposit needs the deposits feature; clearing one never does. */
  const requireDeposits = (depositCents: number | null | undefined) => {
    if (depositCents && !features.has("deposits")) throw new HttpError(409, "feature_off", "Deposits are not switched on for this deployment");
  };

  async function writeDraftLines(trx: Trx, organizationId: string, estimateId: string, lines: EstimateLineInput[]) {
    await trx.deleteFrom("estimateLines").where("organizationId", "=", organizationId).where("estimateId", "=", estimateId).execute();
    if (!lines.length) return;
    await trx
      .insertInto("estimateLines")
      .values(
        lines.map((l, i) => ({
          organizationId,
          estimateId,
          position: i + 1,
          description: l.description,
          quantityMilli: toMilli(l.quantity),
          unitPriceCents: l.unitPriceCents,
          taxable: l.taxable ?? false,
          optional: l.optional ?? false,
          selectedByDefault: l.optional ? (l.selectedByDefault ?? true) : true,
        })),
      )
      .execute();
  }

  async function checkWorkType(trx: Trx, organizationId: string, workTypeId: string | null | undefined) {
    if (!workTypeId) return null;
    const t = await trx.selectFrom("workTypes").select(["id", "name"]).where("organizationId", "=", organizationId).where("id", "=", workTypeId).executeTakeFirst();
    if (!t) throw unprocessable("workTypeId does not match a kind of work in this organization");
    return t;
  }

  /** Inserts a draft and its first timeline entry. The caller holds any locks it needs. */
  async function insertDraft(
    trx: Trx,
    req: FastifyRequest,
    o: { siteId: string; customerId: string; workTypeId: string | null; title: string; lines: EstimateLineInput[]; taxRateBps?: number; discountCents?: number; termsText?: string; expiresOn?: string | null; depositCents?: number | null; sourceKind: EstimateSourceKind; sourceId: string | null; summary: string },
  ) {
    const { organizationId, userId } = req.requireAuth();
    const at = now();
    const org = await trx.selectFrom("organizations").select(["defaultTaxRateBps"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
    const number = await nextEstimateNumber(trx, organizationId);
    const row = await trx
      .insertInto("estimates")
      .values({
        organizationId,
        number,
        customerId: o.customerId,
        siteId: o.siteId,
        workTypeId: o.workTypeId,
        title: o.title,
        taxRateBps: o.taxRateBps ?? org.defaultTaxRateBps,
        discountCents: o.discountCents ?? 0,
        termsText: o.termsText ?? DEFAULT_ESTIMATE_TERMS,
        expiresOn: o.expiresOn ?? null,
        depositCents: o.depositCents ?? null,
        sourceKind: o.sourceKind,
        sourceId: o.sourceId,
        createdBy: userId,
        updatedAt: at,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await writeDraftLines(trx, organizationId, row.id, o.lines);
    await estimateEvent(trx, { organizationId, estimateId: row.id, eventType: "created", summary: o.summary, actorUserId: userId, details: { sourceKind: o.sourceKind, sourceId: o.sourceId }, at });
    await audit(trx, req, { action: "estimate.created", entityType: "estimate", entityId: row.id, changes: { number, title: o.title, sourceKind: o.sourceKind, sourceId: o.sourceId } });
    return row.id;
  }

  const summaryQuery = (organizationId: string) =>
    db
      .selectFrom("estimates as e")
      .innerJoin("sites as s", (k) => k.onRef("s.id", "=", "e.siteId").onRef("s.organizationId", "=", "e.organizationId"))
      .innerJoin("customers as c", (k) => k.onRef("c.id", "=", "e.customerId").onRef("c.organizationId", "=", "e.organizationId"))
      .leftJoin("estimateVersions as v", (k) => k.onRef("v.estimateId", "=", "e.id").onRef("v.version", "=", "e.currentVersion"))
      .select([
        "e.id",
        "e.number",
        "e.title",
        "e.status",
        "e.currentVersion",
        "e.expiresOn",
        "e.sentAt",
        "e.acceptedAt",
        "e.workOrderId",
        "e.createdAt",
        "e.discountCents",
        "e.taxRateBps",
        "e.acceptedSelection",
        "v.totals as versionTotals",
        "c.id as customerId",
        "c.displayName",
        "s.id as siteId",
        "s.addressLine1",
        "s.city",
        // The draft's total, for an estimate not yet sent in this version.
        sql<string>`(select coalesce(json_agg(json_build_object('id', l.id, 'quantityMilli', l.quantity_milli, 'unitPriceCents', l.unit_price_cents, 'taxable', l.taxable, 'optional', l.optional, 'selectedByDefault', l.selected_by_default)), '[]') from estimate_lines l where l.estimate_id = e.id)`.as("draftLines"),
      ])
      .where("e.organizationId", "=", organizationId);

  type SummaryRow = Awaited<ReturnType<ReturnType<typeof summaryQuery>["execute"]>>[number];
  const totalOf = (r: SummaryRow) => {
    const accepted = r.acceptedSelection as { totals?: { totalCents: number } } | null;
    if (accepted?.totals) return accepted.totals.totalCents;
    if (r.versionTotals) return (r.versionTotals as { totalCents: number }).totalCents;
    const lines = (typeof r.draftLines === "string" ? JSON.parse(r.draftLines) : r.draftLines) as Parameters<typeof estimateTotals>[0];
    return estimateTotals(lines, r.discountCents, r.taxRateBps).totalCents;
  };
  const toSummary = (r: SummaryRow): EstimateSummary => ({
    id: r.id,
    number: r.number,
    label: estimateLabel(r.number),
    title: r.title,
    status: r.status,
    currentVersion: r.currentVersion,
    customer: { id: r.customerId, displayName: r.displayName },
    site: { id: r.siteId, addressLine1: r.addressLine1, city: r.city },
    totalCents: totalOf(r),
    expiresOn: r.expiresOn,
    sentAt: iso(r.sentAt),
    acceptedAt: iso(r.acceptedAt),
    workOrderId: r.workOrderId,
    createdAt: r.createdAt.toISOString(),
  });

  async function sourceLabel(organizationId: string, kind: EstimateSourceKind, sourceId: string | null) {
    if (kind === "inspection_issue" && sourceId) {
      const issue = await db.selectFrom("issues").select(["type"]).where("organizationId", "=", organizationId).where("id", "=", sourceId).executeTakeFirst();
      return issue ? `Inspection issue: ${ISSUE_LABELS[issue.type as keyof typeof ISSUE_LABELS] ?? issue.type}` : "Inspection issue";
    }
    if (kind === "portal_request" && sourceId) {
      const r = await db.selectFrom("serviceRequests").select(["kind", "source"]).where("organizationId", "=", organizationId).where("id", "=", sourceId).executeTakeFirst();
      return r ? `${r.source === "portal" ? "Customer request" : "Service request"}: ${SERVICE_REQUEST_LABELS[r.kind].toLowerCase()}` : "Service request";
    }
    return "Created by the office";
  }

  /** The deposit asked for when the estimate was accepted. */
  const acceptedDeposit = (selection: unknown) => (selection as { depositCents?: number | null } | null)?.depositCents ?? null;

  /** What the homeowner sees of the deposit: how much, and where to pay it while it is owed. */
  async function publicDeposit(organizationId: string, estimateId: string, cancelled: boolean): Promise<PublicEstimate["deposit"]> {
    const d = await db
      .selectFrom("estimateInvoices as ei")
      .innerJoin("invoices as i", (k) => k.onRef("i.id", "=", "ei.invoiceId").onRef("i.organizationId", "=", "ei.organizationId"))
      .select(["i.id", "i.totalCents", "i.paymentStatus", "i.status"])
      .where("ei.organizationId", "=", organizationId)
      .where("ei.estimateId", "=", estimateId)
      .where("ei.role", "=", "deposit")
      .where("ei.voidedAt", "is", null)
      .executeTakeFirst();
    if (!d) return null;
    // A cancelled estimate asks for no more deposit money.
    const owed = !cancelled && d.status === "open" && (d.paymentStatus === "unpaid" || d.paymentStatus === "partial");
    return { amountCents: d.totalCents, paymentStatus: d.paymentStatus, payUrl: owed ? payUrlFor(appUrl, d.id) : null };
  }

  async function loadDetail(organizationId: string, estimateId: string): Promise<EstimateDetail> {
    const row = await summaryQuery(organizationId)
      .leftJoin("workTypes as t", (k) => k.onRef("t.id", "=", "e.workTypeId").onRef("t.organizationId", "=", "e.organizationId"))
      .leftJoin("workOrders as w", (k) => k.onRef("w.id", "=", "e.workOrderId").onRef("w.organizationId", "=", "e.organizationId"))
      .leftJoin("signedDocuments as d", (k) => k.onRef("d.id", "=", "e.acceptedDocumentId").onRef("d.organizationId", "=", "e.organizationId"))
      .leftJoin("users as ab", "ab.id", "e.acceptedBy")
      .select([
        "e.sourceKind",
        "e.sourceId",
        "e.termsText",
        "e.depositCents",
        "e.acceptedVersion",
        "e.acceptanceKind",
        "e.officeEvidence",
        "e.declinedReason",
        "e.voidReason",
        "e.cancelReason",
        "t.id as workTypeId",
        "t.name as workTypeName",
        "w.number as woNumber",
        "w.status as woStatus",
        "d.signerName",
        "d.signatureKind",
        "d.contentSha256",
        "ab.name as recordedByName",
      ])
      .where("e.id", "=", estimateId)
      .executeTakeFirst();
    if (!row) throw notFound("Estimate");
    const [lines, versions, events, email] = await Promise.all([
      draftLines(db, organizationId, row.id),
      db.selectFrom("estimateVersions").selectAll().where("organizationId", "=", organizationId).where("estimateId", "=", row.id).orderBy("version").execute(),
      db
        .selectFrom("estimateEvents as ev")
        .leftJoin("users as u", "u.id", "ev.actorUserId")
        .select(["ev.id", "ev.eventType", "ev.summary", "ev.occurredAt", "u.name"])
        .where("ev.organizationId", "=", organizationId)
        .where("ev.estimateId", "=", row.id)
        .orderBy("ev.seq")
        .execute(),
      db.selectFrom("contacts").select("id").where("organizationId", "=", organizationId).where("customerId", "=", row.customerId).where("email", "is not", null).executeTakeFirst(),
    ]);
    const accepted = row.acceptedSelection as { selectedOptionalLineIds: string[]; totals: EstimateDetail["draft"]["totals"] } | null;
    return {
      ...toSummary(row),
      workType: row.workTypeId ? { id: row.workTypeId, name: row.workTypeName ?? "" } : null,
      source: { kind: row.sourceKind, id: row.sourceId, label: await sourceLabel(organizationId, row.sourceKind, row.sourceId) },
      draft: { lines, taxRateBps: row.taxRateBps, discountCents: row.discountCents, totals: estimateTotals(lines, row.discountCents, row.taxRateBps), termsText: row.termsText, expiresOn: row.expiresOn, depositCents: row.depositCents },
      versions: versions.map((v) => ({
        version: v.version,
        lines: v.lines as EstimateDetail["draft"]["lines"],
        taxRateBps: v.taxRateBps,
        discountCents: v.discountCents,
        totals: v.totals as EstimateDetail["draft"]["totals"],
        termsText: v.termsText,
        expiresOn: v.expiresOn,
        depositCents: v.depositCents,
        contentSha256: v.contentSha256,
        sentAt: v.sentAt.toISOString(),
      })),
      acceptance:
        row.acceptedVersion && row.acceptanceKind && row.acceptedAt && accepted
          ? {
              version: row.acceptedVersion,
              kind: row.acceptanceKind,
              at: row.acceptedAt.toISOString(),
              selectedOptionalLineIds: accepted.selectedOptionalLineIds,
              totals: accepted.totals,
              signerName: row.signerName,
              signatureKind: row.signatureKind,
              documentSha256: row.contentSha256,
              evidence: row.officeEvidence,
              recordedByName: row.acceptanceKind === "office_recorded" ? row.recordedByName : null,
            }
          : null,
      workOrder: row.workOrderId && row.woNumber !== null && row.woStatus ? { id: row.workOrderId, label: workOrderLabel(row.woNumber), status: row.woStatus } : null,
      declinedReason: row.declinedReason,
      voidReason: row.voidReason,
      cancelReason: row.cancelReason,
      events: events.map((e) => ({ id: e.id, eventType: e.eventType, summary: e.summary, occurredAt: e.occurredAt.toISOString(), actorName: e.name })),
      canEmail: !!email,
      deposit: await depositViewFor(db, organizationId, row.id, accepted ? acceptedDeposit(row.acceptedSelection) : null),
    };
  }

  // ---- Office ----

  app.get(
    "/estimates",
    {
      config: { permission: "estimates:read" },
      schema: { tags: ["estimates"], summary: "Estimates, newest first", querystring: estimateListQuery, response: { 200: z.object({ items: z.array(estimateSummary), total: z.number().int() }) } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const f = req.query;
      let q = summaryQuery(organizationId);
      if (f.status) q = q.where("e.status", "=", f.status);
      if (f.active) q = q.where("e.status", "in", ["draft", "sent", "viewed"]);
      if (f.customerId) q = q.where("e.customerId", "=", f.customerId);
      if (f.siteId) q = q.where("e.siteId", "=", f.siteId);
      const [rows, count] = await Promise.all([
        q.orderBy("e.createdAt", "desc").limit(f.limit).offset(f.offset).execute(),
        q.clearSelect().select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow(),
      ]);
      return { items: rows.map(toSummary), total: Number(count.n) };
    },
  );

  app.get(
    "/estimates/:id",
    { config: { permission: "estimates:read" }, schema: { tags: ["estimates"], summary: "An estimate with its draft, sent versions, acceptance and timeline", params, response: { 200: estimateDetail } } },
    async (req) => loadDetail(req.requireAuth().organizationId, req.params.id),
  );

  app.post(
    "/estimates",
    { config: { permission: "estimates:write" }, schema: { tags: ["estimates"], summary: "Draft an estimate for a site", body: estimateInput, response: { 201: estimateDetail } } },
    async (req, reply) => {
      requireFeature();
      const { organizationId } = req.requireAuth();
      const b = req.body;
      requireDeposits(b.depositCents);
      const site = await db.selectFrom("sites").select(["id", "customerId"]).where("organizationId", "=", organizationId).where("id", "=", b.siteId).executeTakeFirst();
      if (!site) throw notFound("Site");
      const estimateId = await db.transaction().execute(async (trx) => {
        const type = await checkWorkType(trx, organizationId, b.workTypeId);
        return insertDraft(trx, req, {
          siteId: site.id,
          customerId: site.customerId,
          workTypeId: type?.id ?? null,
          title: b.title ?? (type ? `${type.name} estimate` : "Estimate"),
          lines: b.lines,
          taxRateBps: b.taxRateBps,
          discountCents: b.discountCents,
          termsText: b.termsText,
          expiresOn: b.expiresOn,
          depositCents: b.depositCents,
          sourceKind: "office",
          sourceId: null,
          summary: "Drafted by the office",
        });
      });
      return reply.status(201).send(await loadDetail(organizationId, estimateId));
    },
  );

  app.patch(
    "/estimates/:id",
    { config: { permission: "estimates:write" }, schema: { tags: ["estimates"], summary: "Change a draft estimate", params, body: estimateFields, response: { 200: estimateDetail } } },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const b = req.body;
      requireDeposits(b.depositCents);
      const at = now();
      await db.transaction().execute(async (trx) => {
        const e = await lockEstimate(trx, organizationId, req.params.id);
        if (e.status !== "draft") throw new HttpError(409, "not_draft", e.status === "sent" || e.status === "viewed" ? "A sent estimate is changed by revising it" : `This estimate is ${e.status}`);
        const type = b.workTypeId !== undefined ? await checkWorkType(trx, organizationId, b.workTypeId) : undefined;
        await trx
          .updateTable("estimates")
          .set({
            ...(b.title !== undefined ? { title: b.title } : {}),
            ...(type !== undefined ? { workTypeId: type?.id ?? null } : {}),
            ...(b.taxRateBps !== undefined ? { taxRateBps: b.taxRateBps } : {}),
            ...(b.discountCents !== undefined ? { discountCents: b.discountCents } : {}),
            ...(b.termsText !== undefined ? { termsText: b.termsText } : {}),
            ...(b.expiresOn !== undefined ? { expiresOn: b.expiresOn } : {}),
            ...(b.depositCents !== undefined ? { depositCents: b.depositCents } : {}),
            updatedAt: at,
          })
          .where("id", "=", e.id)
          .execute();
        if (b.lines) await writeDraftLines(trx, organizationId, e.id, b.lines);
        const changed = Object.keys(b);
        if (changed.length) await estimateEvent(trx, { organizationId, estimateId: e.id, eventType: "updated", summary: `Changed ${changed.join(", ")}`, actorUserId: userId, details: { fields: changed }, at });
        await audit(trx, req, { action: "estimate.updated", entityType: "estimate", entityId: e.id, changes: b });
      });
      return loadDetail(organizationId, req.params.id);
    },
  );

  app.post(
    "/estimates/:id/send",
    {
      config: { permission: "estimates:write" },
      schema: {
        tags: ["estimates"],
        summary: "Send the estimate: freezes the draft as a version and emails the customer a link. Sending a sent estimate again resends the same version.",
        params,
        body: z.object({ email: z.boolean().default(true) }).default({ email: true }),
        response: { 200: estimateDetail },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      await db.transaction().execute(async (trx) => {
        const e = await lockEstimate(trx, organizationId, req.params.id);
        const org = await trx.selectFrom("organizations").select(["timezone"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
        if (e.status === "draft") {
          if (e.expiresOn && estimateExpired(e.expiresOn, dateInZone(at, org.timezone))) throw unprocessable("The offer's last day has already passed. Choose a later date.");
          await freezeVersion(trx, e, at, userId);
          await setEstimateStatus(trx, e, "sent", at, { sentAt: at });
          await estimateEvent(trx, { organizationId, estimateId: e.id, eventType: "sent", summary: `Version ${e.currentVersion} sent${req.body.email ? " by email" : ""}`, actorUserId: userId, details: { version: e.currentVersion, email: req.body.email }, at });
          await queueEstimateExpiry(trx, { organizationId, estimateId: e.id, version: e.currentVersion, expiresOn: e.expiresOn, timeZone: org.timezone });
        } else if (isEstimateOpen(e.status)) {
          if (!req.body.email) throw new HttpError(409, "already_sent", "This version is already sent");
          await estimateEvent(trx, { organizationId, estimateId: e.id, eventType: "resent", summary: `Version ${e.currentVersion} emailed again`, actorUserId: userId, details: { version: e.currentVersion }, at });
        } else {
          throw new HttpError(409, "invalid_transition", `This estimate is ${e.status}`);
        }
        if (req.body.email) {
          const contact = await trx.selectFrom("contacts").select("id").where("organizationId", "=", organizationId).where("customerId", "=", e.customerId).where("email", "is not", null).executeTakeFirst();
          if (!contact) throw unprocessable("The customer has no email address. Add one, or send without email and share the link yourself.");
          await queueEstimateEmail(trx, { organizationId, estimateId: e.id, version: e.currentVersion, createdBy: userId, now: at, requestKey: req.id });
        }
        await audit(trx, req, { action: "estimate.sent", entityType: "estimate", entityId: e.id, changes: { version: e.currentVersion, email: req.body.email } });
      });
      return loadDetail(organizationId, req.params.id);
    },
  );

  app.post(
    "/estimates/:id/link",
    {
      config: { permission: "estimates:write" },
      schema: { tags: ["estimates"], summary: "A new link to the sent estimate, to share with the customer yourself", params, body: z.object({}).optional(), response: { 201: z.object({ url: z.string() }) } },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const url = await db.transaction().execute(async (trx) => {
        const e = await lockEstimate(trx, organizationId, req.params.id);
        if (!e.sentAt) throw new HttpError(409, "not_sent", "Send the estimate first");
        const t = await createEstimateLink(trx, { organizationId, estimateId: e.id, source: "office", sentTo: null, createdBy: userId });
        await audit(trx, req, { action: "estimate.link_created", entityType: "estimate", entityId: e.id });
        return estimateUrlFor(appUrl, t);
      });
      return reply.status(201).send({ url });
    },
  );

  app.post(
    "/estimates/:id/revise",
    {
      config: { permission: "estimates:write" },
      schema: { tags: ["estimates"], summary: "Revise a sent estimate: a new draft version; the customer's link waits for it", params, body: z.object({}).optional(), response: { 200: estimateDetail } },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      await db.transaction().execute(async (trx) => {
        const e = await lockEstimate(trx, organizationId, req.params.id);
        if (!isEstimateOpen(e.status)) throw new HttpError(409, "invalid_transition", e.status === "draft" ? "This estimate is already a draft" : `This estimate is ${e.status}`);
        await setEstimateStatus(trx, e, "draft", at, { currentVersion: e.currentVersion + 1 });
        await estimateEvent(trx, { organizationId, estimateId: e.id, eventType: "revised", summary: `Revising: version ${e.currentVersion + 1} drafted`, actorUserId: userId, details: { version: e.currentVersion + 1 }, at });
        await audit(trx, req, { action: "estimate.revised", entityType: "estimate", entityId: e.id, changes: { version: e.currentVersion + 1 } });
      });
      return loadDetail(organizationId, req.params.id);
    },
  );

  app.post(
    "/estimates/:id/void",
    { config: { permission: "estimates:write" }, schema: { tags: ["estimates"], summary: "Withdraw a draft or sent estimate", params, body: estimateReasonInput, response: { 200: estimateDetail } } },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      await db.transaction().execute(async (trx) => {
        const e = await lockEstimate(trx, organizationId, req.params.id);
        await setEstimateStatus(trx, e, "void", at, { voidedAt: at, voidReason: req.body.reason });
        await estimateEvent(trx, { organizationId, estimateId: e.id, eventType: "voided", summary: `Withdrawn: ${req.body.reason}`, actorUserId: userId, details: { reason: req.body.reason }, at });
        await audit(trx, req, { action: "estimate.voided", entityType: "estimate", entityId: e.id, changes: req.body });
      });
      return loadDetail(organizationId, req.params.id);
    },
  );

  app.post(
    "/estimates/:id/record-acceptance",
    {
      config: { permission: "estimates:write" },
      schema: {
        tags: ["estimates"],
        summary: "Record a paper or phone approval, with evidence, and create the work order",
        description: "Shown as recorded by the office, never as the customer's e-signature. A draft is sent (frozen) first so the accepted version is fixed.",
        params,
        body: estimateRecordAcceptanceInput,
        response: { 200: estimateDetail },
      },
    },
    async (req) => {
      requireFeature();
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      await db.transaction().execute(async (trx) => {
        const e = await lockEstimate(trx, organizationId, req.params.id);
        if (e.status !== "draft" && !isEstimateOpen(e.status)) throw new HttpError(409, "invalid_transition", CLOSED_MESSAGE[e.status] ?? `This estimate is ${e.status}`);
        const version = req.body.version ?? e.currentVersion;
        if (version !== e.currentVersion) throw new HttpError(409, "estimate_revised", "That is not the current version of this estimate");
        if (e.status === "draft") await freezeVersion(trx, e, at, userId);
        await acceptAndConvert(trx, e, {
          version,
          selectedOptionalLineIds: req.body.selectedOptionalLineIds,
          kind: "office_recorded",
          documentId: null,
          evidence: req.body.evidence,
          actorUserId: userId,
          requestId: req.id,
          at,
          by: "as recorded by the office",
        });
      });
      return loadDetail(organizationId, req.params.id);
    },
  );

  app.post(
    "/estimates/:id/cancel",
    {
      config: { permission: "estimates:write" },
      schema: {
        tags: ["estimates"],
        summary: "Cancel an accepted estimate and its work order, before any work is done or invoiced",
        description:
          "An unpaid deposit invoice is voided. A deposit with money received is left as it is and shows in the inbox as \"Deposit disposition needed\" until the office refunds or keeps it; nothing is refunded or kept automatically.",
        params,
        body: estimateReasonInput,
        response: { 200: estimateDetail },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      const openSessions = await db.transaction().execute(async (trx) => {
        const e = await lockEstimate(trx, organizationId, req.params.id);
        if (e.status !== "accepted" || !e.workOrderId) throw new HttpError(409, "invalid_transition", "Only an accepted estimate is cancelled; withdraw a draft or sent one instead");
        const wo = await lockWorkOrder(trx, organizationId, e.workOrderId);
        const dep = await lockDepositForWorkOrder(trx, organizationId, wo.id);
        const blocker = await cancellationBlocker(trx, organizationId, wo.id);
        if (blocker) throw new HttpError(409, "work_started", blocker);
        const reason = `Estimate ${estimateLabel(e.number)} cancelled: ${req.body.reason}`;
        const deposit = dep ? await settleDepositAtCancel(trx, organizationId, dep, { actorUserId: userId, reason, at }) : null;
        const open = await trx
          .selectFrom("jobs")
          .select("id")
          .where("organizationId", "=", organizationId)
          .where("type", "=", "work")
          .where("workOrderId", "=", wo.id)
          .where("status", "in", ["scheduled", "in_progress"])
          .forUpdate()
          .executeTakeFirst();
        if (open) {
          await trx.updateTable("jobs").set({ status: "cancelled", cancelledAt: at, cancelReason: reason, updatedAt: at }).where("organizationId", "=", organizationId).where("id", "=", open.id).execute();
          await audit(trx, req, { action: "job.cancelled", entityType: "job", entityId: open.id, changes: { reason, workOrderId: wo.id } });
        }
        if (wo.status !== "cancelled") {
          await setWorkOrderStatus(trx, organizationId, wo, "cancelled", at, { cancelledAt: at, cancelReason: reason });
          await workOrderEvent(trx, req, { organizationId, workOrderId: wo.id, eventType: "cancelled", summary: `Cancelled: ${reason}`, details: { reason, jobId: open?.id ?? null, estimateId: e.id }, homeownerVisible: true, at });
        }
        await setEstimateStatus(trx, e, "cancelled", at, { cancelledAt: at, cancelReason: req.body.reason });
        await estimateEvent(trx, { organizationId, estimateId: e.id, eventType: "cancelled", summary: `Cancelled after acceptance: ${req.body.reason}`, actorUserId: userId, details: { reason: req.body.reason, workOrderId: wo.id }, at });
        if (deposit?.voided) await estimateEvent(trx, { organizationId, estimateId: e.id, eventType: "deposit_voided", summary: "Unpaid deposit invoice voided", actorUserId: userId, details: { invoiceId: dep!.depositInvoiceId }, at });
        if (deposit && deposit.held > 0)
          await estimateEvent(trx, { organizationId, estimateId: e.id, eventType: "deposit_disposition_needed", summary: `Deposit disposition needed: ${dollars(deposit.held)} held. Refund it or keep it with a reason.`, actorUserId: userId, details: { invoiceId: dep!.depositInvoiceId, heldCents: deposit.held }, at });
        await audit(trx, req, { action: "estimate.cancelled", entityType: "estimate", entityId: e.id, changes: { ...req.body, workOrderId: wo.id, depositVoided: deposit?.voided ?? false, depositHeldCents: deposit?.held ?? 0 } });
        return deposit?.openSessions ?? [];
      });
      // Close any deposit checkout page the customer still has open, as voiding an invoice does.
      const org = await db.selectFrom("organizations").select("stripeAccountId").where("id", "=", organizationId).executeTakeFirstOrThrow();
      if (payments.provider && org.stripeAccountId) {
        for (const s of openSessions) {
          await payments.provider.expireCheckout({ organizationId, accountId: org.stripeAccountId, sessionId: s.providerSessionId }).catch((err: Error) => req.log.warn({ err }, "could not expire checkout"));
        }
      }
      return loadDetail(organizationId, req.params.id);
    },
  );

  /** A draft from an issue or request, or the live estimate it already has. */
  async function fromSource(req: FastifyRequest, kind: EstimateSourceKind, sourceId: string, load: (trx: Trx) => Promise<{ siteId: string; customerId: string; title: string; summary: string; workTypeKey: string }>, lines: EstimateLineInput[]) {
    requireFeature();
    const { organizationId } = req.requireAuth();
    const existing = () =>
      db
        .selectFrom("estimates")
        .select("id")
        .where("organizationId", "=", organizationId)
        .where("sourceKind", "=", kind)
        .where("sourceId", "=", sourceId)
        .where("status", "not in", ["declined", "expired", "void", "cancelled"])
        .executeTakeFirst();
    try {
      return await db.transaction().execute(async (trx) => {
        const src = await load(trx);
        const found = await trx
          .selectFrom("estimates")
          .select("id")
          .where("organizationId", "=", organizationId)
          .where("sourceKind", "=", kind)
          .where("sourceId", "=", sourceId)
          .where("status", "not in", ["declined", "expired", "void", "cancelled"])
          .executeTakeFirst();
        if (found) return { created: false, id: found.id };
        const type = await trx.selectFrom("workTypes").select(["id"]).where("organizationId", "=", organizationId).where("key", "=", src.workTypeKey).where("active", "=", true).executeTakeFirst();
        const estimateId = await insertDraft(trx, req, { siteId: src.siteId, customerId: src.customerId, workTypeId: type?.id ?? null, title: src.title, lines, sourceKind: kind, sourceId, summary: src.summary });
        return { created: true, id: estimateId };
      });
    } catch (err) {
      // Two at once: the unique index let one through; return it.
      if ((err as { code?: string }).code === "23505") {
        const found = await existing();
        if (found) return { created: false, id: found.id };
      }
      throw err;
    }
  }

  app.post(
    "/issues/:id/estimate",
    {
      config: { permission: "estimates:write" },
      schema: { tags: ["estimates"], summary: "Draft an estimate for an inspection issue; a second call returns the same estimate", params, body: estimateFromSourceInput, response: { 200: estimateDetail, 201: estimateDetail } },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const r = await fromSource(
        req,
        "inspection_issue",
        req.params.id,
        async (trx) => {
          const issue = await trx
            .selectFrom("issues as x")
            .innerJoin("sites as s", (k) => k.onRef("s.id", "=", "x.siteId").onRef("s.organizationId", "=", "x.organizationId"))
            .select(["x.id", "x.type", "x.siteId", "s.customerId"])
            .where("x.organizationId", "=", organizationId)
            .where("x.id", "=", req.params.id)
            .forUpdate("x")
            .executeTakeFirst();
          if (!issue) throw notFound("Issue");
          const label = ISSUE_LABELS[issue.type as keyof typeof ISSUE_LABELS] ?? issue.type;
          return { siteId: issue.siteId, customerId: issue.customerId, title: label, summary: `Drafted from an inspection issue: ${label}`, workTypeKey: issue.type === "pump_out" ? "pumping" : "repair" };
        },
        req.body.lines,
      );
      return reply.status(r.created ? 201 : 200).send(await loadDetail(organizationId, r.id));
    },
  );

  app.post(
    "/service-requests/:id/estimate",
    {
      config: { permission: "estimates:write" },
      schema: { tags: ["estimates"], summary: "Draft an estimate for a customer's request; a second call returns the same estimate", params, body: estimateFromSourceInput, response: { 200: estimateDetail, 201: estimateDetail } },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const r = await fromSource(
        req,
        "portal_request",
        req.params.id,
        async (trx) => {
          const sr = await trx.selectFrom("serviceRequests").select(["id", "kind", "siteId", "customerId"]).where("organizationId", "=", organizationId).where("id", "=", req.params.id).forUpdate().executeTakeFirst();
          if (!sr) throw notFound("Service request");
          const label = SERVICE_REQUEST_LABELS[sr.kind];
          return { siteId: sr.siteId, customerId: sr.customerId, title: label, summary: `Drafted from a service request: ${label.toLowerCase()}`, workTypeKey: sr.kind === "pumping" ? "pumping" : sr.kind === "repair" ? "repair" : "service_call" };
        },
        req.body.lines,
      );
      return reply.status(r.created ? 201 : 200).send(await loadDetail(organizationId, r.id));
    },
  );

  // ---- The homeowner's link ----

  async function byToken(ex: Database | Trx, t: string, lock = false) {
    const link = await ex.selectFrom("estimateLinks").select(["organizationId", "estimateId"]).where("tokenHash", "=", hashEstimateToken(t)).executeTakeFirst();
    if (!link) throw notFoundLink();
    let q = ex.selectFrom("estimates").select(ESTIMATE_COLUMNS_PUBLIC).where("organizationId", "=", link.organizationId).where("id", "=", link.estimateId);
    if (lock) q = q.forNoKeyUpdate();
    const e = await q.executeTakeFirst();
    if (!e) throw notFoundLink();
    return e;
  }

  /** An open estimate whose last day has passed is expired before anything else happens. */
  async function expireIfDue(trx: Trx, e: LockedEstimate, at: Date): Promise<EstimateStatus> {
    if (!isEstimateOpen(e.status)) return e.status;
    const org = await trx.selectFrom("organizations").select("timezone").where("id", "=", e.organizationId).executeTakeFirstOrThrow();
    const v = await versionOf(trx, e.id, e.currentVersion);
    if (!v || !estimateExpired(v.expiresOn, dateInZone(at, org.timezone))) return e.status;
    await setEstimateStatus(trx, e, "expired", at, { expiredAt: at });
    await estimateEvent(trx, { organizationId: e.organizationId, estimateId: e.id, eventType: "expired", summary: `Expired: the offer was good until ${v.expiresOn}`, actorUserId: null, details: { version: e.currentVersion }, at });
    await systemAudit(trx, { organizationId: e.organizationId, action: "estimate.expired", entityType: "estimate", entityId: e.id, changes: { version: e.currentVersion } });
    return "expired";
  }

  const expireOnLink = (found: { organizationId: string; id: string }, at: Date) =>
    db.transaction().execute(async (trx) => expireIfDue(trx, await lockEstimate(trx, found.organizationId, found.id), at));

  app.get(
    "/estimate/:token",
    { config: { public: true, rateLimit: publicLimit }, schema: { tags: ["estimate"], summary: "What the homeowner sees from their estimate link", params: token, response: { 200: publicEstimate } } },
    async (req): Promise<PublicEstimate> => {
      const at = now();
      await expireOnLink(await byToken(db, req.params.token), at);
      const e = await byToken(db, req.params.token);
      const organizationId = e.organizationId;
      const [org, customer, site, sent, doc] = await Promise.all([
        db.selectFrom("organizations").select(["name", "phone", "email"]).where("id", "=", organizationId).executeTakeFirstOrThrow(),
        db.selectFrom("customers").select(["displayName"]).where("organizationId", "=", organizationId).where("id", "=", e.customerId).executeTakeFirstOrThrow(),
        db.selectFrom("sites").select(["addressLine1", "addressLine2", "city", "state", "postalCode"]).where("organizationId", "=", organizationId).where("id", "=", e.siteId).executeTakeFirstOrThrow(),
        db
          .selectFrom("estimateVersions")
          .selectAll()
          .where("organizationId", "=", organizationId)
          .where("estimateId", "=", e.id)
          .where("version", "=", e.acceptedVersion ?? e.currentVersion)
          .executeTakeFirst()
          .then(async (v) => v ?? (await db.selectFrom("estimateVersions").selectAll().where("estimateId", "=", e.id).orderBy("version", "desc").limit(1).executeTakeFirst())),
        e.acceptedDocumentId ? db.selectFrom("signedDocuments").select(["signerName"]).where("id", "=", e.acceptedDocumentId).executeTakeFirst() : undefined,
      ]);
      const accepted = e.acceptedSelection as { selectedOptionalLineIds: string[]; totals: NonNullable<PublicEstimate["accepted"]>["totals"] } | null;
      return {
        status: e.status,
        label: estimateLabel(e.number),
        title: e.title,
        provider: { name: org.name, phone: org.phone, email: org.email },
        customerName: customer.displayName,
        serviceAddress: joinAddress([site.addressLine1, site.addressLine2, [site.city, [site.state, site.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")]),
        version: sent
          ? {
              version: sent.version,
              lines: sent.lines as NonNullable<PublicEstimate["version"]>["lines"],
              taxRateBps: sent.taxRateBps,
              discountCents: sent.discountCents,
              totals: sent.totals as NonNullable<PublicEstimate["version"]>["totals"],
              termsText: sent.termsText,
              expiresOn: sent.expiresOn,
              depositCents: sent.depositCents,
              sentAt: sent.sentAt.toISOString(),
            }
          : null,
        beingRevised: e.status === "draft",
        consentText: ESTIMATE_CONSENT_TEXT,
        accepted:
          e.acceptedVersion && e.acceptedAt && e.acceptanceKind && accepted
            ? { version: e.acceptedVersion, at: e.acceptedAt.toISOString(), kind: e.acceptanceKind, signerName: doc?.signerName ?? null, selectedOptionalLineIds: accepted.selectedOptionalLineIds, totals: accepted.totals }
            : null,
        deposit: await publicDeposit(organizationId, e.id, e.status === "cancelled"),
      };
    },
  );

  app.post(
    "/estimate/:token/view",
    { config: { public: true, rateLimit: publicLimit }, schema: { tags: ["estimate"], summary: "Note that the homeowner opened their link", params: token, body: z.object({}).optional(), response: { 204: z.null() } } },
    async (req, reply) => {
      const found = await byToken(db, req.params.token);
      const at = now();
      await db.transaction().execute(async (trx) => {
        const e = await lockEstimate(trx, found.organizationId, found.id);
        if (e.status !== "sent") return;
        await setEstimateStatus(trx, e, "viewed", at, { viewedAt: at });
        await estimateEvent(trx, { organizationId: e.organizationId, estimateId: e.id, eventType: "viewed", summary: `Opened by the customer (version ${e.currentVersion})`, actorUserId: null, at });
        await systemAudit(trx, { organizationId: e.organizationId, action: "estimate.viewed", entityType: "estimate", entityId: e.id, requestId: req.id });
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    "/estimate/:token/accept",
    {
      config: { public: true, rateLimit: actionLimit },
      schema: {
        tags: ["estimate"],
        summary: "Accept the estimate with a signature",
        description: "Freezes the version, the chosen options and their totals with the signature into a signed document, and creates the work order. Accepting twice returns the first acceptance.",
        params: token,
        body: estimateAcceptInput,
        response: { 200: z.object({ status: z.enum(["accepted"]), alreadyAccepted: z.boolean() }) },
      },
    },
    async (req) => {
      const at = now();
      const b = req.body;
      const meta = clientMeta(req);
      const found = await byToken(db, req.params.token);
      // Expiring is kept even though the acceptance is then refused.
      await expireOnLink(found, at);
      return db.transaction().execute(async (trx) => {
        const e = await lockEstimate(trx, found.organizationId, found.id);
        const organizationId = e.organizationId;
        if (e.status === "accepted") {
          if (e.acceptedVersion === b.version) return { status: "accepted" as const, alreadyAccepted: true };
          throw new HttpError(409, "not_acceptable", CLOSED_MESSAGE.accepted!);
        }
        const status = e.status;
        if (!isEstimateOpen(status)) throw new HttpError(409, "not_acceptable", CLOSED_MESSAGE[status] ?? "This estimate can no longer be accepted");
        if (b.version !== e.currentVersion) throw new HttpError(409, "estimate_revised", "This estimate was revised since you opened it. Review the new version before accepting.");
        const v = await versionOf(trx, e.id, b.version);
        if (!v) throw new HttpError(409, "estimate_revised", "This estimate was revised since you opened it. Review the new version before accepting.");

        const [org, customer, site] = await Promise.all([
          trx.selectFrom("organizations").select(["name", "phone", "email"]).where("id", "=", organizationId).executeTakeFirstOrThrow(),
          trx.selectFrom("customers").select(["displayName"]).where("organizationId", "=", organizationId).where("id", "=", e.customerId).executeTakeFirstOrThrow(),
          trx.selectFrom("sites").select(["addressLine1", "city", "state", "postalCode"]).where("organizationId", "=", organizationId).where("id", "=", e.siteId).executeTakeFirstOrThrow(),
        ]);
        // Checked before anything is written, so a refused selection leaves no signature behind.
        const chosen = checkSelection(v.lines, b.selectedOptionalLineIds);
        const totals = estimateTotals(v.lines, v.discountCents, v.taxRateBps, chosen);
        const content = {
          format: 1,
          title: `${estimateLabel(e.number)} acceptance: ${e.title}`,
          estimate: estimateLabel(e.number),
          version: v.version,
          versionSha256: v.contentSha256,
          provider: { name: org.name, phone: org.phone, email: org.email },
          customer: { name: customer.displayName },
          serviceAddress: joinAddress([site.addressLine1, site.city, site.state, site.postalCode]),
          lines: v.lines.map((l) => ({ ...l, amountCents: estimateLineAmount(l), chosen: !l.optional || chosen.includes(l.id) })),
          taxRateBps: v.taxRateBps,
          discountCents: v.discountCents,
          totals,
          terms: v.termsText,
          expiresOn: v.expiresOn,
          // The deposit asked for, as the homeowner accepted it.
          ...(v.depositCents ? { depositCents: Math.min(v.depositCents, totals.totalCents) } : {}),
        };
        const doc = await trx
          .insertInto("signedDocuments")
          .values({
            organizationId,
            kind: "estimate_acceptance",
            renewalId: null,
            estimateId: e.id,
            siteId: e.siteId,
            customerId: e.customerId,
            title: content.title,
            content: JSON.stringify(content),
            contentSha256: sha256Hex(canonicalJson(content)),
            signerName: b.signerName,
            signatureKind: b.signature.kind,
            signatureImage: b.signature.kind === "drawn" ? b.signature.image : null,
            consentText: ESTIMATE_CONSENT_TEXT,
            signedAt: at,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
            pdfStorageKey: null,
            pdfSha256: null,
            pdfByteSize: null,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await acceptAndConvert(trx, e, { version: v.version, selectedOptionalLineIds: chosen, kind: "signature", documentId: doc.id, evidence: null, actorUserId: null, requestId: req.id, at, by: `online by ${b.signerName}` });
        await systemAudit(trx, { organizationId, requestId: req.id, action: "estimate.signed", entityType: "estimate", entityId: e.id, changes: { signedDocumentId: doc.id, ...meta } });
        return { status: "accepted" as const, alreadyAccepted: false };
      });
    },
  );

  app.post(
    "/estimate/:token/decline",
    {
      config: { public: true, rateLimit: actionLimit },
      schema: { tags: ["estimate"], summary: "Decline the estimate", params: token, body: estimateDeclineInput, response: { 200: z.object({ status: z.enum(["declined"]) }) } },
    },
    async (req) => {
      const at = now();
      const found = await byToken(db, req.params.token);
      await expireOnLink(found, at);
      await db.transaction().execute(async (trx) => {
        const e = await lockEstimate(trx, found.organizationId, found.id);
        const status = e.status;
        if (!isEstimateOpen(status)) throw new HttpError(409, "not_acceptable", CLOSED_MESSAGE[status] ?? "This estimate can no longer be changed");
        const reason = req.body.reason ?? null;
        await setEstimateStatus(trx, e, "declined", at, { declinedAt: at, declinedReason: reason });
        await estimateEvent(trx, { organizationId: e.organizationId, estimateId: e.id, eventType: "declined", summary: reason ? `Declined by the customer: ${reason}` : "Declined by the customer", actorUserId: null, details: { version: e.currentVersion }, at });
        await systemAudit(trx, { organizationId: e.organizationId, requestId: req.id, action: "estimate.declined", entityType: "estimate", entityId: e.id, changes: { reason } });
      });
      return { status: "declined" as const };
    },
  );
};

const ESTIMATE_COLUMNS_PUBLIC = [
  "id",
  "organizationId",
  "number",
  "customerId",
  "siteId",
  "title",
  "status",
  "currentVersion",
  "acceptedVersion",
  "acceptedAt",
  "acceptanceKind",
  "acceptedDocumentId",
  "acceptedSelection",
] as const;
