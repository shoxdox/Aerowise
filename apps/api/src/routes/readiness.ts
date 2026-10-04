import { createHash } from "node:crypto";
import { openContractFiling, refreshFiling, type ComplianceContext } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import {
  classifyInput,
  credential,
  credentialInput,
  credentialPatch,
  customerDelivery,
  id,
  officeServiceRequestInput,
  responseInput,
  serviceRequestDetail,
  type Credential,
  type ServiceRequestDetail,
} from "@aerowise/domain";
import { billingEmail, SEND_CUSTOMER_REPORT } from "@aerowise/tasks";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { notFound, unprocessable } from "../lib/errors.ts";
import type { UrlSigner } from "../storage/signed-urls.ts";

const params = z.object({ id });
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

  /** Inspection filings at the site that were waiting on a request's review or response, checked again. */
  async function recheckHeldFilings(organizationId: string, siteId: string, actorUserId: string) {
    const held = await db
      .selectFrom("filings")
      .select("id")
      .where("organizationId", "=", organizationId)
      .where("siteId", "=", siteId)
      .where("kind", "=", "inspection_report")
      .where("status", "in", ["pending", "needs_review"])
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
        summary: "Record how and when the provider responded (a visit, a call), as the authority report will print it",
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
          .set({ responseAction: req.body.action, respondedAt, responseJobId: req.body.jobId ?? null, responseRecordedBy: userId, updatedAt: now() })
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
              .object({ filingId: id, status: z.string(), deadlineOn: z.iso.date().nullable(), sentAt: z.iso.datetime({ offset: true }).nullable(), confirmedAt: z.iso.datetime({ offset: true }).nullable(), reviewReason: z.string().nullable() })
              .nullable(),
          }),
        },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const c = await db
        .selectFrom("contracts as c")
        .leftJoin("signedDocuments as d", (j) => j.onRef("d.id", "=", "c.signedDocumentId").onRef("d.organizationId", "=", "c.organizationId"))
        .select(["c.id", "c.signedDocumentId", "d.signedAt", "d.pdfSha256"])
        .where("c.organizationId", "=", organizationId)
        .where("c.id", "=", req.params.id)
        .executeTakeFirst();
      if (!c) throw notFound("Contract");
      const [uploads, deliveries, filing] = await Promise.all([
        db.selectFrom("contractDocuments").select(["id", "filename", "sha256", "signedOn", "createdAt"]).where("organizationId", "=", organizationId).where("contractId", "=", c.id).orderBy("createdAt", "desc").execute(),
        c.signedDocumentId
          ? db
              .selectFrom("customerDeliveries")
              .select(["id", "documentKind", "channel", "recipient", "documentSha256", "status", "attemptedAt", "error"])
              .where("organizationId", "=", organizationId)
              .where("signedDocumentId", "=", c.signedDocumentId)
              .orderBy("attemptedAt", "desc")
              .execute()
          : [],
        db.selectFrom("filings").select(["id", "status", "deadlineOn", "sentAt", "confirmedAt", "reviewReason"]).where("organizationId", "=", organizationId).where("contractId", "=", c.id).executeTakeFirst(),
      ]);
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
        customerCopy: deliveries.map((d) => ({ ...d, attemptedAt: d.attemptedAt.toISOString() })),
        authority: filing
          ? { filingId: filing.id, status: filing.status, deadlineOn: filing.deadlineOn, sentAt: filing.sentAt?.toISOString() ?? null, confirmedAt: filing.confirmedAt?.toISOString() ?? null, reviewReason: filing.reviewReason }
          : null,
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
      const data = await compliance.store.get(row.storageKey);
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
        .select(["d.id", "d.documentKind", "d.channel", "d.recipient", "d.documentSha256", "d.status", "d.attemptedAt", "d.error"])
        .where("d.organizationId", "=", organizationId)
        .where("r.inspectionId", "=", insp.id)
        .orderBy("d.attemptedAt", "desc")
        .execute();
      return { items: rows.map((d) => ({ ...d, attemptedAt: d.attemptedAt.toISOString() })) };
    },
  );
};
