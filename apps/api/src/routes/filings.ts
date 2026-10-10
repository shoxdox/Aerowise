import {
  confirmFiling,
  correctFiling,
  explainSite,
  FilingStateError,
  loadCatalog,
  loadFiling,
  markFiledManually,
  prepareFilingById,
  recheckFiling,
  rejectFiling,
  ReportCorrectionError,
  resubmitFiling,
  retryFiling,
  rulesetOn,
  submitNow,
  useCsvExport,
  useManualFiling,
  type ComplianceContext,
} from "@aerowise/compliance";
import type { Database, DB } from "@aerowise/db";
import {
  authorityRequirements,
  deadlineState,
  exportLayoutFor,
  FILING_ATTENTION_STATUSES,
  FILING_OPEN_STATUSES,
  filingConfirmInput,
  filingCorrectInput,
  filingDetail,
  filingListItem,
  filingManualSentInput,
  filingRejectInput,
  id,
  jurisdiction,
  profileStatus,
  requirementsSource,
  siteIdentifierInput,
  siteJurisdiction,
  siteJurisdictionInput,
  verifiedWith,
  type FilingDetail,
  type PackageDocument,
  type SiteJurisdiction,
  type FilingListItem,
  type FilingProof,
  type FilingStatus,
  type Jurisdiction,
  type RulesetRules,
  siteScheduleProblem,
  type LocationStatus,
} from "@aerowise/domain";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { organizationToday } from "../lib/today.ts";
import type { UrlSigner } from "../storage/signed-urls.ts";
import { readForDownload } from "../lib/demo.ts";

const params = z.object({ id });

const VIEWS = ["attention", "open", "sent", "confirmed", "all"] as const;

