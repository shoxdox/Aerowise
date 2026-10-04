import {
  adapterFor,
  confirmFiling,
  FilingStateError,
  loadCanonicalInspection,
  loadCatalog,
  loadFiling,
  markFiledManually,
  prepareFiling,
  recheckFiling,
  rejectFiling,
  resolveSite,
  resubmitFiling,
  retryFiling,
  rulesetOn,
  submitNow,
  useManualFiling,
  type ComplianceContext,
  type ResolvedJurisdiction,
} from "@aerowise/compliance";
import type { Database, DB } from "@aerowise/db";
import {
  deadlineState,
  FILING_ATTENTION_STATUSES,
  FILING_OPEN_STATUSES,
  filingConfirmInput,
  filingDetail,
  filingListItem,
  filingManualSentInput,
  filingRejectInput,
  id,
  jurisdiction,
  siteJurisdiction,
  siteJurisdictionInput,
  type FilingDetail,
  type FilingListItem,
  type FilingProof,
  type FilingStatus,
  type Jurisdiction,
  type RulesetRules,
} from "@aerowise/domain";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { organizationToday } from "../lib/today.ts";
import type { UrlSigner } from "../storage/signed-urls.ts";

const params = z.object({ id });

const VIEWS = ["attention", "open", "sent", "confirmed", "all"] as const;

