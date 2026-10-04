import { createHash } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import {
  attachment,
  canTransition,
  DEFAULT_TEMPLATE,
  id,
  inspection,
  inspectionSync,
  inspectionTemplate,
  overrideInput,
  templateInput,
  unknownKeys,
  validateInspection,
  visibleFields,
  type Attachment,
  type Inspection,
  type InspectionTemplate,
  type InspectionValues,
  type JobStatus,
  type TemplateDefinition,
} from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { forbidden, HttpError, notFound, unprocessable } from "../lib/errors.ts";
import type { UrlSigner } from "../storage/signed-urls.ts";
import type { ObjectStore } from "../storage/store.ts";

type Executor = Database | Transaction<DB>;

const params = z.object({ id });
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

const photoHeaders = z.object({
  "x-photo-key": z.string().min(1).max(63),
  "x-captured-at": z.iso.datetime({ offset: true }).optional(),
  "x-lat": z.coerce.number().min(-90).max(90).optional(),
  "x-lng": z.coerce.number().min(-180).max(180).optional(),
  /** Optional hex SHA-256 the phone computed, checked against what arrived. */
  "x-sha256": z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const conflict = (code: string, message: string) => new HttpError(409, code, message);

export const inspectionRoutes: FastifyPluginAsyncZod<{
  db: Database;
  now: () => Date;
  store: ObjectStore;
  signer: UrlSigner;
}> = async (app, { db, now, store, signer }) => {
  // Raw photo bodies. Scoped to this plugin, so other routes still only parse JSON.
  app.addContentTypeParser(Object.keys(PHOTO_TYPES), { parseAs: "buffer", bodyLimit: MAX_PHOTO_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  const toTemplate = (row: { id: string; key: string; version: number; name: string; organizationId: string | null; definition: unknown }): InspectionTemplate => ({
    id: row.id,
    key: row.key,
    version: row.version,
    name: row.name,
    builtIn: row.organizationId === null,
    definition: row.definition as TemplateDefinition,
  });

  const TEMPLATE_COLUMNS = ["id", "key", "version", "name", "organizationId", "definition"] as const;

  /** The built-in template row, created on first use from the definition in code. */
  async function builtInTemplate() {
    const find = () =>
      db
        .selectFrom("inspectionTemplates")
        .select(TEMPLATE_COLUMNS)
        .where("organizationId", "is", null)
        .where("key", "=", DEFAULT_TEMPLATE.key)
        .where("version", "=", DEFAULT_TEMPLATE.version)
        .executeTakeFirst();
    const existing = await find();
    if (existing) return existing;
    await db
      .insertInto("inspectionTemplates")
      .values({
        organizationId: null,
        key: DEFAULT_TEMPLATE.key,
        version: DEFAULT_TEMPLATE.version,
        name: DEFAULT_TEMPLATE.name,
        definition: JSON.stringify(DEFAULT_TEMPLATE.definition),
        createdBy: null,
      })
      .onConflict((oc) => oc.columns(["key", "version"]).where("organizationId", "is", null).doNothing())
      .execute();
    return (await find())!;
  }

  /** The organization's newest saved version, or the built-in template. */
  async function activeTemplate(organizationId: string) {
    const own = await db
      .selectFrom("inspectionTemplates")
      .select(TEMPLATE_COLUMNS)
      .where("organizationId", "=", organizationId)
      .where("key", "=", DEFAULT_TEMPLATE.key)
      .orderBy("version", "desc")
      .limit(1)
      .executeTakeFirst();
    return own ?? (await builtInTemplate());
  }

  /** Any version visible to the organization: its own, or a built-in one. */
  const findTemplate = (organizationId: string, templateId: string) =>
    db
      .selectFrom("inspectionTemplates")
      .select(TEMPLATE_COLUMNS)
      .where("id", "=", templateId)
      .where((eb) => eb.or([eb("organizationId", "is", null), eb("organizationId", "=", organizationId)]))
      .executeTakeFirst();

  const toAttachment = (organizationId: string, a: {
    id: string;
    offlineClientId: string;
    photoKey: string;
    contentType: string;
    byteSize: number;
    capturedAt: Date | null;
    lat: number | null;
    lng: number | null;
  }): Attachment => ({
    id: a.id,
    clientId: a.offlineClientId,
    photoKey: a.photoKey,
    contentType: a.contentType,
    byteSize: a.byteSize,
    capturedAt: a.capturedAt?.toISOString() ?? null,
    lat: a.lat,
    lng: a.lng,
    url: signer.url(organizationId, a.id, now().getTime()),
  });

  const ATTACHMENT_COLUMNS = ["id", "offlineClientId", "photoKey", "contentType", "byteSize", "capturedAt", "lat", "lng"] as const;

  async function loadInspection(ex: Executor, organizationId: string, inspectionId: string): Promise<Inspection> {
    const row = await ex
      .selectFrom("inspections")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("id", "=", inspectionId)
      .executeTakeFirst();
    if (!row) throw notFound("Inspection");
    const [values, issues, photos] = await Promise.all([
      ex.selectFrom("inspectionValues").select(["fieldKey", "valueJson"]).where("organizationId", "=", organizationId).where("inspectionId", "=", row.id).execute(),
      ex
        .selectFrom("issues")
        .select(["id", "clientId", "type", "severity", "description", "status"])
        .where("organizationId", "=", organizationId)
        .where("inspectionId", "=", row.id)
        .orderBy("createdAt")
        .execute(),
      ex
        .selectFrom("attachments")
        .select(ATTACHMENT_COLUMNS)
        .where("organizationId", "=", organizationId)
        .where("inspectionId", "=", row.id)
        .orderBy("createdAt")
        .execute(),
    ]);
    return {
      id: row.id,
      clientId: row.offlineClientId,
      jobId: row.jobId,
      siteId: row.siteId,
      templateId: row.templateId,
      technicianId: row.technicianUserId,
      status: row.status,
      validationStatus: row.validationStatus,
      validationProblems: row.validationProblems as Inspection["validationProblems"],
      overrideReason: row.overrideReason,
      overrideBy: row.overrideBy,
      arrivedAt: row.arrivedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      arrivalLat: row.arrivalLat,
      arrivalLng: row.arrivalLng,
      completionLat: row.completionLat,
      completionLng: row.completionLng,
      accessIssue: row.accessIssue,
      values: Object.fromEntries(values.map((v) => [v.fieldKey, v.valueJson as InspectionValues[string]])),
      issues: issues as Inspection["issues"],
      photos: photos.map((p) => toAttachment(organizationId, p)),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  const photoCounts = async (ex: Executor, organizationId: string, inspectionId: string) => {
    const rows = await ex
      .selectFrom("attachments")
      .select(["photoKey", sql<number>`count(*)::int`.as("n")])
      .where("organizationId", "=", organizationId)
      .where("inspectionId", "=", inspectionId)
      .groupBy("photoKey")
      .execute();
    return Object.fromEntries(rows.map((r) => [r.photoKey, Number(r.n)]));
  };

  /** Marks the job, and the visit it fulfils, as done. */
  async function completeJob(trx: Transaction<DB>, organizationId: string, jobId: string, at: Date) {
    const job = await trx
      .selectFrom("jobs")
      .select(["id", "status", "obligationId"])
      .where("organizationId", "=", organizationId)
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow();
    let status = job.status as JobStatus;
    if (status === "scheduled") status = "in_progress";
    if (!canTransition(status, "completed")) throw conflict("invalid_transition", `A ${job.status.replace("_", " ")} job cannot be completed`);
    await trx.updateTable("jobs").set({ status: "completed", updatedAt: at }).where("organizationId", "=", organizationId).where("id", "=", job.id).execute();
    if (job.obligationId) {
      await trx
        .updateTable("serviceObligations")
        .set({ status: "completed", completedAt: at, updatedAt: at })
        .where("organizationId", "=", organizationId)
        .where("id", "=", job.obligationId)
        .where("status", "=", "open")
        .execute();
    }
  }

  app.get(
    "/inspection-template",
    {
      config: { permission: "inspections:read" },
      schema: { tags: ["inspections"], summary: "The template new inspections use", response: { 200: inspectionTemplate } },
    },
    async (req) => toTemplate(await activeTemplate(req.requireAuth().organizationId)),
  );

  app.get(
    "/inspection-templates/:id",
    {
      config: { permission: "inspections:read" },
      schema: { tags: ["inspections"], summary: "One template version", params, response: { 200: inspectionTemplate } },
    },
    async (req) => {
      const row = await findTemplate(req.requireAuth().organizationId, req.params.id);
      if (!row) throw notFound("Template");
      return toTemplate(row);
    },
  );

  app.post(
    "/inspection-templates",
    {
      config: { permission: "org:manage" },
      schema: {
        tags: ["inspections"],
        summary: "Save a new version of the organization's inspection template",
        body: templateInput,
        response: { 201: inspectionTemplate },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const row = await db.transaction().execute(async (trx) => {
        // Serialize version numbering per organization.
        await sql`select pg_advisory_xact_lock(hashtext(${`inspection_templates:${organizationId}`}))`.execute(trx);
        const latest = await trx
          .selectFrom("inspectionTemplates")
          .select(sql<number>`coalesce(max(version), 0)`.as("v"))
          .where("organizationId", "=", organizationId)
          .where("key", "=", DEFAULT_TEMPLATE.key)
          .executeTakeFirstOrThrow();
        const created = await trx
          .insertInto("inspectionTemplates")
          .values({
            organizationId,
            key: DEFAULT_TEMPLATE.key,
            version: Number(latest.v) + 1,
            name: req.body.name,
            definition: JSON.stringify(req.body.definition),
            createdBy: userId,
          })
          .returning(TEMPLATE_COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "inspection_template.versioned", entityType: "inspection_template", entityId: created.id, changes: { version: created.version } });
        return created;
      });
      return reply.status(201).send(toTemplate(row));
    },
  );

  app.put(
    "/inspections/sync",
    {
      config: { permission: "inspections:write" },
      schema: {
        tags: ["inspections"],
        summary: "Create or update an inspection from the phone app (idempotent by clientId)",
        description:
          "Send the whole inspection after every change and on every retry. A completed inspection is final: " +
          "later syncs return it unchanged. Completing runs template validation; if it fails the inspection " +
          "stays a draft with validationStatus `invalid` and the problems listed.",
        body: inspectionSync,
        response: { 200: inspection },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const body = req.body;
      const at = now();

      const inspectionId = await db.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom("inspections")
          .select(["id", "jobId", "templateId", "status", "lockedAt", "technicianUserId"])
          .where("organizationId", "=", organizationId)
          .where("offlineClientId", "=", body.clientId)
          .forUpdate()
          .executeTakeFirst();
        if (existing) {
          if (existing.jobId !== body.jobId) throw conflict("client_id_reused", "This clientId belongs to another inspection");
          if (existing.technicianUserId !== userId) throw forbidden();
          // Final: a retry of the completing sync, or a stale draft arriving late.
          if (existing.status === "completed" || existing.lockedAt) return existing.id;
          if (existing.templateId !== body.templateId) throw conflict("template_changed", "An inspection keeps the template it started with");
        }

        const job = await trx
          .selectFrom("jobs")
          .select(["id", "siteId", "status", "technicianUserId"])
          .where("organizationId", "=", organizationId)
          .where("id", "=", body.jobId)
          .forUpdate()
          .executeTakeFirst();
        if (!job) throw notFound("Job");
        if (job.technicianUserId !== userId) throw new HttpError(403, "forbidden", "This job is assigned to someone else");
        if (job.status === "cancelled") throw conflict("job_cancelled", "This job was unscheduled by the office");
        if (job.status === "completed") throw conflict("job_completed", "This job is already completed");

        const template = await findTemplate(organizationId, body.templateId);
        if (!template) throw unprocessable("templateId does not match a template available to this organization");
        const definition = template.definition as TemplateDefinition;
        const unknown = unknownKeys(definition, body.values);
        if (unknown.length) throw unprocessable(`Unknown fields: ${unknown.join(", ")}`);

        // Unanswered fields are not stored. On completion, answers to fields the final
        // answers hide (say, a chlorine level when there is no chlorinator) are dropped.
        let values = Object.fromEntries(Object.entries(body.values).filter(([, v]) => v !== null && v !== ""));
        if (body.status === "completed") {
          const shown = new Set(visibleFields(definition, values).map((f) => f.key));
          values = Object.fromEntries(Object.entries(values).filter(([k]) => shown.has(k)));
        }

        const columns = {
          arrivedAt: body.arrivedAt,
          arrivalLat: body.arrivalGps?.lat ?? null,
          arrivalLng: body.arrivalGps?.lng ?? null,
          arrivalAccuracyM: body.arrivalGps?.accuracyM ?? null,
          completionLat: body.completionGps?.lat ?? null,
          completionLng: body.completionGps?.lng ?? null,
          completionAccuracyM: body.completionGps?.accuracyM ?? null,
          accessIssue: body.accessIssue ?? null,
          validationStatus: "pending" as const,
          validationProblems: "[]",
          updatedAt: at,
        };

        let rowId: string;
        if (existing) {
          rowId = existing.id;
          await trx.updateTable("inspections").set(columns).where("organizationId", "=", organizationId).where("id", "=", rowId).execute();
        } else {
          const created = await trx
            .insertInto("inspections")
            .values({
              ...columns,
              organizationId,
              offlineClientId: body.clientId,
              jobId: job.id,
              siteId: job.siteId,
              templateId: template.id,
              technicianUserId: userId,
              overrideReason: null,
              overrideBy: null,
              completedAt: null,
              lockedAt: null,
            })
            .returning("id")
            .executeTakeFirstOrThrow()
            .catch((err) => {
              if ((err as { code?: string }).code === "23505") throw conflict("job_has_inspection", "This job already has an inspection");
              throw err;
            });
          rowId = created.id;
          await audit(trx, req, { action: "inspection.started", entityType: "inspection", entityId: rowId, changes: { jobId: job.id } });
        }

        await trx.deleteFrom("inspectionValues").where("organizationId", "=", organizationId).where("inspectionId", "=", rowId).execute();
        const valueRows = Object.entries(values).map(([fieldKey, v]) => ({ organizationId, inspectionId: rowId, fieldKey, valueJson: JSON.stringify(v) }));
        if (valueRows.length) await trx.insertInto("inspectionValues").values(valueRows).execute();

        // Issues follow the phone's list: upserted by clientId, removed when dropped.
        const keep = body.issues.map((i) => i.clientId);
        let removeQuery = trx.deleteFrom("issues").where("organizationId", "=", organizationId).where("inspectionId", "=", rowId);
        if (keep.length) removeQuery = removeQuery.where("clientId", "not in", keep);
        await removeQuery.execute();
        for (const issue of body.issues) {
          await trx
            .insertInto("issues")
            .values({ organizationId, clientId: issue.clientId, inspectionId: rowId, siteId: job.siteId, type: issue.type, severity: issue.severity, description: issue.description, updatedAt: at })
            .onConflict((oc) =>
              oc
                .columns(["organizationId", "clientId"])
                .doUpdateSet({ type: issue.type, severity: issue.severity, description: issue.description, updatedAt: at })
                .where("issues.inspectionId", "=", rowId),
            )
            .execute();
        }

        if (job.status === "scheduled") {
          await trx.updateTable("jobs").set({ status: "in_progress", updatedAt: at }).where("organizationId", "=", organizationId).where("id", "=", job.id).execute();
        }

        if (body.status === "completed") {
          const problems = validateInspection(definition, values, await photoCounts(trx, organizationId, rowId));
          if (problems.length === 0) {
            await trx
              .updateTable("inspections")
              .set({ status: "completed", completedAt: body.completedAt ?? at, validationStatus: "valid" })
              .where("organizationId", "=", organizationId)
              .where("id", "=", rowId)
              .execute();
            await completeJob(trx, organizationId, job.id, at);
            await audit(trx, req, { action: "inspection.completed", entityType: "inspection", entityId: rowId });
          } else {
            await trx
              .updateTable("inspections")
              .set({ validationStatus: "invalid", validationProblems: JSON.stringify(problems) })
              .where("organizationId", "=", organizationId)
              .where("id", "=", rowId)
              .execute();
            await audit(trx, req, { action: "inspection.completion_rejected", entityType: "inspection", entityId: rowId, changes: { problems } });
          }
        }
        return rowId;
      });

      return loadInspection(db, organizationId, inspectionId);
    },
  );

  app.put(
    "/inspections/:clientId/photos/:photoClientId",
    {
      config: { permission: "inspections:write", imageUpload: true },
      bodyLimit: MAX_PHOTO_BYTES,
      schema: {
        tags: ["inspections"],
        summary: "Upload one photo as the raw image body (idempotent by photoClientId)",
        description: "Headers: x-photo-key (a photo requirement key), optional x-captured-at, x-lat, x-lng, x-sha256.",
        params: z.object({ clientId: z.uuid(), photoClientId: z.uuid() }),
        response: { 200: attachment, 201: attachment },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const headers = photoHeaders.safeParse(req.headers);
      if (!headers.success) throw new HttpError(400, "invalid_request", "Photo headers failed validation");
      const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, "invalid_request", "Send the image as the request body");

      const insp = await db
        .selectFrom("inspections")
        .select(["id", "status", "lockedAt", "templateId", "technicianUserId"])
        .where("organizationId", "=", organizationId)
        .where("offlineClientId", "=", req.params.clientId)
        .executeTakeFirst();
      if (!insp) throw notFound("Inspection");
      if (insp.technicianUserId !== userId) throw forbidden();

      const findExisting = () =>
        db
          .selectFrom("attachments")
          .select([...ATTACHMENT_COLUMNS, "inspectionId"])
          .where("organizationId", "=", organizationId)
          .where("offlineClientId", "=", req.params.photoClientId)
          .executeTakeFirst();
      const existing = await findExisting();
      if (existing) {
        if (existing.inspectionId !== insp.id) throw conflict("client_id_reused", "This photo id belongs to another inspection");
        return reply.status(200).send(toAttachment(organizationId, existing));
      }
      if (insp.status === "completed" || insp.lockedAt) throw conflict("inspection_final", "Photos cannot be added to a completed inspection");

      const template = await findTemplate(organizationId, insp.templateId);
      const photoKeys = new Set(((template?.definition as TemplateDefinition | undefined)?.photos ?? []).map((p) => p.key));
      const h = headers.data;
      if (!photoKeys.has(h["x-photo-key"])) throw unprocessable(`Unknown photo key ${h["x-photo-key"]}`);
      const sha256 = createHash("sha256").update(body).digest("hex");
      if (h["x-sha256"] && h["x-sha256"] !== sha256) throw unprocessable("The photo was corrupted in transit; upload it again");

      // The key is derived from the client id, so a retried upload overwrites the same object.
      const storageKey = `${organizationId}/inspections/${insp.id}/${req.params.photoClientId}.${PHOTO_TYPES[contentType] ?? "bin"}`;
      await store.put(storageKey, body, contentType);
      const inserted = await db
        .insertInto("attachments")
        .values({
          organizationId,
          offlineClientId: req.params.photoClientId,
          inspectionId: insp.id,
          photoKey: h["x-photo-key"],
          storageKey,
          contentType,
          byteSize: body.length,
          sha256,
          capturedAt: h["x-captured-at"] ?? null,
          lat: h["x-lat"] ?? null,
          lng: h["x-lng"] ?? null,
          uploadedBy: userId,
        })
        .onConflict((oc) => oc.columns(["organizationId", "offlineClientId"]).doNothing())
        .returning(ATTACHMENT_COLUMNS)
        .executeTakeFirst();
      if (!inserted) {
        // Lost a race with a concurrent retry of the same upload.
        const winner = await findExisting();
        return reply.status(200).send(toAttachment(organizationId, winner!));
      }
      return reply.status(201).send(toAttachment(organizationId, inserted));
    },
  );

  app.get(
    "/inspections/:id",
    {
      config: { permission: "inspections:read" },
      schema: { tags: ["inspections"], summary: "One inspection with answers, issues and photo links", params, response: { 200: inspection } },
    },
    async (req) => loadInspection(db, req.requireAuth().organizationId, req.params.id),
  );

  app.get(
    "/jobs/:id/inspection",
    {
      config: { permission: "inspections:read" },
      schema: { tags: ["inspections"], summary: "The inspection recorded for a job", params, response: { 200: inspection } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const row = await db
        .selectFrom("inspections")
        .select("id")
        .where("organizationId", "=", organizationId)
        .where("jobId", "=", req.params.id)
        .executeTakeFirst();
      if (!row) throw notFound("Inspection");
      return loadInspection(db, organizationId, row.id);
    },
  );

  app.post(
    "/inspections/:id/override",
    {
      config: { permission: "inspections:review" },
      schema: {
        tags: ["inspections"],
        summary: "Accept an inspection that failed validation, with a reason",
        params,
        body: overrideInput,
        response: { 200: inspection },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom("inspections")
          .select(["id", "jobId", "status", "validationStatus", "validationProblems"])
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw notFound("Inspection");
        if (row.status !== "draft" || row.validationStatus !== "invalid") {
          throw conflict("not_overridable", "Only an inspection whose completion failed validation can be overridden");
        }
        await trx
          .updateTable("inspections")
          .set({ status: "completed", completedAt: at, validationStatus: "overridden", overrideReason: req.body.reason, overrideBy: userId, updatedAt: at })
          .where("organizationId", "=", organizationId)
          .where("id", "=", row.id)
          .execute();
        await completeJob(trx, organizationId, row.jobId, at);
        await audit(trx, req, {
          action: "inspection.overridden",
          entityType: "inspection",
          entityId: row.id,
          changes: { reason: req.body.reason, problems: row.validationProblems },
        });
      });
      return loadInspection(db, organizationId, req.params.id);
    },
  );

  app.get(
    "/files/:id",
    {
      // Authorized by the signature instead of a session, so links work in <img> tags,
      // reports and emails. The signature is bound to the file's own organization.
      config: { public: true },
      schema: { tags: ["files"], summary: "Download a file through a signed link", params, querystring: z.object({ exp: z.coerce.number().int(), sig: z.string().max(100) }) },
    },
    async (req, reply) => {
      const row = await db
        .selectFrom("attachments")
        .select(["id", "organizationId", "storageKey", "contentType"])
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!row || !signer.verify(row.organizationId, row.id, req.query.exp, req.query.sig, now().getTime())) throw notFound("File");
      const data = await store.get(row.storageKey);
      if (!data) throw notFound("File");
      return reply.type(row.contentType).header("x-content-type-options", "nosniff").send(data);
    },
  );
};