export const filingRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; signer: UrlSigner; compliance: Omit<ComplianceContext, "db" | "now">; production?: boolean }> = async (
  app,
  { db, now, signer, compliance, production = false },
) => {
  const ctx = (): ComplianceContext => ({ ...compliance, db, now });

  /**
   * The fictional example authority is for development, tests and demo companies. In
   * production a real company never sees it or files under it, even where the hosted demo's
   * database holds it (DEMO_MODE loads it for the demo companies that share that database).
   */
  const fictionalAllowed = async (organizationId: string) => {
    if (!production) return true;
    const org = await db.selectFrom("organizations").select("demo").where("id", "=", organizationId).executeTakeFirst();
    return org?.demo === true;
  };
  const isFictional = (entry: Awaited<ReturnType<typeof loadCatalog>>[number]) => entry.rulesets.every((rs) => profileStatus(rs.rules) === "fictional");

  /** When the sources were read and when the requirement took effect: two different dates, kept apart. */
  const profileDates = (rules: RulesetRules) => ({ sourcesCheckedOn: rules.profile?.sourcesCheckedOn ?? null, requirementEffective: rules.profile?.requirementEffective ?? null });

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
      assignment: rs?.rules.applicability.assignment ?? "county",
      howToDecide: rs?.rules.applicability.howToDecide ?? null,
      profileStatus: rs ? profileStatus(rs.rules) : "fictional",
      verified: rs ? verifiedWith(rs.rules) : null,
    };
  };

  app.get(
    "/jurisdictions",
    {
      config: { permission: "crm:read" },
      schema: { tags: ["filings"], summary: "Reporting authorities and their current ruleset version", response: { 200: z.object({ items: z.array(jurisdiction) }) } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const today = await organizationToday(db, organizationId, now());
      const showFictional = await fictionalAllowed(organizationId);
      return {
        items: (await loadCatalog(db))
          .filter((e) => e.jurisdiction.active)
          .filter((e) => showFictional || !isFictional(e))
          .map((e) => toJurisdiction(e, today)),
      };
    },
  );

  async function siteJurisdictionOf(organizationId: string, siteId: string): Promise<SiteJurisdiction> {
    const site = await db
      .selectFrom("sites")
      .select(["id", "county", "state", "jurisdictionId", "authorityAssignmentId", "useCategory", "permitIntervalMonths"])
      .where("organizationId", "=", organizationId)
      .where("id", "=", siteId)
      .executeTakeFirst();
    if (!site) throw notFound("Site");
    const today = await organizationToday(db, organizationId, now());
    const catalog = await loadCatalog(db);
    const resolution = explainSite(catalog, site, today);
    const resolved = resolution.resolved;
    const entry = resolved && catalog.find((e) => e.jurisdiction.id === resolved.jurisdictionId);
    const assignment = site.authorityAssignmentId
      ? await db
          .selectFrom("siteAuthorityAssignments as a")
          .leftJoin("users as u", "u.id", "a.assignedBy")
          .select(["a.evidenceKind", "a.evidenceReference", "a.evidenceNote", "a.assignedAt", "u.name"])
          .where("a.organizationId", "=", organizationId)
          .where("a.id", "=", site.authorityAssignmentId)
          .executeTakeFirst()
      : undefined;
    const values = resolved
      ? await db
          .selectFrom("siteAuthorityIdentifiers")
          .select(["kind", "value"])
          .where("organizationId", "=", organizationId)
          .where("siteId", "=", siteId)
          .where("jurisdictionId", "=", resolved.jurisdictionId)
          .execute()
      : [];
    return {
      source: resolved?.source ?? "none",
      jurisdiction: entry ? toJurisdiction(entry, today) : null,
      reviewReason: resolved ? null : resolution.reviewReason,
      candidates: resolution.candidates.map((e) => toJurisdiction(e, today)),
      assignment:
        site.jurisdictionId && assignment?.evidenceKind && assignment.evidenceReference
          ? {
              evidenceKind: assignment.evidenceKind,
              evidenceReference: assignment.evidenceReference,
              evidenceNote: assignment.evidenceNote,
              assignedAt: assignment.assignedAt.toISOString(),
              assignedBy: assignment.name,
            }
          : null,
      profile: resolved
        ? {
            status: profileStatus(resolved.rules),
            ...profileDates(resolved.rules),
            unresolved: resolved.rules.profile?.unresolved ?? [],
            howToDecide: resolved.rules.applicability.howToDecide ?? null,
            requirements: authorityRequirements(resolved.rules),
            requirementsSource: requirementsSource(resolved.rules),
          }
        : null,
      identifiers: (resolved?.rules.identifiers ?? []).map((i) => {
        const value = values.find((v) => v.kind === i.key)?.value ?? null;
        const problem = !value ? (i.required ? "Required for filings with this authority" : null) : i.pattern && !new RegExp(i.pattern).test(value) ? "Not in the authority's format" : null;
        return { key: i.key, label: i.label, required: i.required, value, help: i.help ?? null, problem };
      }),
      scheduleNotice: resolved ? siteScheduleProblem(resolved.rules, resolved.authorityName, site) : null,
    };
  }

  app.get(
    "/sites/:id/jurisdiction",
    {
      config: { permission: "crm:read" },
      schema: { tags: ["filings"], summary: "Which authority the site reports to, why, and what it still needs", params, response: { 200: siteJurisdiction } },
    },
    async (req) => siteJurisdictionOf(req.requireAuth().organizationId, req.params.id),
  );

  app.put(
    "/sites/:id/jurisdiction",
    {
      config: { permission: "crm:write" },
      schema: {
        tags: ["filings"],
        summary: "Choose the site's authority by hand, with the evidence it is based on, or null to match it from the county",
        description:
          "Every choice is kept (append-only) with who made it and what it was based on. Affects inspections completed from now on and filings checked again; existing filings keep the authority they recorded.",
        params,
        body: siteJurisdictionInput,
        response: { 200: siteJurisdiction },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const body = req.body;
      if (body.jurisdictionId) {
        const j = await db.selectFrom("jurisdictions").select("id").where("id", "=", body.jurisdictionId).where("active", "=", true).executeTakeFirst();
        if (!j) throw unprocessable("jurisdictionId does not match an active authority");
        const entry = (await loadCatalog(db)).find((e) => e.jurisdiction.id === j.id);
        if (entry && isFictional(entry) && !(await fictionalAllowed(organizationId))) {
          throw unprocessable("jurisdictionId is the fictional example authority, which a real company cannot report to");
        }
      }
      await db.transaction().execute(async (trx) => {
        const site = await trx.selectFrom("sites").select("id").where("organizationId", "=", organizationId).where("id", "=", req.params.id).forUpdate().executeTakeFirst();
        if (!site) throw notFound("Site");
        const assignment = await trx
          .insertInto("siteAuthorityAssignments")
          .values({
            organizationId,
            siteId: site.id,
            jurisdictionId: body.jurisdictionId,
            evidenceKind: body.jurisdictionId ? body.evidenceKind! : null,
            evidenceReference: body.jurisdictionId ? body.evidenceReference! : null,
            evidenceNote: body.jurisdictionId ? (body.evidenceNote ?? null) : null,
            assignedBy: userId,
            assignedAt: now(),
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await trx.updateTable("sites").set({ jurisdictionId: body.jurisdictionId, authorityAssignmentId: assignment.id, updatedAt: now() }).where("organizationId", "=", organizationId).where("id", "=", site.id).execute();
        await audit(trx, req, { action: "site.jurisdiction_set", entityType: "site", entityId: site.id, changes: { ...body, assignmentId: assignment.id } });
      });
      return siteJurisdictionOf(organizationId, req.params.id);
    },
  );

  app.put(
    "/sites/:id/authority-identifiers/:key",
    {
      config: { permission: "crm:write" },
      schema: {
        tags: ["filings"],
        summary: "Record (or with null, remove) a number an authority gives this property, such as LCRA's OSSF application number",
        description: "Packages already built keep the value they were built with.",
        params: z.object({ id, key: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/) }),
        body: siteIdentifierInput,
        response: { 200: siteJurisdiction },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const { jurisdictionId, value, sourceNote } = req.body;
      const today = await organizationToday(db, organizationId, now());
      const entry = (await loadCatalog(db)).find((e) => e.jurisdiction.id === jurisdictionId);
      const rules = entry && (rulesetOn(entry, today) ?? entry.rulesets[0])?.rules;
      const declared = rules?.identifiers?.find((i) => i.key === req.params.key);
      if (!declared) throw unprocessable(`${entry?.jurisdiction.authorityName ?? "That authority"} does not use an identifier called ${req.params.key}`);
      if (value && declared.pattern && !new RegExp(declared.pattern).test(value)) throw unprocessable(`${declared.label} is not in the authority's format`);
      await db.transaction().execute(async (trx) => {
        const site = await trx.selectFrom("sites").select("id").where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
        if (!site) throw notFound("Site");
        const where = trx
          .deleteFrom("siteAuthorityIdentifiers")
          .where("organizationId", "=", organizationId)
          .where("siteId", "=", site.id)
          .where("jurisdictionId", "=", jurisdictionId)
          .where("kind", "=", req.params.key);
        if (value === null) await where.execute();
        else
          await trx
            .insertInto("siteAuthorityIdentifiers")
            .values({ organizationId, siteId: site.id, jurisdictionId, kind: req.params.key, value, sourceNote: sourceNote ?? null, updatedBy: userId, updatedAt: now() })
            .onConflict((oc) => oc.columns(["organizationId", "siteId", "jurisdictionId", "kind"]).doUpdateSet({ value, sourceNote: sourceNote ?? null, updatedBy: userId, updatedAt: now() }))
            .execute();
        await audit(trx, req, { action: "site.authority_identifier_set", entityType: "site", entityId: site.id, changes: { jurisdictionId, key: req.params.key, value, sourceNote } });
      });
      return siteJurisdictionOf(organizationId, req.params.id);
    },
  );

  const listQuery = (organizationId: string) =>
    db
      .selectFrom("filings as f")
      .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "f.siteId").onRef("s.organizationId", "=", "f.organizationId"))
      .innerJoin("customers as c", (j) => j.onRef("c.id", "=", "s.customerId").onRef("c.organizationId", "=", "s.organizationId"))
      .leftJoin("inspections as i", (j) => j.onRef("i.id", "=", "f.inspectionId").onRef("i.organizationId", "=", "f.organizationId"))
      .leftJoin("contracts as k", (j) => j.onRef("k.id", "=", "f.contractId").onRef("k.organizationId", "=", "f.organizationId"))
      .leftJoin("jurisdictions as jr", "jr.id", "f.jurisdictionId")
      .select((eb) => [
        "f.id",
        "f.kind",
        "f.deadlineBasis",
        "k.id as contractId",
        "k.startOn as contractStartOn",
        "k.endOn as contractEndOn",
        "k.planName as contractPlanName",
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
        "f.filingFeeCents",
        "f.lateFeeRuleCents",
        "f.lateFeeCents",
        "f.feeBasis",
        "i.id as inspectionId",
        "i.completedAt",
        "i.locationStatus",
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
    kind: r.kind,
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
    inspection: r.inspectionId ? { id: r.inspectionId, completedAt: r.completedAt?.toISOString() ?? null, locationStatus: (r.locationStatus as LocationStatus | null) ?? null } : null,
    contract: r.contractId && r.contractStartOn && r.contractEndOn && r.contractPlanName ? { id: r.contractId, startOn: r.contractStartOn, endOn: r.contractEndOn, planName: r.contractPlanName } : null,
    deadlineBasis: r.deadlineBasis,
    site: { id: r.siteId, addressLine1: r.addressLine1, city: r.city, permitNumber: r.permitNumber },
    customer: { id: r.customerId, displayName: r.displayName },
    jurisdiction: r.jurisdictionKey && r.authorityName && r.rulesetVersion ? { key: r.jurisdictionKey, authorityName: r.authorityName, rulesetVersion: r.rulesetVersion } : null,
    fees:
      r.filingFeeCents === null
        ? null
        : { filingFeeCents: r.filingFeeCents, lateFeeIfLateCents: r.lateFeeRuleCents ?? 0, lateFeeCents: r.lateFeeCents, totalCents: r.filingFeeCents + (r.lateFeeCents ?? 0), basis: r.feeBasis ?? "" },
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
          kind: z.enum(["inspection_report", "contract"]).optional(),
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
      if (req.query.kind) q = q.where("f.kind", "=", req.query.kind);
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

  const packageFileUrl = (organizationId: string, packageId: string, index: number) => signer.url(organizationId, `${packageId}.${index}`, now().getTime(), "package-files");

  async function detail(organizationId: string, filingId: string): Promise<FilingDetail> {
    const row = await listQuery(organizationId).where("f.id", "=", filingId).executeTakeFirst();
    if (!row) throw notFound("Filing");
    const today = await organizationToday(db, organizationId, now());
    const f = await db
      .selectFrom("filings as f")
      .leftJoin("jurisdictionRulesets as r", "r.id", "f.rulesetId")
      .select(["f.stateMachineVersion", "f.kind", "f.submissionNo", "f.methodVersion", "f.templateId", "f.proof", "f.confirmationNote", "f.confirmationEvidence", "f.rejectionReason", "f.reportId", "f.inspectionId", "r.rules"])
      .where("f.organizationId", "=", organizationId)
      .where("f.id", "=", filingId)
      .executeTakeFirstOrThrow();
    const [attempts, packages, reports] = await Promise.all([
      db
        .selectFrom("filingAttempts")
        .select(["attemptNo", "submissionNo", "method", "status", "startedAt", "finishedAt", "error", "recipient", "packageId", "response"])
        .where("organizationId", "=", organizationId)
        .where("filingId", "=", filingId)
        .orderBy("attemptNo", "desc")
        .execute(),
      db
        .selectFrom("submissionPackages")
        .select(["id", "submissionNo", "method", "recipient", "subject", "body", "fields", "documents", "manifestSha256", "createdAt"])
        .where("organizationId", "=", organizationId)
        .where("filingId", "=", filingId)
        .orderBy("submissionNo", "desc")
        .execute(),
      f.inspectionId
        ? db
            .selectFrom("reports")
            .select(["id", "version", "sha256", "supersedesReportId", "correctionReason", "generatedAt"])
            .where("organizationId", "=", organizationId)
            .where("inspectionId", "=", f.inspectionId)
            .where("audience", "=", "authority")
            .orderBy("version", "desc")
            .execute()
        : [],
    ]);
    const rules = f.rules as RulesetRules | null;
    const current = packages.find((p) => p.submissionNo === f.submissionNo);
    const currentDocs = (current?.documents as PackageDocument[] | undefined) ?? [];
    const layout = rules && exportLayoutFor(rules, f.kind);
    const csvIndex = currentDocs.findIndex((d) => d.role === "authority_csv");
    const pkg: FilingDetail["package"] = rules
      ? {
          destination: current?.recipient ?? rules.submission.email?.to ?? null,
          portalUrl: rules.submission.portalUrl,
          subject: current?.subject ?? null,
          // The filed document itself (report or contract), not the cover sheet.
          reportUrl: current
            ? currentDocs.length
              ? packageFileUrl(organizationId, current.id, Math.max(0, currentDocs.findIndex((d) => d.role !== "cover_sheet" && d.role !== "authority_csv")))
              : null
            : f.reportId
              ? signer.url(organizationId, f.reportId, now().getTime(), "report-files")
              : null,
          fallback: rules.submission.fallback,
          csvExport: layout ? { formReference: layout.formReference } : null,
          csvUrl: current && csvIndex >= 0 ? packageFileUrl(organizationId, current.id, csvIndex) : null,
        }
      : null;
    return {
      ...toItem(row, today),
      stateMachineVersion: f.stateMachineVersion,
      submissionNo: f.submissionNo,
      methodVersion: f.methodVersion,
      templateId: f.templateId,
      proof: (f.proof as FilingProof | null) ?? null,
      confirmationNote: f.confirmationNote,
      confirmationEvidence: (f.confirmationEvidence as FilingDetail["confirmationEvidence"]) ?? null,
      rejectionReason: f.rejectionReason,
      package: pkg,
      attempts: attempts.map((a) => ({
        attemptNo: a.attemptNo,
        submissionNo: a.submissionNo,
        method: a.method,
        status: a.status,
        startedAt: a.startedAt.toISOString(),
        finishedAt: a.finishedAt?.toISOString() ?? null,
        error: a.error,
        recipient: a.recipient,
        packageId: a.packageId,
        response: (a.response as Record<string, unknown>) ?? {},
      })),
      packages: packages.map((p) => ({
        id: p.id,
        submissionNo: p.submissionNo,
        method: p.method,
        recipient: p.recipient,
        subject: p.subject,
        body: p.body,
        fields: p.fields as FilingDetail["packages"][number]["fields"],
        documents: (p.documents as PackageDocument[]).map(({ storageKey: _k, ...d }, i) => ({ ...d, url: packageFileUrl(organizationId, p.id, i) })),
        manifestSha256: p.manifestSha256,
        createdAt: p.createdAt.toISOString(),
      })),
      profile: rules
        ? { status: profileStatus(rules), ...profileDates(rules), unresolved: rules.profile?.unresolved ?? [], confirmationMode: rules.confirmation.mode, confirmationNote: rules.confirmation.note ?? null, verified: verifiedWith(rules) }
        : null,
      reports: reports.map((r) => ({ ...r, generatedAt: r.generatedAt.toISOString() })),
    };
  }

  app.get(
    "/package-files/:file",
    {
      // Authorized by the signature, like /report-files; bound to the package's organization.
      config: { public: true },
      schema: {
        tags: ["filings"],
        summary: "Download one document of a submission package through a signed link",
        params: z.object({ file: z.string().regex(/^[0-9a-f-]{36}\.\d{1,2}$/) }),
        querystring: z.object({ exp: z.coerce.number().int(), sig: z.string().max(100) }),
      },
    },
    async (req, reply) => {
      const [packageId, index] = req.params.file.split(".") as [string, string];
      const row = await db.selectFrom("submissionPackages").select(["id", "organizationId", "documents"]).where("id", "=", packageId).executeTakeFirst();
      if (!row || !signer.verify(row.organizationId, req.params.file, req.query.exp, req.query.sig, now().getTime(), "package-files")) throw notFound("File");
      const doc = (row.documents as PackageDocument[])[Number(index)];
      const data = doc && (await readForDownload(db, compliance.store, doc.storageKey));
      if (!doc || !data) throw notFound("File");
      return reply.type(doc.contentType).header("content-disposition", `inline; filename="${doc.filename}"`).header("x-content-type-options", "nosniff").send(data);
    },
  );

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

  /** Checks a filing again after an action put it back to pending, then returns it. */
  async function prepared(req: FastifyRequest, filingId: string) {
    const { organizationId, userId } = req.requireAuth();
    await prepareFilingById(ctx(), organizationId, filingId, userId);
    return detail(organizationId, filingId);
  }

  const action = (summary: string, body?: z.ZodObject) => ({
    config: { permission: "filings:write" as const },
    schema: { tags: ["filings"], summary, params, ...(body ? { body } : {}), response: { 200: filingDetail } },
  });

  app.post("/filings/:id/submit", action("Send a ready email filing now"), async (req) => act(req, req.params.id, "submitted", (trx, f, a) => submitNow(trx, ctx(), f, a)));

  app.post("/filings/:id/retry", action("Retry a failed email filing now"), async (req) => act(req, req.params.id, "retried", (trx, f, a) => retryFiling(trx, ctx(), f, a)));

  app.post("/filings/:id/resubmit", action("Submit again after the authority rejected it: checked again, with a new package"), async (req) => {
    await act(req, req.params.id, "resubmitted", (trx, f, a) => resubmitFiling(trx, ctx(), f, a));
    return prepared(req, req.params.id);
  });

  app.post(
    "/filings/:id/correct",
    action("Correct a rejected inspection filing: a new authority report version linked to the old one, then a new submission", filingCorrectInput),
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const body = filingCorrectInput.parse(req.body);
      const f = await loadFiling(db, organizationId, req.params.id);
      if (!f) throw notFound("Filing");
      let report;
      try {
        report = await correctFiling(ctx(), f, { organizationId, filingId: f.id, actorUserId: userId, at: now(), reason: body.reason, amendments: body.amendments });
      } catch (err) {
        if (err instanceof FilingStateError) throw new HttpError(409, "invalid_transition", err.message);
        if (err instanceof ReportCorrectionError) throw unprocessable(err.message);
        throw err;
      }
      await act(req, f.id, "corrected", (trx, locked, a) => resubmitFiling(trx, ctx(), locked, a), { reason: body.reason, amendments: body.amendments, reportId: report.reportId, version: report.version });
      return prepared(req, f.id);
    },
  );

  app.post("/filings/:id/manual", action("File this one by hand (portal, mail or counter) instead of by email"), async (req) =>
    act(req, req.params.id, "switched_manual", (trx, f, a) => useManualFiling(trx, f, a)),
  );

  app.post("/filings/:id/csv-export", action("File this one by uploading the authority's CSV instead: checked again, with a new package that carries the CSV"), async (req) => {
    await act(req, req.params.id, "switched_csv_export", (trx, f, a) => useCsvExport(trx, f, a));
    return prepared(req, req.params.id);
  });

  app.post("/filings/:id/mark-sent", action("Record that it was filed by hand or its CSV uploaded", filingManualSentInput), async (req) => {
    const me = await db.selectFrom("users").select("name").where("id", "=", req.requireAuth().userId).executeTakeFirstOrThrow();
    const body = filingManualSentInput.parse(req.body);
    return act(req, req.params.id, "marked_sent", (trx, f, a) => markFiledManually(trx, f, { ...a, reference: body.reference ?? null, note: body.note ?? null, actorName: me.name }), body);
  });

  app.post("/filings/:id/confirm", action("Record the authority's confirmation and its reference", filingConfirmInput), async (req) => {
    const body = filingConfirmInput.parse(req.body);
    return act(req, req.params.id, "confirmed", (trx, f, a) => confirmFiling(trx, f, { ...a, reference: body.reference, note: body.note ?? null, evidence: body.evidence ?? null }), body);
  });

  app.post("/filings/:id/reject", action("Record that the authority rejected it", filingRejectInput), async (req) => {
    const body = filingRejectInput.parse(req.body);
    return act(req, req.params.id, "rejected", (trx, f, a) => rejectFiling(trx, f, { ...a, reason: body.reason }), body);
  });

  app.post("/filings/:id/recheck", action("Check a filing that needs review again, after fixing the cause"), async (req) => {
    await act(req, req.params.id, "rechecked", (trx, f, a) => recheckFiling(trx, f, a));
    return prepared(req, req.params.id);
  });
};
