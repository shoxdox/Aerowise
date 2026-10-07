import { createHash } from "node:crypto";
import { openContractFiling, refreshFiling, updateContractFilingDeadline, contractBasisOf, customerCopy, SignatureError, signatureRequiredForInspection, UNSIGNED_CUSTOMER_COPY, signAuthorityReport, signingPreview, type ComplianceContext } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import {
  addDays,
  classifyInput,
  contractDiscontinuation,
  contractFilingBasis,
  contractFilingBasisInput,
  contractProviderInput,
  discontinuationNoticeInput,
  credential,
  credentialInput,
  credentialPatch,
  customerDelivery,
  id,
  officeServiceRequestInput,
  reportSigning,
  responseInput,
  serviceRequestDetail,
  signReportInput,
  type ReportSigning,
  type Credential,
  type ServiceRequestDetail,
} from "@aerowise/domain";
import { billingEmail, queueSms, SEND_CUSTOMER_REPORT } from "@aerowise/tasks";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { notFound, unprocessable } from "../lib/errors.ts";
import type { UrlSigner } from "../storage/signed-urls.ts";
import { readForDownload } from "../lib/demo.ts";

const params = z.object({ id });

type DeliveryRow = { id: string; documentKind: "inspection_report" | "signed_agreement"; channel: "email"; recipient: string; documentSha256: string; status: "accepted" | "failed"; attemptedAt: Date; error: string | null; transportResponse: unknown };
/** A customer delivery for the screen, saying whether an accepted send stayed in the local test outbox. */
const deliveryView = ({ transportResponse, ...d }: DeliveryRow) => ({
  ...d,
  attemptedAt: d.attemptedAt.toISOString(),
  delivery: d.status !== "accepted" ? null : (transportResponse as { transport?: string } | null)?.transport === "outbox" ? ("outbox" as const) : ("provider" as const),
});

/**
 * The written notice a provider owes when a contract ends (30 TAC 285.7(d)(3)): to the
 * permitting authority and the manufacturer, and to the owner too when the provider ends
 * it, at least 30 days before service stops.
 */
export function discontinuationOf(
  c: { discontinuedBy: "provider" | "owner" | null; serviceEndsOn: string | null; noticeSentOn: string | null; noticeNote: string | null },
  authorityName: string | null,
) {
  const recipients = [authorityName ?? "the permitting authority", "the system's manufacturer"];
  if (c.discontinuedBy !== "owner") recipients.push(c.discontinuedBy === "provider" ? "the owner" : "the owner, if the provider ended the contract");
  return {
    discontinuedBy: c.discontinuedBy,
    serviceEndsOn: c.serviceEndsOn,
    noticeDueOn: c.serviceEndsOn ? addDays(c.serviceEndsOn, -30) : null,
    recipients,
    noticeSentOn: c.noticeSentOn,
    noticeNote: c.noticeNote,
  };
}
const MAX_CONTRACT_BYTES = 10 * 1024 * 1024;

/**
 * What a filing needs besides the inspection: the provider's licenses, the review of
 * complaints and monitoring notices, signed contracts uploaded by the office, and the
 * record of what was sent to customers (kept apart from what was sent to authorities).
 */
