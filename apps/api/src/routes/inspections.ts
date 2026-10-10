import { createHash } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import {
  applyRequirements,
  attachment,
  type Attachment,
  canTransition,
  conflictAttachInput,
  conflictDismissInput,
  DEFAULT_TEMPLATE,
  id,
  inspection,
  type Inspection,
  type InspectionConflictReason,
  inspectionSync,
  inspectionSyncConflict,
  type InspectionSyncConflict,
  type InspectionSyncHeld,
  inspectionSyncHeld,
  type InspectionTemplate,
  inspectionTemplate,
  type InspectionValues,
  type JobStatus,
  overrideInput,
  type TemplateDefinition,
  templateInput,
  unknownKeys,
  validateInspection,
  visibleFields,
} from "@aerowise/domain";
import { openFiling, siteRequirements } from "@aerowise/compliance";
import { enqueue, GENERATE_REPORTS, queueSms } from "@aerowise/tasks";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { boundPhoneTimes } from "../lib/clock.ts";
import { forbidden, HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { perAddress, type PublicLinkLimits } from "../lib/rate-limits.ts";
import type { UrlSigner } from "../storage/signed-urls.ts";
import type { ObjectStore } from "@aerowise/storage";
import { readForDownload } from "../lib/demo.ts";

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
  linkLimits: PublicLinkLimits;
}> = async (app, { db, now, store, signer, linkLimits }) => {
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

  /** Any inspection form version visible to the organization: its own, or a built-in one. */
  const findTemplate = (organizationId: string, templateId: string) =>
    db
      .selectFrom("inspectionTemplates")
      .select(TEMPLATE_COLUMNS)
      .where("id", "=", templateId)
      // Work and intake forms share the table; an inspection never uses one.
      .where("purpose", "=", "inspection")
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
      locationStatus: (row.locationStatus as Inspection["locationStatus"]) ?? null,
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

  /**
   * Marks the job, and the visit it fulfils, as done; records it on the site's compliance
   * ledger; opens the filing; and queues the report PDFs. All in the caller's transaction.
   */
  async function completeJob(
    trx: Transaction<DB>,
    req: FastifyRequest,
    { organizationId, jobId, inspectionId, at, summary }: { organizationId: string; jobId: string; inspectionId: string; at: Date; summary: string },
  ) {
    const job = await trx
      .selectFrom("jobs")
      .select(["id", "status", "obligationId", "siteId"])
      .where("organizationId", "=", organizationId)
      .where("type", "=", "inspection")
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
    await trx
      .insertInto("complianceEvents")
      .values({
        organizationId,
        siteId: job.siteId,
        eventType: "inspection_completed",
        occurredAt: at,
        actorUserId: req.requireAuth().userId,
        inspectionId,
        reportId: null,
        summary,
        details: JSON.stringify({ jobId: job.id, obligationId: job.obligationId }),
      })
      .execute();
    // The filing waits for the authority report, which the reports task makes next.
    await openFiling(trx, { organizationId, inspectionId, actorUserId: req.requireAuth().userId, at });
    await enqueue(trx, { kind: GENERATE_REPORTS, organizationId, payload: { inspectionId }, dedupeKey: `reports:${inspectionId}`, runAt: at });
    const site = await trx.selectFrom("sites").select("customerId").where("organizationId", "=", organizationId).where("id", "=", job.siteId).executeTakeFirstOrThrow();
    await queueSms(trx, organizationId, { kind: "inspection_completed", customerId: site.customerId, siteId: job.siteId, relatedType: "inspection", relatedId: inspectionId, dedupeKey: `inspection_completed:${inspectionId}` }, at);
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

  /** Holds (or updates the held copy of) a phone's inspection for a visit that changed. */
  async function holdInspection(
    trx: Transaction<DB>,
    req: FastifyRequest,
    a: { organizationId: string; userId: string; job: { id: string; siteId: string }; body: z.output<typeof inspectionSync>; reason: InspectionConflictReason; at: Date },
  ): Promise<InspectionSyncHeld> {
    const { organizationId, userId, job, body, at } = a;
    const held = await trx
      .selectFrom("inspectionSyncConflicts")
      .select(["id", "status", "reason", "technicianUserId", "jobId"])
      .where("organizationId", "=", organizationId)
      .where("offlineClientId", "=", body.clientId)
      .forUpdate()
      .executeTakeFirst();
    if (held) {
      if (held.technicianUserId !== userId) throw forbidden();
      if (held.jobId !== job.id) throw conflict("client_id_reused", "This clientId belongs to another inspection");
      // The office decided already; the phone learns so and stops. Still held: the newest copy wins.
      if (held.status === "held") {
        await trx.updateTable("inspectionSyncConflicts").set({ payload: JSON.stringify(body), updatedAt: at }).where("organizationId", "=", organizationId).where("id", "=", held.id).execute();
      }
      return { outcome: "held_for_review", conflictId: held.id, clientId: body.clientId, reason: held.reason, status: held.status };
    }
    const c = await trx
      .insertInto("inspectionSyncConflicts")
      .values({ organizationId, offlineClientId: body.clientId, jobId: job.id, siteId: job.siteId, technicianUserId: userId, reason: a.reason, payload: JSON.stringify(body), updatedAt: at })
      .returning("id")
      .executeTakeFirstOrThrow();
    await audit(trx, req, { action: "inspection.held", entityType: "inspection_sync_conflict", entityId: c.id, changes: { jobId: job.id, reason: a.reason, status: body.status } });
    return { outcome: "held_for_review", conflictId: c.id, clientId: body.clientId, reason: a.reason, status: "held" };
  }

  /** Held inspections as the office sees them, newest first; one by id when given. */
  async function loadConflicts(organizationId: string, filter: { id?: string; status?: "held" | "attached" | "dismissed" }): Promise<InspectionSyncConflict[]> {
    let q = db
      .selectFrom("inspectionSyncConflicts as ic")
      .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "ic.siteId").onRef("s.organizationId", "=", "ic.organizationId"))
      .innerJoin("customers as cu", (j) => j.onRef("cu.id", "=", "s.customerId").onRef("cu.organizationId", "=", "s.organizationId"))
      .innerJoin("users as u", "u.id", "ic.technicianUserId")
      .select([
        "ic.id",
        "ic.offlineClientId",
        "ic.jobId",
        "ic.siteId",
        "ic.reason",
        "ic.status",
        "ic.resolutionNote",
        "ic.resolvedAt",
        "ic.attachedInspectionId",
        "ic.createdAt",
        sql<string | null>`ic.payload ->> 'completedAt'`.as("completedAt"),
        sql<string | null>`ic.payload ->> 'status'`.as("phoneStatus"),
        "s.addressLine1",
        "s.city",
        "cu.displayName as customerName",
        "u.id as technicianId",
        "u.name as technicianName",
      ])
      .select((eb) =>
        eb
          .selectFrom("attachments as a")
          .select(sql<number>`count(*)::int`.as("n"))
          .whereRef("a.inspectionClientId", "=", "ic.offlineClientId")
          .where("a.organizationId", "=", organizationId)
          .as("photoCount"),
      )
      .where("ic.organizationId", "=", organizationId)
      .orderBy("ic.createdAt", "desc");
    if (filter.id) q = q.where("ic.id", "=", filter.id);
    if (filter.status) q = q.where("ic.status", "=", filter.status);
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      clientId: r.offlineClientId,
      jobId: r.jobId,
      siteId: r.siteId,
      site: { addressLine1: r.addressLine1, city: r.city },
      customerName: r.customerName,
      technician: { id: r.technicianId, name: r.technicianName },
      reason: r.reason,
      status: r.status,
      completedAt: r.phoneStatus === "completed" && r.completedAt ? new Date(r.completedAt).toISOString() : null,
      photoCount: Number(r.photoCount ?? 0),
      resolutionNote: r.resolutionNote,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      attachedInspectionId: r.attachedInspectionId,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Writes the phone's inspection onto its visit: the draft or completion, answers, issues
   * and, when complete, the template's and the authority's checks. Shared by the sync route
   * (the assigned technician, live) and the office accepting a held inspection (credited to
   * the technician who did it). `afterRow` runs once the row exists, before the completion
   * checks count its photos.
   */
  async function writeInspection(
    trx: Transaction<DB>,
    req: FastifyRequest,
    a: {
      organizationId: string;
      technicianUserId: string;
      job: { id: string; siteId: string; status: string };
      body: z.output<typeof inspectionSync>;
      existing: { id: string } | undefined;
      at: Date;
      afterRow?: (rowId: string) => Promise<void>;
    },
  ): Promise<string> {
    const { organizationId, job, body, existing, at } = a;
    const userId = a.technicianUserId;
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

    const times = boundPhoneTimes(body, at);
    const columns = {
      arrivedAt: times.arrivedAt,
      arrivalLat: body.arrivalGps?.lat ?? null,
      arrivalLng: body.arrivalGps?.lng ?? null,
      arrivalAccuracyM: body.arrivalGps?.accuracyM ?? null,
      completionLat: body.completionGps?.lat ?? null,
      completionLng: body.completionGps?.lng ?? null,
      completionAccuracyM: body.completionGps?.accuracyM ?? null,
      locationStatus: body.locationStatus ?? (body.arrivalGps ? "recorded" : null),
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

    await a.afterRow?.(rowId);
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
      // The template's rules plus whatever the site's reporting authority requires.
      const requirements = await siteRequirements(trx, organizationId, job.siteId, times.completedAt ? new Date(times.completedAt) : at);
      const problems = validateInspection(applyRequirements(definition, requirements), values, await photoCounts(trx, organizationId, rowId));
      if (problems.length === 0) {
        await trx
          .updateTable("inspections")
          .set({ status: "completed", completedAt: times.completedAt ?? at, validationStatus: "valid" })
          .where("organizationId", "=", organizationId)
          .where("id", "=", rowId)
          .execute();
        await completeJob(trx, req, { organizationId, jobId: job.id, inspectionId: rowId, at, summary: "Inspection completed" });
        await audit(trx, req, { action: "inspection.completed", entityType: "inspection", entityId: rowId });
        if (times.adjusted.length) await audit(trx, req, { action: "inspection.clock_adjusted", entityType: "inspection", entityId: rowId, changes: { adjusted: times.adjusted } });
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
  }

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
        response: { 200: inspection, 202: inspectionSyncHeld },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const body = req.body;
      const at = now();

      const result = await db.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom("inspections")
          .select(["id", "jobId", "templateId", "status", "lockedAt", "technicianUserId"])
          .where("organizationId", "=", organizationId)
          .where("offlineClientId", "=", body.clientId)
          .forUpdate()
          .executeTakeFirst();
        if (existing) {
          if (existing.jobId !== body.jobId) throw conflict("client_id_reused", "This clientId belongs to another inspection");
          if (existing.technicianUserId === userId) {
            // Final: a retry of the completing sync, or a stale draft arriving late.
            if (existing.status === "completed" || existing.lockedAt) return { kind: "inspection" as const, id: existing.id };
            if (existing.templateId !== body.templateId) throw conflict("template_changed", "An inspection keeps the template it started with");
          }
          // Someone else's now: the visit was given to another technician while this phone was
          // out of signal, and the inspection went with it. Decided below from the job.
        }

        const job = await trx
          .selectFrom("jobs")
          .select(["id", "siteId", "status", "technicianUserId"])
          .where("organizationId", "=", organizationId)
          // A work visit is never inspected (the database refuses it too: inspections.job_type).
          .where("type", "=", "inspection")
          .where("id", "=", body.jobId)
          .forUpdate()
          .executeTakeFirst();
        if (!job) throw notFound("Job");

        const live = job.technicianUserId === userId && job.status !== "cancelled" && job.status !== "completed";
        // The visit is this technician's but its inspection is not: nothing supported leads here.
        if (live && existing && existing.technicianUserId !== userId) throw forbidden();
        if (!live) {
          // The visit changed while the phone was offline (given to someone else, unscheduled
          // or completed by the office): held for the office rather than refused, so nothing
          // the technician recorded is lost. The office accepts it or sets it aside.
          const reason: InspectionConflictReason = job.status === "completed" ? "office_completed" : job.status === "cancelled" ? "cancelled" : "reassigned";
          return { kind: "held" as const, held: await holdInspection(trx, req, { organizationId, userId, job, body, reason, at }) };
        }
        const rowId = await writeInspection(trx, req, { organizationId, technicianUserId: userId, job, body, existing, at });
        return { kind: "inspection" as const, id: rowId };
      });

      if (result.kind === "held") return reply.status(202).send(result.held);
      return loadInspection(db, organizationId, result.id);
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

      const row = await db
        .selectFrom("inspections")
        .select(["id", "status", "lockedAt", "templateId", "technicianUserId"])
        .where("organizationId", "=", organizationId)
        .where("offlineClientId", "=", req.params.clientId)
        .executeTakeFirst();
      // No row: the inspection may be held for the office (the visit changed); its photos are kept too.
      const held = row
        ? null
        : await db
            .selectFrom("inspectionSyncConflicts")
            .select(["id", "status", "technicianUserId", sql<string | null>`payload ->> 'templateId'`.as("templateId")])
            .where("organizationId", "=", organizationId)
            .where("offlineClientId", "=", req.params.clientId)
            .executeTakeFirst();
      if (!row && !held) throw notFound("Inspection");
      const insp = row ?? { id: null, status: "draft" as const, lockedAt: null, templateId: held!.templateId ?? "", technicianUserId: held!.technicianUserId };
      if (insp.technicianUserId !== userId) throw forbidden();

      const findExisting = () =>
        db
          .selectFrom("attachments")
          .select([...ATTACHMENT_COLUMNS, "inspectionId", "inspectionClientId"])
          .where("organizationId", "=", organizationId)
          .where("offlineClientId", "=", req.params.photoClientId)
          .executeTakeFirst();
      const existing = await findExisting();
      if (existing) {
        const sameOwner = insp.id ? existing.inspectionId === insp.id : existing.inspectionClientId === req.params.clientId;
        if (!sameOwner) throw conflict("client_id_reused", "This photo id belongs to another inspection");
        return reply.status(200).send(toAttachment(organizationId, existing));
      }
      if (insp.status === "completed" || insp.lockedAt) throw conflict("inspection_final", "Photos cannot be added to a completed inspection");
      if (held && held.status !== "held") throw conflict("inspection_final", "The office has already decided about this inspection");

      const template = await findTemplate(organizationId, insp.templateId);
      const photoKeys = new Set(((template?.definition as TemplateDefinition | undefined)?.photos ?? []).map((p) => p.key));
      const h = headers.data;
      if (!photoKeys.has(h["x-photo-key"])) throw unprocessable(`Unknown photo key ${h["x-photo-key"]}`);
      const sha256 = createHash("sha256").update(body).digest("hex");
      if (h["x-sha256"] && h["x-sha256"] !== sha256) throw unprocessable("The photo was corrupted in transit; upload it again");

      // The key is derived from the client id, so a retried upload overwrites the same object.
      const storageKey = `${organizationId}/inspections/${insp.id ?? `held/${req.params.clientId}`}/${req.params.photoClientId}.${PHOTO_TYPES[contentType] ?? "bin"}`;
      await store.put(storageKey, body, contentType);
      const inserted = await db
        .insertInto("attachments")
        .values({
          organizationId,
          offlineClientId: req.params.photoClientId,
          inspectionId: insp.id,
          inspectionClientId: req.params.clientId,
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

  // ---- Held inspections: the office decides ----

  const conflictParams = z.object({ id });

  app.get(
    "/inspections/conflicts",
    {
      config: { permission: "inspections:review" },
      schema: {
        tags: ["inspections"],
        summary: "Inspections held for the office because their visit changed while the phone was offline",
        querystring: z.object({ status: z.enum(["held", "attached", "dismissed"]).optional() }),
        response: { 200: z.object({ items: z.array(inspectionSyncConflict) }) },
      },
    },
    async (req) => ({ items: await loadConflicts(req.requireAuth().organizationId, { status: req.query.status }) }),
  );

  app.get(
    "/inspections/conflicts/:id",
    { config: { permission: "inspections:review" }, schema: { tags: ["inspections"], summary: "One held inspection", params: conflictParams, response: { 200: inspectionSyncConflict } } },
    async (req) => {
      const [c] = await loadConflicts(req.requireAuth().organizationId, { id: req.params.id });
      if (!c) throw notFound("Held inspection");
      return c;
    },
  );

  /** The held inspection, locked, with its payload. */
  async function lockHeld(trx: Transaction<DB>, organizationId: string, conflictId: string) {
    const c = await trx
      .selectFrom("inspectionSyncConflicts")
      .select(["id", "offlineClientId", "jobId", "siteId", "technicianUserId", "reason", "status", sql<string>`payload::text`.as("payloadText")])
      .where("organizationId", "=", organizationId)
      .where("id", "=", conflictId)
      .forUpdate()
      .executeTakeFirst();
    if (!c) throw notFound("Held inspection");
    if (c.status !== "held") throw conflict("already_decided", `This inspection was already ${c.status}`);
    return c;
  }

  app.post(
    "/inspections/conflicts/:id/attach",
    {
      config: { permission: "inspections:review" },
      schema: {
        tags: ["inspections"],
        summary: "Accept a held inspection as the visit's inspection, credited to the technician who did it",
        description:
          "Onto its own visit when that is still open; otherwise onto the visit's current booking (the office scheduled it again). " +
          "The same checks as the phone's completion apply; an inspection that fails them stays a draft the office can accept with a reason.",
        params: conflictParams,
        body: conflictAttachInput,
        response: { 200: inspectionSyncConflict },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      await db.transaction().execute(async (trx) => {
        const c = await lockHeld(trx, organizationId, req.params.id);
        const payload = inspectionSync.parse(JSON.parse(c.payloadText));
        const job = await trx.selectFrom("jobs").select(["id", "siteId", "status", "obligationId"]).where("organizationId", "=", organizationId).where("id", "=", c.jobId).forUpdate().executeTakeFirstOrThrow();
        const live = (j: { status: string }) => j.status === "scheduled" || j.status === "in_progress";
        const inspectionOf = (jobId: string) => trx.selectFrom("inspections").select(["id", "offlineClientId", "status"]).where("organizationId", "=", organizationId).where("jobId", "=", jobId).executeTakeFirst();
        // The visit was completed with someone else's inspection: accepting this one would make a second.
        const own = await inspectionOf(job.id);
        if (own && own.offlineClientId !== c.offlineClientId) throw conflict("visit_has_inspection", "This visit already has another inspection");
        let target = job;
        if (!live(job)) {
          // Unscheduled or completed: the visit's current booking, if the office made one.
          const next = job.obligationId
            ? await trx
                .selectFrom("jobs")
                .select(["id", "siteId", "status", "obligationId"])
                .where("organizationId", "=", organizationId)
                .where("obligationId", "=", job.obligationId)
                .where("type", "=", "inspection")
                .where("status", "in", ["scheduled", "in_progress"])
                .forUpdate()
                .executeTakeFirst()
            : undefined;
          if (!next) throw conflict("no_open_visit", "This visit is no longer open and has not been scheduled again. Schedule it again, then accept the inspection.");
          target = next;
        }
        const existing = target.id === job.id ? own : await inspectionOf(target.id);
        if (existing && existing.offlineClientId !== c.offlineClientId) throw conflict("visit_has_inspection", "This visit already has another inspection");
        if (existing?.status === "completed") throw conflict("visit_has_inspection", "This visit's inspection is already completed");
        const rowId = await writeInspection(trx, req, {
          organizationId,
          technicianUserId: c.technicianUserId,
          job: target,
          body: payload,
          existing: existing ? { id: existing.id } : undefined,
          at,
          // Photos uploaded while it was held belong to the row now.
          afterRow: async (id) => {
            await trx.updateTable("attachments").set({ inspectionId: id }).where("organizationId", "=", organizationId).where("inspectionClientId", "=", c.offlineClientId).where("inspectionId", "is", null).execute();
          },
        });
        await trx
          .updateTable("inspectionSyncConflicts")
          .set({ status: "attached", resolvedAt: at, resolvedBy: userId, attachedInspectionId: rowId, resolutionNote: req.body.note ?? null, updatedAt: at })
          .where("organizationId", "=", organizationId)
          .where("id", "=", c.id)
          .execute();
        await audit(trx, req, { action: "inspection.attached", entityType: "inspection", entityId: rowId, changes: { conflictId: c.id, technicianUserId: c.technicianUserId, jobId: target.id } });
      });
      const [c] = await loadConflicts(organizationId, { id: req.params.id });
      return c!;
    },
  );

  app.post(
    "/inspections/conflicts/:id/dismiss",
    {
      config: { permission: "inspections:review" },
      schema: { tags: ["inspections"], summary: "Set a held inspection aside, saying why (its photos are kept)", params: conflictParams, body: conflictDismissInput, response: { 200: inspectionSyncConflict } },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      await db.transaction().execute(async (trx) => {
        const c = await lockHeld(trx, organizationId, req.params.id);
        await trx
          .updateTable("inspectionSyncConflicts")
          .set({ status: "dismissed", resolvedAt: at, resolvedBy: userId, resolutionNote: req.body.reason, updatedAt: at })
          .where("organizationId", "=", organizationId)
          .where("id", "=", c.id)
          .execute();
        await audit(trx, req, { action: "inspection.dismissed", entityType: "inspection_sync_conflict", entityId: c.id, changes: { reason: req.body.reason, technicianUserId: c.technicianUserId } });
      });
      const [c] = await loadConflicts(organizationId, { id: req.params.id });
      return c!;
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
        await completeJob(trx, req, { organizationId, jobId: row.jobId, inspectionId: row.id, at, summary: `Inspection accepted by the office: ${req.body.reason}` });
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
      // reports and emails. The signature is bound to the file's own organization. A page
      // of photos loads many at once, so the per-address limit is generous.
      config: { public: true, rateLimit: perAddress("file", linkLimits.files) },
      schema: { tags: ["files"], summary: "Download a file through a signed link", params, querystring: z.object({ exp: z.coerce.number().int(), sig: z.string().max(100) }) },
    },
    async (req, reply) => {
      const row = await db
        .selectFrom("attachments")
        .select(["id", "organizationId", "storageKey", "contentType"])
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!row || !signer.verify(row.organizationId, row.id, req.query.exp, req.query.sig, now().getTime())) throw notFound("File");
      const data = await readForDownload(db, store, row.storageKey);
      if (!data) throw notFound("File");
      return reply.type(row.contentType).header("x-content-type-options", "nosniff").send(data);
    },
  );
};