export const filingRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; signer: UrlSigner; compliance: Omit<ComplianceContext, "db" | "now"> }> = async (
  app,
  { db, now, signer, compliance },
) => {
  const ctx = (): ComplianceContext => ({ ...compliance, db, now });

  const toJurisdiction = (entry: Awaited<ReturnType<typeof loadCatalog>>[number], onDate: string): Jurisdiction => {
    const rs = rulesetOn(entry, onDate) ?? entry.rulesets[0] ?? null;
    return {
      id: entry.jurisdiction.id,
      key: entry.jurisdiction.key,
      state: entry.jurisdiction.state,
      authorityName: entry.jurisdiction.authorityName,
      type: entry.jurisdiction.type,
      rulesetVersion: rs?.version ?? null,
      counties: rs?.rules.applicability.counties ?? [],
    };
  };

  app.get(
    "/jurisdictions",
    {
      config: { permission: "crm:read" },
      schema: { tags: ["filings"], summary: "Reporting authorities and their current ruleset version", response: { 200: z.object({ items: z.array(jurisdiction) }) } },
    },
    async (req) => {
      const today = await organizationToday(db, req.requireAuth().organizationId, now());
      return { items: (await loadCatalog(db)).filter((e) => e.jurisdiction.active).map((e) => toJurisdiction(e, today)) };
    },
  );

  async function siteJurisdictionOf(organizationId: string, siteId: string) {
    const site = await db.selectFrom("sites").select(["id", "county", "state", "jurisdictionId"]).where("organizationId", "=", organizationId).where("id", "=", siteId).executeTakeFirst();
    if (!site) throw notFound("Site");
    const today = await organizationToday(db, organizationId, now());
    const catalog = await loadCatalog(db);
    const resolved = resolveSite(catalog, site, today);
    const entry = resolved && catalog.find((e) => e.jurisdiction.id === resolved.jurisdictionId);
    return { source: resolved?.source ?? ("none" as const), jurisdiction: entry ? toJurisdiction(entry, today) : null };
  }

  app.get(
    "/sites/:id/jurisdiction",
    {
      config: { permission: "crm:read" },
      schema: { tags: ["filings"], summary: "Which authority the site reports to, and why", params, response: { 200: siteJurisdiction } },
    },
    async (req) => siteJurisdictionOf(req.requireAuth().organizationId, req.params.id),
  );

  app.put(
    "/sites/:id/jurisdiction",
    {
      config: { permission: "crm:write" },
      schema: {
        tags: ["filings"],
        summary: "Choose the site's authority by hand, or null to match it from the county",
        description: "Affects inspections completed from now on and filings checked again; existing filings keep the authority they recorded.",
        params,
        body: siteJurisdictionInput,
        response: { 200: siteJurisdiction },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const { jurisdictionId } = req.body;
      if (jurisdictionId) {
        const j = await db.selectFrom("jurisdictions").select("id").where("id", "=", jurisdictionId).where("active", "=", true).executeTakeFirst();
        if (!j) throw unprocessable("jurisdictionId does not match an active authority");
      }
      await db.transaction().execute(async (trx) => {
        const res = await trx.updateTable("sites").set({ jurisdictionId, updatedAt: now() }).where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
        if (Number(res.numUpdatedRows) !== 1) throw notFound("Site");
        await audit(trx, req, { action: "site.jurisdiction_set", entityType: "site", entityId: req.params.id, changes: { jurisdictionId } });
      });
      return siteJurisdictionOf(organizationId, req.params.id);
    },
  );

  const listQuery = (organizationId: string) =>
    db
      .selectFrom("filings as f")
      .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "f.siteId").onRef("s.organizationId", "=", "f.organizationId"))
      .innerJoin("customers as c", (j) => j.onRef("c.id", "=", "s.customerId").onRef("c.organizationId", "=", "s.organizationId"))
      .innerJoin("inspections as i", (j) => j.onRef("i.id", "=", "f.inspectionId").onRef("i.organizationId", "=", "f.organizationId"))
      .leftJoin("jurisdictions as jr", "jr.id", "f.jurisdictionId")
      .select((eb) => [
        "f.id",
        "f.status",
        "f.submissionMethod",
        "f.deadlineOn",
        "f.warningDays",
        "f.nextDueOn",
        "f.sentAt",
        "f.confirmedAt",
        "f.confirmationReference",
        "f.reviewReason",
        "f.lastError",
        "f.rulesetVersion",
        "i.id as inspectionId",
        "i.completedAt",
        "s.id as siteId",
        "s.addressLine1",
        "s.city",
        "s.permitNumber",
        "c.id as customerId",
        "c.displayName",
        "jr.key as jurisdictionKey",
        "jr.authorityName",
        eb.selectFrom("filingAttempts as a").select(sql<number>`count(*)::int`.as("n")).whereRef("a.filingId", "=", "f.id").as("attemptCount"),
      ])
      .where("f.organizationId", "=", organizationId);

  type ListRow = Awaited<ReturnType<ReturnType<typeof listQuery>["execute"]>>[number];
  const toItem = (r: ListRow, today: string): FilingListItem => ({
    id: r.id,
    status: r.status,
    submissionMethod: r.submissionMethod,
    deadlineOn: r.deadlineOn,
    deadlineState: deadlineState(r.status, r.deadlineOn, r.warningDays, today),
    nextDueOn: r.nextDueOn,
    sentAt: r.sentAt?.toISOString() ?? null,
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    confirmationReference: r.confirmationReference,
    reviewReason: r.reviewReason,
    lastError: r.lastError,
    attemptCount: Number(r.attemptCount ?? 0),
    inspection: { id: r.inspectionId, completedAt: r.completedAt?.toISOString() ?? null },
    site: { id: r.siteId, addressLine1: r.addressLine1, city: r.city, permitNumber: r.permitNumber },
    customer: { id: r.customerId, displayName: r.displayName },
    jurisdiction: r.jurisdictionKey && r.authorityName && r.rulesetVersion ? { key: r.jurisdictionKey, authorityName: r.authorityName, rulesetVersion: r.rulesetVersion } : null,
  });

  app.get(
    "/filings",
    {
      config: { permission: "filings:read" },
      schema: {
        tags: ["filings"],
        summary: "Filings, most urgent first",
        description:
          "`attention`: failed, rejected or needing review, or open with the deadline warning reached. " +
          "`open`: not yet sent. `sent`: sent and waiting for the authority's confirmation.",
        querystring: z.object({
          view: z.enum(VIEWS).default("attention"),
          siteId: id.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: { 200: z.object({ items: z.array(filingListItem), today: z.iso.date() }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const today = await organizationToday(db, organizationId, now());
      let q = listQuery(organizationId);
      if (req.query.siteId) q = q.where("f.siteId", "=", req.query.siteId);
      const open = [...FILING_OPEN_STATUSES];
      switch (req.query.view) {
        case "attention":
          q = q.where((eb) =>
            eb.or([
              eb("f.status", "in", [...FILING_ATTENTION_STATUSES]),
              eb.and([eb("f.status", "in", open), eb(sql`f.deadline_on - f.warning_days`, "<=", sql`${today}::date`)]),
            ]),
          );
          break;
        case "open":
          q = q.where("f.status", "in", open);
          break;
        case "sent":
          q = q.where("f.status", "=", "sent");
          break;
        case "confirmed":
          q = q.where("f.status", "=", "confirmed");
          break;
      }
      const rows = await q.orderBy(sql`f.deadline_on nulls first`).orderBy("f.createdAt").limit(req.query.limit).execute();
      return { items: rows.map((r) => toItem(r, today)), today };
    },
  );

  async function detail(organizationId: string, filingId: string): Promise<FilingDetail> {
    const row = await listQuery(organizationId).where("f.id", "=", filingId).executeTakeFirst();
    if (!row) throw notFound("Filing");
    const today = await organizationToday(db, organizationId, now());
    const f = await db
      .selectFrom("filings as f")
      .leftJoin("jurisdictionRulesets as r", "r.id", "f.rulesetId")
      .leftJoin("jurisdictions as j", "j.id", "f.jurisdictionId")
      .select([
        "f.stateMachineVersion",
        "f.submissionNo",
        "f.methodVersion",
        "f.templateId",
        "f.proof",
        "f.confirmationNote",
        "f.rejectionReason",
        "f.reportId",
        "r.id as rulesetId",
        "r.rules",
        "j.key",
        "j.authorityName",
      ])
      .where("f.organizationId", "=", organizationId)
      .where("f.id", "=", filingId)
      .executeTakeFirstOrThrow();
    const attempts = await db
      .selectFrom("filingAttempts")
      .select(["attemptNo", "submissionNo", "method", "status", "startedAt", "finishedAt", "error"])
      .where("organizationId", "=", organizationId)
      .where("filingId", "=", filingId)
      .orderBy("attemptNo", "desc")
      .execute();

    let pkg: FilingDetail["package"] = null;
    if (f.rulesetId && f.rules && f.key && f.authorityName) {
      const rules = f.rules as RulesetRules;
      const resolved: ResolvedJurisdiction = { jurisdictionId: "", key: f.key, authorityName: f.authorityName, rulesetId: f.rulesetId, rules, source: "county" };
      const adapter = adapterFor(resolved, { db, store: compliance.store, mail: compliance.mail });
      let subject: string | null = null;
      if (adapter && row.completedAt) {
        const insp = await loadCanonicalInspection(db, organizationId, row.inspectionId);
        subject = (await adapter.buildSubmission(insp, [], { filingId, submissionNo: f.submissionNo })).subject;
      }
      pkg = {
        destination: rules.submission.email?.to ?? null,
        portalUrl: rules.submission.portalUrl,
        subject,
        reportUrl: f.reportId ? signer.url(organizationId, f.reportId, now().getTime(), "report-files") : null,
        fallback: rules.submission.fallback,
      };
    }
    return {
      ...toItem(row, today),
      stateMachineVersion: f.stateMachineVersion,
      submissionNo: f.submissionNo,
      methodVersion: f.methodVersion,
      templateId: f.templateId,
      proof: (f.proof as FilingProof | null) ?? null,
      confirmationNote: f.confirmationNote,
      rejectionReason: f.rejectionReason,
      package: pkg,
      attempts: attempts.map((a) => ({ ...a, startedAt: a.startedAt.toISOString(), finishedAt: a.finishedAt?.toISOString() ?? null })),
    };
  }

  app.get(
    "/filings/:id",
    { config: { permission: "filings:read" }, schema: { tags: ["filings"], summary: "A filing with its attempts, proof and what a manual filer needs", params, response: { 200: filingDetail } } },
    async (req) => detail(req.requireAuth().organizationId, req.params.id),
  );

  /** Runs an office action on a locked filing, audits it, and returns the fresh detail. */
  async function act(
    req: FastifyRequest,
    filingId: string,
    action: string,
    run: (trx: Transaction<DB>, f: NonNullable<Awaited<ReturnType<typeof loadFiling>>>, a: { organizationId: string; filingId: string; actorUserId: string; at: Date }) => Promise<void>,
    changes: Record<string, unknown> = {},
  ) {
    const { organizationId, userId } = req.requireAuth();
    const at = now();
    let from: FilingStatus | null = null;
    try {
      await db.transaction().execute(async (trx) => {
        const f = await loadFiling(trx, organizationId, filingId, true);
        if (!f) throw notFound("Filing");
        from = f.status;
        await run(trx, f, { organizationId, filingId: f.id, actorUserId: userId, at });
        await audit(trx, req, { action: `filing.${action}`, entityType: "filing", entityId: f.id, changes: { ...changes, from, to: f.status } });
      });
    } catch (err) {
      if (err instanceof FilingStateError) throw new HttpError(409, "invalid_transition", err.message);
      throw err;
    }
    return detail(organizationId, filingId);
  }

  const action = (summary: string, body?: z.ZodObject) => ({
    config: { permission: "filings:write" as const },
    schema: { tags: ["filings"], summary, params, ...(body ? { body } : {}), response: { 200: filingDetail } },
  });

  app.post("/filings/:id/submit", action("Send a ready email filing now"), async (req) => act(req, req.params.id, "submitted", (trx, f, a) => submitNow(trx, ctx(), f, a)));

  app.post("/filings/:id/retry", action("Retry a failed email filing now"), async (req) => act(req, req.params.id, "retried", (trx, f, a) => retryFiling(trx, ctx(), f, a)));

  app.post("/filings/:id/resubmit", action("Submit again after the authority rejected it"), async (req) =>
    act(req, req.params.id, "resubmitted", (trx, f, a) => resubmitFiling(trx, ctx(), f, a)),
  );

  app.post("/filings/:id/manual", action("File this one by hand (portal, mail or counter) instead of by email"), async (req) =>
    act(req, req.params.id, "switched_manual", (trx, f, a) => useManualFiling(trx, f, a)),
  );

  app.post("/filings/:id/mark-sent", action("Record that it was filed by hand", filingManualSentInput), async (req) => {
    const me = await db.selectFrom("users").select("name").where("id", "=", req.requireAuth().userId).executeTakeFirstOrThrow();
    const body = filingManualSentInput.parse(req.body);
    return act(req, req.params.id, "marked_sent", (trx, f, a) => markFiledManually(trx, f, { ...a, reference: body.reference ?? null, note: body.note ?? null, actorName: me.name }), body);
  });

  app.post("/filings/:id/confirm", action("Record the authority's confirmation and its reference", filingConfirmInput), async (req) => {
    const body = filingConfirmInput.parse(req.body);
    return act(req, req.params.id, "confirmed", (trx, f, a) => confirmFiling(trx, f, { ...a, reference: body.reference, note: body.note ?? null }), body);
  });

  app.post("/filings/:id/reject", action("Record that the authority rejected it", filingRejectInput), async (req) => {
    const body = filingRejectInput.parse(req.body);
    return act(req, req.params.id, "rejected", (trx, f, a) => rejectFiling(trx, f, { ...a, reason: body.reason }), body);
  });

  app.post("/filings/:id/recheck", action("Check a filing that needs review again, after fixing the cause"), async (req) => {
    const { organizationId } = req.requireAuth();
    await act(req, req.params.id, "rechecked", (trx, f, a) => recheckFiling(trx, f, a));
    const f = await loadFiling(db, organizationId, req.params.id);
    if (f) await prepareFiling(ctx(), organizationId, f.inspectionId, req.requireAuth().userId);
    return detail(organizationId, req.params.id);
  });
};