export const readinessRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; signer: UrlSigner; compliance: Omit<ComplianceContext, "db" | "now"> }> = async (
  app,
  { db, now, signer, compliance },
) => {
  const ctx = (): ComplianceContext => ({ ...compliance, db, now });

  // ---- Credentials ----

  async function listCredentials(organizationId: string): Promise<Credential[]> {
    const [rows, org] = await Promise.all([
      db.selectFrom("providerCredentials").selectAll().where("organizationId", "=", organizationId).orderBy("holderName").orderBy("kind").execute(),
      db.selectFrom("organizations").select("responsibleCredentialId").where("id", "=", organizationId).executeTakeFirstOrThrow(),
    ]);
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      holderName: r.holderName,
      kind: r.kind,
      number: r.number,
      expiresOn: r.expiresOn,
      verifiedOn: r.verifiedOn,
      verificationSource: r.verificationSource,
      active: r.active,
      responsible: org.responsibleCredentialId === r.id,
    }));
  }

  async function checkUser(organizationId: string, userId: string | null | undefined) {
    if (!userId) return;
    const m = await db.selectFrom("memberships").select("userId").where("organizationId", "=", organizationId).where("userId", "=", userId).executeTakeFirst();
    if (!m) throw unprocessable("userId is not a member of this organization");
  }

  const duplicate = (err: unknown) => {
    if ((err as { code?: string }).code === "23505") throw unprocessable("This license number is already on file for that kind of credential");
    throw err;
  };

  app.get(
    "/credentials",
    {
      config: { permission: "filings:read" },
      schema: { tags: ["readiness"], summary: "Licenses and registrations held by the provider's people", response: { 200: z.object({ items: z.array(credential) }) } },
    },
    async (req) => ({ items: await listCredentials(req.requireAuth().organizationId) }),
  );

  app.post(
    "/credentials",
    {
      config: { permission: "org:manage" },
      schema: { tags: ["readiness"], summary: "Add a license or registration", body: credentialInput, response: { 201: credential } },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      await checkUser(organizationId, req.body.userId);
      const row = await db
        .transaction()
        .execute(async (trx) => {
          const c = await trx
            .insertInto("providerCredentials")
            .values({
              organizationId,
              userId: req.body.userId ?? null,
              holderName: req.body.holderName,
              kind: req.body.kind,
              number: req.body.number,
              expiresOn: req.body.expiresOn ?? null,
              verifiedOn: req.body.verifiedOn ?? null,
              verificationSource: req.body.verificationSource ?? null,
              active: req.body.active ?? true,
              updatedAt: now(),
            })
            .returning("id")
            .executeTakeFirstOrThrow();
          await audit(trx, req, { action: "credential.created", entityType: "credential", entityId: c.id, changes: req.body });
          return c;
        })
        .catch(duplicate);
      return reply.status(201).send((await listCredentials(organizationId)).find((c) => c.id === row.id)!);
    },
  );

  app.patch(
    "/credentials/:id",
    {
      config: { permission: "org:manage" },
      schema: { tags: ["readiness"], summary: "Change a license or registration", params, body: credentialPatch, response: { 200: credential } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await checkUser(organizationId, req.body.userId);
      await db
        .transaction()
        .execute(async (trx) => {
          const res = await trx
            .updateTable("providerCredentials")
            .set({ ...req.body, updatedAt: now() })
            .where("organizationId", "=", organizationId)
            .where("id", "=", req.params.id)
            .executeTakeFirst();
          if (Number(res.numUpdatedRows) !== 1) throw notFound("Credential");
          await audit(trx, req, { action: "credential.updated", entityType: "credential", entityId: req.params.id, changes: req.body });
        })
        .catch(duplicate);
      return (await listCredentials(organizationId)).find((c) => c.id === req.params.id)!;
    },
  );

  app.put(
    "/settings/responsible-provider",
    {
      config: { permission: "org:manage" },
      schema: {
        tags: ["readiness"],
        summary: "Choose the licensed maintenance provider responsible for filings (a TCEQ MP credential), or null",
        body: z.object({ credentialId: id.nullable() }),
        response: { 200: z.object({ items: z.array(credential) }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      if (req.body.credentialId) {
        const c = await db.selectFrom("providerCredentials").select(["kind", "active"]).where("organizationId", "=", organizationId).where("id", "=", req.body.credentialId).executeTakeFirst();
        if (!c) throw notFound("Credential");
        if (c.kind !== "tceq_maintenance_provider") throw unprocessable("The responsible provider must hold a TCEQ maintenance provider (MP) license");
        if (!c.active) throw unprocessable("That credential is inactive");
      }
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("organizations").set({ responsibleCredentialId: req.body.credentialId }).where("id", "=", organizationId).execute();
        await audit(trx, req, { action: "organization.responsible_provider_set", entityType: "organization", entityId: organizationId, changes: req.body });
      });
      return { items: await listCredentials(organizationId) };
    },
  );

  // ---- Complaints and monitoring notices ----

  const requestColumns = [
    "id",
    "siteId",
    "customerId",
    "kind",
    "description",
    "source",
    "receivedAt",
    "status",
    "reportClassification",
    "classificationNote",
    "classifiedAt",
    "responseAction",
    "respondedAt",
    "responseJobId",
    "responseOutcome",
  ] as const;

  async function loadRequest(organizationId: string, requestId: string): Promise<ServiceRequestDetail> {
    const r = await db.selectFrom("serviceRequests").select(requestColumns).where("organizationId", "=", organizationId).where("id", "=", requestId).executeTakeFirst();
    if (!r) throw notFound("Service request");
    return toRequest(r);
  }

  const toRequest = (r: { [K in (typeof requestColumns)[number]]: unknown }): ServiceRequestDetail =>
    ({
      ...r,
      classification: r.reportClassification,
      receivedAt: (r.receivedAt as Date).toISOString(),
      classifiedAt: (r.classifiedAt as Date | null)?.toISOString() ?? null,
      respondedAt: (r.respondedAt as Date | null)?.toISOString() ?? null,
    }) as ServiceRequestDetail;

  app.get(
    "/sites/:id/service-requests",
    {
      config: { permission: "crm:read" },
      schema: {
        tags: ["readiness"],
        summary: "The site's service requests with their reporting review and response, newest first",
        params,
        response: { 200: z.object({ items: z.array(serviceRequestDetail) }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const site = await db.selectFrom("sites").select("id").where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
      if (!site) throw notFound("Site");
      const rows = await db.selectFrom("serviceRequests").select(requestColumns).where("organizationId", "=", organizationId).where("siteId", "=", site.id).orderBy("receivedAt", "desc").execute();
      return { items: rows.map(toRequest) };
    },
  );

  app.post(
    "/service-requests",
    {
      config: { permission: "crm:write" },
      schema: {
        tags: ["readiness"],
        summary: "Log a call, text or monitoring alert the office received",
        body: officeServiceRequestInput,
        response: { 201: serviceRequestDetail },
      },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const site = await db.selectFrom("sites").select(["id", "customerId"]).where("organizationId", "=", organizationId).where("id", "=", req.body.siteId).executeTakeFirst();
      if (!site) throw notFound("Site");
      const receivedAt = req.body.receivedAt ? new Date(req.body.receivedAt) : now();
      if (receivedAt.getTime() > now().getTime() + 60_000) throw unprocessable("receivedAt is in the future");
      const created = await db.transaction().execute(async (trx) => {
        const r = await trx
          .insertInto("serviceRequests")
          .values({
            organizationId,
            customerId: site.customerId,
            siteId: site.id,
            kind: req.body.kind,
            description: req.body.description,
            contactPhone: req.body.contactPhone ?? null,
            portalLinkId: null,
            source: "office",
            receivedAt,
            updatedAt: now(),
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "service_request.logged", entityType: "service_request", entityId: r.id, changes: req.body });
        return r;
      });
      return reply.status(201).send(await loadRequest(organizationId, created.id));
    },
  );

  /** Inspection filings at the site not yet sent, checked again now that a request's review or response changed. */
  // ---- Maintenance provider signature (30 TAC 285.7(b)(3)) ----

  async function signingState(organizationId: string, inspectionId: string, userId: string): Promise<ReportSigning> {
    const insp = await db.selectFrom("inspections").select("id").where("organizationId", "=", organizationId).where("id", "=", inspectionId).executeTakeFirst();
    if (!insp) throw notFound("Inspection not found");
    let preview;
    try {
      preview = await signingPreview(db, { organizationId, inspectionId, userId, at: now() });
    } catch (err) {
      if (err instanceof SignatureError) throw notFound(err.message);
      throw err;
    }
    const s = preview.existing;
    const required = await signatureRequiredForInspection(db, organizationId, inspectionId);
    const customer = await db
      .selectFrom("reports as r")
      .leftJoin("reportSignatures as rs", (j) => j.onRef("rs.reportId", "=", "r.id").onRef("rs.organizationId", "=", "r.organizationId"))
      .select(["r.id", "r.version", "rs.id as signatureId"])
      .where("r.organizationId", "=", organizationId)
      .where("r.inspectionId", "=", inspectionId)
      .where("r.audience", "=", "customer")
      .orderBy("r.version", "desc")
      .executeTakeFirst();
    return {
      reportId: preview.report.id,
      version: preview.report.version,
      statement: s?.statement ?? preview.statement,
      holderName: preview.holderName,
      problems: preview.problems,
      required,
      provider: preview.provider ? { name: preview.provider.holderName, number: preview.provider.number, source: preview.provider.source } : null,
      delegationRequired: Boolean(preview.delegatedFrom),
      customerCopy: customer ? { reportId: customer.id, version: customer.version, signed: Boolean(customer.signatureId) } : null,
      signature: s
        ? {
            signedByName: s.signedByName,
            typedName: s.typedName,
            licenseNumber: s.licenseNumber,
            delegationNote: s.delegationNote,
            statement: s.statement,
            signedAt: s.signedAt.toISOString(),
            sha256: s.sha256,
          }
        : null,
    };
  }

  app.get(
    "/inspections/:id/signature",
    {
      config: { permission: "filings:read" },
      schema: {
        tags: ["readiness"],
        summary: "The maintenance provider's signature on the latest authority report, or what signing it would say and what stops you",
        params,
        response: { 200: reportSigning },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      return signingState(organizationId, req.params.id, userId);
    },
  );

  app.post(
    "/inspections/:id/signature",
    {
      config: { permission: "reports:sign" },
      schema: {
        tags: ["readiness"],
        summary: "Sign the latest authority report as the licensed maintenance provider (30 TAC 285.7(b)(3))",
        description:
          "Only someone with their own active, checked MP license can sign, by typing their name as it appears on the license. The MP named on the site's contract (else the organization's responsible MP) signs by default; anyone else must describe the documented delegation and supervision that lets them sign for that MP. The authority and customer copies are signed together: the filing sends the signed authority copy and the customer gets the signed customer copy. A later report version needs its own signature.",
        params,
        body: signReportInput,
        response: { 200: reportSigning },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      await signingState(organizationId, req.params.id, userId);
      let signed;
      try {
        signed = await signAuthorityReport(
          { db, store: compliance.store },
          { organizationId, inspectionId: req.params.id, userId, typedName: req.body.typedName, delegationNote: req.body.delegationNote ?? null, at: now() },
        );
      } catch (err) {
        if (err instanceof SignatureError) throw unprocessable(err.message);
        throw err;
      }
      await audit(db, req, { action: "report.signed", entityType: "inspection", entityId: req.params.id, changes: { typedName: req.body.typedName, delegationNote: req.body.delegationNote ?? null } });
      // Where the customer's copy waited for this signature, tell them it is ready now.
      if (signed.customerReportId) {
        const r = await db.selectFrom("reports as r").innerJoin("sites as s", (j) => j.onRef("s.id", "=", "r.siteId").onRef("s.organizationId", "=", "r.organizationId")).select(["r.id", "r.siteId", "s.customerId"]).where("r.id", "=", signed.customerReportId).executeTakeFirstOrThrow();
        await queueSms(db, organizationId, { kind: "report_ready", customerId: r.customerId, siteId: r.siteId, relatedType: "report", relatedId: r.id, dedupeKey: `report_ready:${req.params.id}:signed` }, now());
      }
      const filing = await db.selectFrom("filings").select("id").where("organizationId", "=", organizationId).where("inspectionId", "=", req.params.id).executeTakeFirst();
      if (filing) await refreshFiling(ctx(), organizationId, filing.id, userId);
      return signingState(organizationId, req.params.id, userId);
    },
  );

  async function recheckHeldFilings(organizationId: string, siteId: string, actorUserId: string) {
    const held = await db
      .selectFrom("filings")
      .select("id")
      .where("organizationId", "=", organizationId)
      .where("siteId", "=", siteId)
      .where("kind", "=", "inspection_report")
      .where("status", "in", ["pending", "needs_review", "ready"])
      .execute();
    for (const f of held) await refreshFiling(ctx(), organizationId, f.id, actorUserId);
  }

  app.post(
    "/service-requests/:id/classify",
    {
      config: { permission: "filings:write" },
      schema: {
        tags: ["readiness"],
        summary: "Decide whether the authority must hear about this request: an owner complaint, a monitoring notice, or not reportable",
        description: "Nothing is classified automatically. Reportable requests and their responses go on the next authority report for the site.",
        params,
        body: classifyInput,
        response: { 200: serviceRequestDetail },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const r = await trx.selectFrom("serviceRequests").select(["id", "siteId"]).where("organizationId", "=", organizationId).where("id", "=", req.params.id).forUpdate().executeTakeFirst();
        if (!r) throw notFound("Service request");
        await trx
          .updateTable("serviceRequests")
          .set({ reportClassification: req.body.classification, classificationNote: req.body.note ?? null, classifiedBy: userId, classifiedAt: now(), updatedAt: now() })
          .where("id", "=", r.id)
          .execute();
        await audit(trx, req, { action: "service_request.classified", entityType: "service_request", entityId: r.id, changes: req.body });
      });
      const detail = await loadRequest(organizationId, req.params.id);
      await recheckHeldFilings(organizationId, detail.siteId, userId);
      return detail;
    },
  );

  app.post(
    "/service-requests/:id/response",
    {
      config: { permission: "filings:write" },
      schema: {
        tags: ["readiness"],
        summary: "Record how and when the provider responded (a visit, a call) and whether the problem is resolved or still outstanding, as the authority report will print it",
        params,
        body: responseInput,
        response: { 200: serviceRequestDetail },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const respondedAt = new Date(req.body.respondedAt);
      await db.transaction().execute(async (trx) => {
        const r = await trx.selectFrom("serviceRequests").select(["id", "siteId", "receivedAt"]).where("organizationId", "=", organizationId).where("id", "=", req.params.id).forUpdate().executeTakeFirst();
        if (!r) throw notFound("Service request");
        if (respondedAt < r.receivedAt) throw unprocessable("The response cannot be before the request was received");
        if (req.body.jobId) {
          const job = await trx.selectFrom("jobs as j").innerJoin("serviceObligations as o", "o.id", "j.obligationId").select("o.siteId").where("j.organizationId", "=", organizationId).where("j.id", "=", req.body.jobId).executeTakeFirst();
          if (!job) throw unprocessable("jobId does not match a job");
          if (job.siteId !== r.siteId) throw unprocessable("That job is at a different site");
        }
        await trx
          .updateTable("serviceRequests")
          .set({ responseAction: req.body.action, respondedAt, responseJobId: req.body.jobId ?? null, responseOutcome: req.body.outcome, responseRecordedBy: userId, updatedAt: now() })
          .where("id", "=", r.id)
          .execute();
        await audit(trx, req, { action: "service_request.responded", entityType: "service_request", entityId: r.id, changes: req.body });
      });
      const detail = await loadRequest(organizationId, req.params.id);
      await recheckHeldFilings(organizationId, detail.siteId, userId);
      return detail;
    },
  );

  // ---- Signed contracts uploaded by the office ----

  app.post(
    "/contracts/:id/document",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["readiness"],
        summary: "Upload the signed contract (PDF, base64 in JSON) for a contract signed outside Aerowise",
        description: "Uploads are kept as versions and never replaced. A contract filing waiting for the signed copy is checked again.",
        params,
        body: z.object({ filename: z.string().trim().min(1).max(200), contentBase64: z.string().min(8).max(Math.ceil((MAX_CONTRACT_BYTES * 4) / 3) + 8), signedOn: z.iso.date().nullish() }),
        response: { 201: z.object({ id, sha256: z.string(), byteSize: z.number().int(), filingId: id.nullable() }) },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const contract = await db.selectFrom("contracts").select(["id", "siteId"]).where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
      if (!contract) throw notFound("Contract");
      const bytes = Buffer.from(req.body.contentBase64, "base64");
      if (bytes.length > MAX_CONTRACT_BYTES) throw unprocessable("The file is larger than 10 MB");
      if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw unprocessable("Upload the signed contract as a PDF");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const docId = crypto.randomUUID();
      const storageKey = `${organizationId}/contracts/${contract.id}/${docId}.pdf`;
      await compliance.store.put(storageKey, bytes, "application/pdf");
      const filename = req.body.filename.replace(/[^\w. -]/g, "_");
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("contractDocuments")
          .values({ id: docId, organizationId, contractId: contract.id, filename, storageKey, byteSize: bytes.length, sha256, signedOn: req.body.signedOn ?? null, uploadedBy: userId })
          .execute();
        await audit(trx, req, { action: "contract.document_uploaded", entityType: "contract", entityId: contract.id, changes: { documentId: docId, filename, sha256, signedOn: req.body.signedOn ?? null } });
        await openContractFiling(trx, { organizationId, contractId: contract.id, actorUserId: userId, at: now() });
      });
      const filing = await db.selectFrom("filings").select(["id", "status", "signedDocumentId", "contractDocumentId"]).where("organizationId", "=", organizationId).where("contractId", "=", contract.id).executeTakeFirst();
      if (filing) await refreshFiling(ctx(), organizationId, filing.id, userId);
      return reply.status(201).send({ id: docId, sha256, byteSize: bytes.length, filingId: filing?.id ?? null });
    },
  );

  app.put(
    "/contracts/:id/filing-basis",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["readiness"],
        summary: "Record which 30 TAC 285.7 deadline the contract's filing has: initial policy, first contract after it, renewal or replacement",
        description: "A filing that has not gone out gets the new deadline. One already sent keeps the deadline it was sent against.",
        params,
        body: contractFilingBasisInput,
        response: { 200: contractFilingBasis },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      const basisOn = req.body.basis === "initial_policy" ? null : (req.body.basisOn ?? null);
      await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("contracts")
          .set({ filingBasis: req.body.basis, filingBasisOn: basisOn, filingBasisNote: req.body.note ?? null, filingBasisSetBy: userId, filingBasisSetAt: at, updatedAt: at })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .returning("id")
          .executeTakeFirst();
        if (!updated) throw notFound("Contract");
        await audit(trx, req, { action: "contract.filing_basis_set", entityType: "contract", entityId: updated.id, changes: { basis: req.body.basis, basisOn, note: req.body.note ?? null } });
        await updateContractFilingDeadline(trx, { organizationId, contractId: updated.id, actorUserId: userId, at });
      });
      return { basis: req.body.basis, basisOn, note: req.body.note ?? null, derived: false };
    },
  );

  async function contractProviderOf(organizationId: string, credentialId: string | null) {
    const org = await db.selectFrom("organizations").select("responsibleCredentialId").where("id", "=", organizationId).executeTakeFirstOrThrow();
    const chosen = credentialId ?? org.responsibleCredentialId;
    if (!chosen) return null;
    const c = await db.selectFrom("providerCredentials").select(["id", "holderName", "number"]).where("organizationId", "=", organizationId).where("id", "=", chosen).executeTakeFirstOrThrow();
    return { credentialId: c.id, name: c.holderName, number: c.number, source: credentialId ? ("contract" as const) : ("organization" as const) };
  }

  app.put(
    "/contracts/:id/provider",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["readiness"],
        summary: "Record the maintenance provider named on the contract, who signs the site's reports by default",
        description: "Must be an MP license on file. Null falls back to the organization's responsible MP. Anyone else who signs needs a documented delegation and supervision.",
        params,
        body: contractProviderInput,
        response: { 200: z.object({ provider: z.object({ credentialId: id, name: z.string(), number: z.string(), source: z.enum(["contract", "organization"]) }).nullable() }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const credentialId = req.body.credentialId;
      if (credentialId) {
        const c = await db.selectFrom("providerCredentials").select("kind").where("organizationId", "=", organizationId).where("id", "=", credentialId).executeTakeFirst();
        if (!c) throw notFound("Credential");
        if (c.kind !== "tceq_maintenance_provider") throw unprocessable("Only a TCEQ maintenance provider (MP) license can be named on a contract");
      }
      await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("contracts")
          .set({ providerCredentialId: credentialId, updatedAt: now() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .returning("id")
          .executeTakeFirst();
        if (!updated) throw notFound("Contract");
        await audit(trx, req, { action: "contract.provider_set", entityType: "contract", entityId: updated.id, changes: { credentialId } });
      });
      return { provider: await contractProviderOf(organizationId, credentialId) };
    },
  );

  app.post(
    "/contracts/:id/discontinuation-notice",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["readiness"],
        summary: "Record the written notice that service is ending, sent to the authority and the manufacturer (and the owner, when the provider ends it)",
        description: "30 TAC 285.7(d)(3)(A) and (B): at least 30 days before service stops. Aerowise records the notice; it does not send it.",
        params,
        body: discontinuationNoticeInput,
        response: { 200: contractDiscontinuation },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const c = await db.transaction().execute(async (trx) => {
        const row = await trx
          .updateTable("contracts")
          .set({ noticeSentOn: req.body.sentOn, noticeNote: req.body.note, noticeRecordedBy: userId, updatedAt: now() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .where((eb) => eb.or([eb("status", "=", "cancelled"), eb("serviceEndsOn", "is not", null)]))
          .where("noticeSentOn", "is", null)
          .returning(["id", "discontinuedBy", "serviceEndsOn", "noticeSentOn", "noticeNote"])
          .executeTakeFirst();
        if (!row) {
          const exists = await trx.selectFrom("contracts").select(["status", "noticeSentOn"]).where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
          if (!exists) throw notFound("Contract");
          throw unprocessable(exists.noticeSentOn ? "The notice is already recorded" : "Only a contract that is ending or cancelled has a discontinuation notice");
        }
        await audit(trx, req, { action: "contract.discontinuation_notice_recorded", entityType: "contract", entityId: row.id, changes: req.body });
        return row;
      });
      const filing = await db
        .selectFrom("filings as f")
        .leftJoin("jurisdictions as j", "j.id", "f.jurisdictionId")
        .select("j.authorityName")
        .where("f.organizationId", "=", organizationId)
        .where("f.contractId", "=", c.id)
        .executeTakeFirst();
      return discontinuationOf(c, filing?.authorityName ?? null);
    },
  );

  app.get(
    "/contracts/:id/filing-status",
    {
      config: { permission: "contracts:read" },
      schema: {
        tags: ["readiness"],
        summary: "Where a contract stands: signed, customer copy emailed, authority filing sent, authority acknowledged — each separately",
        params,
        response: {
          200: z.object({
            signedAt: z.iso.datetime({ offset: true }).nullable(),
            signedDocumentSha256: z.string().nullable(),
            uploadedDocuments: z.array(z.object({ id, filename: z.string(), sha256: z.string(), signedOn: z.iso.date().nullable(), uploadedAt: z.iso.datetime({ offset: true }), url: z.string() })),
            customerCopy: z.array(customerDelivery),
            authority: z
              .object({
                filingId: id,
                status: z.string(),
                deadlineOn: z.iso.date().nullable(),
                deadlineBasis: z.string().nullable(),
                sentAt: z.iso.datetime({ offset: true }).nullable(),
                confirmedAt: z.iso.datetime({ offset: true }).nullable(),
                reviewReason: z.string().nullable(),
              })
              .nullable(),
            /** Which 30 TAC 285.7 deadline the contract filing has. */
            basis: contractFilingBasis,
            /** Set once the contract is cancelled: the notice the provider owes before service stops. */
            discontinuation: contractDiscontinuation.nullable(),
            /** The MP who signs this contract's reports by default: named on the contract, else the organization's responsible MP. */
            provider: z.object({ credentialId: id, name: z.string(), number: z.string(), source: z.enum(["contract", "organization"]) }).nullable(),
          }),
        },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const c = await db
        .selectFrom("contracts as c")
        .leftJoin("signedDocuments as d", (j) => j.onRef("d.id", "=", "c.signedDocumentId").onRef("d.organizationId", "=", "c.organizationId"))
        .leftJoin("contracts as p", (j) => j.onRef("p.id", "=", "c.previousContractId").onRef("p.organizationId", "=", "c.organizationId"))
        .select([
          "c.id",
          "c.status",
          "c.signedDocumentId",
          "d.signedAt",
          "d.pdfSha256",
          "c.filingBasis",
          "c.filingBasisOn",
          "c.filingBasisNote",
          "p.endOn as previousEndOn",
          "c.discontinuedBy",
          "c.serviceEndsOn",
          "c.noticeSentOn",
          "c.noticeNote",
          "c.providerCredentialId",
        ])
        .where("c.organizationId", "=", organizationId)
        .where("c.id", "=", req.params.id)
        .executeTakeFirst();
      if (!c) throw notFound("Contract");
      const provider = await contractProviderOf(organizationId, c.providerCredentialId);
      const [uploads, deliveries, filing] = await Promise.all([
        db.selectFrom("contractDocuments").select(["id", "filename", "sha256", "signedOn", "createdAt"]).where("organizationId", "=", organizationId).where("contractId", "=", c.id).orderBy("createdAt", "desc").execute(),
        c.signedDocumentId
          ? db
              .selectFrom("customerDeliveries")
              .select(["id", "documentKind", "channel", "recipient", "documentSha256", "status", "attemptedAt", "error", "transportResponse"])
              .where("organizationId", "=", organizationId)
              .where("signedDocumentId", "=", c.signedDocumentId)
              .orderBy("attemptedAt", "desc")
              .execute()
          : [],
        db
          .selectFrom("filings as f")
          .leftJoin("jurisdictions as j", "j.id", "f.jurisdictionId")
          .select(["f.id", "f.status", "f.deadlineOn", "f.deadlineBasis", "f.sentAt", "f.confirmedAt", "f.reviewReason", "j.authorityName"])
          .where("f.organizationId", "=", organizationId)
          .where("f.contractId", "=", c.id)
          .executeTakeFirst(),
      ]);
      const basis = contractBasisOf(c);
      return {
        signedAt: c.signedAt?.toISOString() ?? null,
        signedDocumentSha256: c.pdfSha256 ?? null,
        uploadedDocuments: uploads.map((u) => ({
          id: u.id,
          filename: u.filename,
          sha256: u.sha256,
          signedOn: u.signedOn,
          uploadedAt: u.createdAt.toISOString(),
          url: signer.url(organizationId, u.id, now().getTime(), "contract-files"),
        })),
        customerCopy: deliveries.map(deliveryView),
        authority: filing
          ? {
              filingId: filing.id,
              status: filing.status,
              deadlineOn: filing.deadlineOn,
              deadlineBasis: filing.deadlineBasis,
              sentAt: filing.sentAt?.toISOString() ?? null,
              confirmedAt: filing.confirmedAt?.toISOString() ?? null,
              reviewReason: filing.reviewReason,
            }
          : null,
        basis: { ...basis, note: c.filingBasisNote },
        discontinuation: c.status === "cancelled" || c.serviceEndsOn ? discontinuationOf(c, filing?.authorityName ?? null) : null,
        provider,
      };
    },
  );

  app.get(
    "/contract-files/:id",
    {
      config: { public: true },
      schema: { tags: ["readiness"], summary: "Download an uploaded signed contract through a signed link", params, querystring: z.object({ exp: z.coerce.number().int(), sig: z.string().max(100) }) },
    },
    async (req, reply) => {
      const row = await db.selectFrom("contractDocuments").select(["id", "organizationId", "storageKey", "filename"]).where("id", "=", req.params.id).executeTakeFirst();
      if (!row || !signer.verify(row.organizationId, row.id, req.query.exp, req.query.sig, now().getTime(), "contract-files")) throw notFound("File");
      const data = await readForDownload(db, compliance.store, row.storageKey);
      if (!data) throw notFound("File");
      return reply.type("application/pdf").header("content-disposition", `inline; filename="${row.filename}"`).header("x-content-type-options", "nosniff").send(data);
    },
  );

  // ---- Customer delivery of reports ----

  app.post(
    "/reports/:id/send-to-customer",
    {
      config: { permission: "filings:write" },
      schema: {
        tags: ["readiness"],
        summary: "Email the customer copy of a report to the customer, recording the delivery",
        description: "Separate from filing: this never goes to an authority. Defaults to the customer's billing (else primary) contact email.",
        params,
        body: z.object({ to: z.email().nullish() }),
        response: { 202: z.object({ queued: z.boolean(), to: z.string() }) },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const r = await db
        .selectFrom("reports as r")
        .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "r.siteId").onRef("s.organizationId", "=", "r.organizationId"))
        .select(["r.id", "r.audience", "s.customerId"])
        .where("r.organizationId", "=", organizationId)
        .where("r.id", "=", req.params.id)
        .executeTakeFirst();
      if (!r) throw notFound("Report");
      if (r.audience !== "customer") throw unprocessable("Only the customer copy can be sent to the customer");
      if (!(await customerCopy(db, organizationId, r.id))!.ready) throw unprocessable(UNSIGNED_CUSTOMER_COPY);
      let to = req.body.to ?? null;
      to ??= await billingEmail(db, organizationId, r.customerId);
      if (!to) throw unprocessable("The customer has no contact with an email address");
      const requestKey = `${now().getTime()}`;
      await db.transaction().execute(async (trx) => {
        await compliance.enqueue(trx, {
          kind: SEND_CUSTOMER_REPORT,
          organizationId,
          payload: { reportId: r.id, to, requestKey, requestedBy: userId },
          dedupeKey: `${SEND_CUSTOMER_REPORT}:${r.id}:${to}:${requestKey}`,
          runAt: now(),
        });
        await audit(trx, req, { action: "report.sent_to_customer", entityType: "report", entityId: r.id, changes: { to } });
      });
      return reply.status(202).send({ queued: true, to });
    },
  );

  app.get(
    "/inspections/:id/deliveries",
    {
      config: { permission: "inspections:read" },
      schema: {
        tags: ["readiness"],
        summary: "Customer copies of this inspection's report that were emailed, with what the mail provider said",
        params,
        response: { 200: z.object({ items: z.array(customerDelivery) }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const insp = await db.selectFrom("inspections").select("id").where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
      if (!insp) throw notFound("Inspection");
      const rows = await db
        .selectFrom("customerDeliveries as d")
        .innerJoin("reports as r", (j) => j.onRef("r.id", "=", "d.reportId").onRef("r.organizationId", "=", "d.organizationId"))
        .select(["d.id", "d.documentKind", "d.channel", "d.recipient", "d.documentSha256", "d.status", "d.attemptedAt", "d.error", "d.transportResponse"])
        .where("d.organizationId", "=", organizationId)
        .where("r.inspectionId", "=", insp.id)
        .orderBy("d.attemptedAt", "desc")
        .execute();
      return { items: rows.map(deliveryView) };
    },
  );
};
