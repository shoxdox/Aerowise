import { createHash } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import {
  alreadyResolved,
  conflictAttachInput,
  conflictDismissInput,
  heldForReview,
  JOB_STATE_MACHINE,
  roleHasPermission,
  pumpOutProblems,
  signatureProblems,
  snapshotSha256,
  unknownKeys,
  validateInspection,
  visibleFields,
  workOrderLabel,
  workRecord,
  workSignature,
  workSignatureUpload,
  workStop,
  workSync,
  workSyncConflict,
  workPhoto,
  type CoverageEffect,
  type Feature,
  type PumpOutInput,
  type Role,
  type TemplateDefinition,
  type WorkRecord,
  type WorkStop,
  type WorkSyncConflict,
} from "@aerowise/domain";
import type { ObjectStore } from "@aerowise/storage";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { boundPhoneTimes } from "../lib/clock.ts";
import { readForDownload } from "../lib/demo.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { currentForms } from "../lib/forms.ts";
import { organizationToday } from "../lib/today.ts";
import { lockWorkOrder, setWorkOrderStatus, workOrderEvent } from "../lib/work-orders.ts";
import { insertPumpOut, pumpOutRequired, pumpOutVehicleProblems } from "../lib/pumping.ts";
import type { UrlSigner } from "../storage/signed-urls.ts";

// SW-2, server side: field records for work visits sent from the phone, their photos and
// customer signatures, and what the office does with records it took the visit away from.
// See the service workflows plan §8.1 and §8.5.
//
// Who may send is decided per request, in the caller's company, with the work order and the
// visit locked (work order first, as every other work route does):
// - the visit's current technician, while it is live: the normal path (200/201);
// - a technician the visit was taken from (reassigned, cancelled, or its order completed by
//   the office), who still may complete work: held for the office, 202 `held_for_review`;
// - anyone else in the company: 403 `not_assigned`, nothing stored; another company: 404.

type Trx = Transaction<DB>;
type Executor = Database | Trx;

const params = z.object({ id: z.uuid() });
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
  "x-sha256": z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const conflict = (code: string, message: string) => new HttpError(409, code, message);
const fieldWorkOff = () => new HttpError(409, "feature_off", "Field work on the phone is not switched on for this deployment");
const notAssigned = () => new HttpError(403, "not_assigned", "This visit was never assigned to you");

type Decision = { kind: "assignee" } | { kind: "held"; reason: "reassigned" | "cancelled" | "office_completed" } | { kind: "not_assigned" };

export const workSyncRoutes: FastifyPluginAsyncZod<{
  db: Database;
  now: () => Date;
  store: ObjectStore;
  signer: UrlSigner;
  features: ReadonlySet<Feature>;
}> = async (app, { db, now, store, signer, features }) => {
  const enabled = features.has("field_work");
  // Plan coverage on the technician's visits only where the company uses plan coverage (SW-8).
  const planBuilder = features.has("plan_builder");
  // Raw photo bodies, for this plugin's routes only.
  app.addContentTypeParser(Object.keys(PHOTO_TYPES), { parseAs: "buffer", bodyLimit: MAX_PHOTO_BYTES }, (_req, body, done) => done(null, body));

  /** One phone client id at a time: syncs, uploads and the office's attach queue behind each other. */
  const clientLock = (trx: Trx, organizationId: string, clientId: string) =>
    sql`select pg_advisory_xact_lock(hashtext(${`work-client:${organizationId}:${clientId}`}))`.execute(trx);

  /**
   * A jsonb column as stored. The query builder camel-cases the keys of objects it reads back,
   * which would turn answer keys such as work_performed into workPerformed, so answers,
   * summaries and held payloads are read as text and parsed here.
   */
  const jsonText = (column: string) => sql<string | null>`${sql.ref(column)}::text`;
  const parseJson = (text: string | null) => (text === null ? null : (JSON.parse(text) as unknown));
  /** The work order's coverage snapshot as the technician sees it: the plan and its rules' names, no prices or percentages. */
  const techCoverage = (snapshot: unknown): WorkStop["coverage"] => {
    const s = snapshot as { planName?: string; covered?: boolean; rules?: { label: string; effect: CoverageEffect }[] } | null;
    if (!s?.covered || !s.planName || !s.rules?.length) return null;
    return { planName: s.planName, rules: s.rules.map((r) => ({ label: r.label, effect: r.effect })) };
  };

  const findRecord = (ex: Executor, organizationId: string, clientId: string) =>
    ex.selectFrom("workRecords").selectAll().where("organizationId", "=", organizationId).where("offlineClientId", "=", clientId).executeTakeFirst();
  const findConflict = (ex: Executor, organizationId: string, clientId: string) =>
    ex.selectFrom("workSyncConflicts").selectAll().where("organizationId", "=", organizationId).where("offlineClientId", "=", clientId).executeTakeFirst();

  /** The work visit, its order locked first and then the visit itself. Another company's id is not found. */
  async function lockVisit(trx: Trx, organizationId: string, jobId: string) {
    const peek = await trx
      .selectFrom("jobs")
      .select(["workOrderId"])
      .where("organizationId", "=", organizationId)
      .where("type", "=", "work")
      .where("id", "=", jobId)
      .executeTakeFirst();
    if (!peek?.workOrderId) throw notFound("Job");
    const wo = await lockWorkOrder(trx, organizationId, peek.workOrderId);
    const job = await trx
      .selectFrom("jobs")
      .select(["id", "siteId", "status", "technicianUserId", "workOrderId", "visitNumber", "scheduledDate"])
      .where("organizationId", "=", organizationId)
      .where("id", "=", jobId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    return { wo, job: { ...job, workOrderId: job.workOrderId! } };
  }

  /** Whether the caller is a member who may still complete work (an ex-member's work is refused). */
  async function mayCompleteWork(ex: Executor, organizationId: string, userId: string) {
    const m = await ex.selectFrom("memberships").select(["role", "active"]).where("organizationId", "=", organizationId).where("userId", "=", userId).executeTakeFirst();
    return !!m?.active && roleHasPermission(m.role as Role, "work:complete");
  }

  async function decide(trx: Trx, organizationId: string, userId: string, wo: { status: string }, job: { id: string; status: string; technicianUserId: string }): Promise<Decision> {
    const live = (job.status === "scheduled" || job.status === "in_progress") && wo.status !== "completed" && wo.status !== "cancelled";
    if (live && job.technicianUserId === userId) return { kind: "assignee" };
    const mine = await trx
      .selectFrom("jobAssignments")
      .select(["endReason"])
      .where("organizationId", "=", organizationId)
      .where("jobId", "=", job.id)
      .where("technicianUserId", "=", userId)
      .orderBy("assignedAt", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!mine || !(await mayCompleteWork(trx, organizationId, userId))) return { kind: "not_assigned" };
    if (mine.endReason === "office_completed" || wo.status === "completed") return { kind: "held", reason: "office_completed" };
    if (mine.endReason === "cancelled" || job.status === "cancelled" || wo.status === "cancelled") return { kind: "held", reason: "cancelled" };
    return { kind: "held", reason: "reassigned" };
  }

  /** A work form version this company can use (its own or a built-in one). */
  async function workTemplate(ex: Executor, organizationId: string, templateId: string) {
    return ex
      .selectFrom("inspectionTemplates")
      .select(["id", "definition"])
      .where("id", "=", templateId)
      .where("purpose", "=", "work")
      .where((eb) => eb.or([eb("organizationId", "is", null), eb("organizationId", "=", organizationId)]))
      .executeTakeFirst();
  }

  /**
   * What completing a record would find wrong, checked against its pinned form version and what
   * the server holds for its client id (photos, signatures): the same checks whether the
   * technician completes it or the office accepts it from a held record. `values` are the
   * answers kept on completion (only fields the form shows); `mismatch` means a signature was
   * given on a different summary.
   */
  async function completionCheck(
    trx: Trx,
    organizationId: string,
    clientId: string,
    definition: TemplateDefinition,
    sent: Record<string, unknown>,
    summary: unknown,
    work: { workOrderId: string; pumpOut: PumpOutInput | null | undefined; finalVisit: boolean },
  ) {
    const answers = Object.fromEntries(Object.entries(sent).filter(([, v]) => v !== null && v !== "")) as Parameters<typeof visibleFields>[1];
    const shown = new Set(visibleFields(definition, answers).map((f) => f.key));
    const values = Object.fromEntries(Object.entries(answers).filter(([k]) => shown.has(k)));
    const summarySha256 = summary ? await snapshotSha256(summary) : null;
    const signed = await trx
      .selectFrom("signedDocuments")
      .select(["requirementKey", "contentSha256"])
      .where("organizationId", "=", organizationId)
      .where("recordClientId", "=", clientId)
      .execute();
    const mismatch = signed.some((sig) => sig.contentSha256 !== summarySha256);
    const problems = [
      ...validateInspection(definition, values, await photoCounts(trx, organizationId, clientId)),
      // SW-7: a sign-off marked for the final visit is asked for only on the visit that finishes the work.
      ...signatureProblems(definition, new Set(signed.map((sig) => sig.requirementKey!)), work.finalVisit),
      // SW-6: work that needs a disposal record completes only with its pump-out.
      ...pumpOutProblems(await pumpOutRequired(trx, features, organizationId, work.workOrderId), work.pumpOut),
      ...(await pumpOutVehicleProblems(trx, organizationId, work.pumpOut)),
    ];
    return { values, summarySha256, mismatch, problems };
  }
  const signatureMismatch = () => conflict("signature_mismatch", "The work summary changed after the customer signed it; ask for a new signature");

  const held = (c: { id: string; reason: string }) => ({ outcome: "held_for_review" as const, conflictId: c.id, reason: c.reason as "reassigned" | "cancelled" | "office_completed" });
  const resolved = (c: { id: string; status: string }) => ({ outcome: "resolved" as const, conflictId: c.id, resolution: c.status as "attached" | "dismissed" });

  // ---- Reading records ----

  const PHOTO_COLUMNS = ["id", "offlineClientId", "photoKey", "contentType", "byteSize", "capturedAt"] as const;

  async function loadRecord(ex: Executor, organizationId: string, recordId: string): Promise<WorkRecord> {
    const r = await ex
      .selectFrom("workRecords")
      .selectAll()
      .select([jsonText("answers").as("answersText"), jsonText("summary").as("summaryText")])
      .where("organizationId", "=", organizationId)
      .where("id", "=", recordId)
      .executeTakeFirst();
    if (!r) throw notFound("Work record");
    const photos = await ex
      .selectFrom("workAttachments")
      .select(PHOTO_COLUMNS)
      .where("organizationId", "=", organizationId)
      .where("recordClientId", "=", r.offlineClientId)
      .orderBy("createdAt")
      .execute();
    const signatures = await ex
      .selectFrom("signedDocuments")
      .select(["id", "offlineClientId", "requirementKey", "signerName", "signatureKind", "contentSha256", "signedAt"])
      .where("organizationId", "=", organizationId)
      .where("recordClientId", "=", r.offlineClientId)
      .orderBy("signedAt")
      .execute();
    return {
      id: r.id,
      clientId: r.offlineClientId,
      jobId: r.jobId,
      workOrderId: r.workOrderId,
      siteId: r.siteId,
      templateId: r.templateId,
      technicianId: r.technicianUserId,
      status: r.status,
      validationStatus: r.validationStatus,
      validationProblems: r.validationProblems as WorkRecord["validationProblems"],
      values: parseJson(r.answersText) as WorkRecord["values"],
      summary: (parseJson(r.summaryText) as WorkRecord["summary"]) ?? null,
      summarySha256: r.summarySha256,
      finalVisit: r.finalVisit,
      arrivedAt: r.arrivedAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
      attachedByOffice: r.attachedBy !== null,
      photos: photos.map((p) => toPhoto(organizationId, p)),
      signatures: signatures.map((s) => ({
        id: s.id,
        clientId: s.offlineClientId!,
        requirementKey: s.requirementKey!,
        signerName: s.signerName,
        signatureKind: s.signatureKind,
        contentSha256: s.contentSha256,
        signedAt: s.signedAt.toISOString(),
      })),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  const toPhoto = (organizationId: string, p: { id: string; offlineClientId: string; photoKey: string; contentType: string; byteSize: number; capturedAt: Date | null }) => ({
    id: p.id,
    clientId: p.offlineClientId,
    photoKey: p.photoKey,
    contentType: p.contentType,
    byteSize: p.byteSize,
    capturedAt: p.capturedAt?.toISOString() ?? null,
    url: signer.url(organizationId, p.id, now().getTime(), "work-files"),
  });

  /** Uploaded photos per requirement key, for completion checks. */
  async function photoCounts(ex: Executor, organizationId: string, clientId: string) {
    const rows = await ex
      .selectFrom("workAttachments")
      .select(["photoKey", sql<number>`count(*)`.as("n")])
      .where("organizationId", "=", organizationId)
      .where("recordClientId", "=", clientId)
      .groupBy("photoKey")
      .execute();
    return Object.fromEntries(rows.map((r) => [r.photoKey, Number(r.n)]));
  }

  // ---- The phone sends a record ----

  app.put(
    "/work/sync",
    {
      config: { permission: "work:complete" },
      schema: {
        tags: ["work"],
        summary: "Create or update a work visit's field record from the phone (idempotent by clientId)",
        description:
          "Send the whole record after every change and on every retry. A completed record is final. When the office took the " +
          "visit away meanwhile, the record is held for the office and the answer is 202 held_for_review, which the phone " +
          "treats as delivered.",
        body: workSync,
        response: { 200: z.union([workRecord, alreadyResolved]), 202: heldForReview },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const body = req.body;
      const at = now();
      const result = await db.transaction().execute(async (trx) => {
        await clientLock(trx, organizationId, body.clientId);
        // A client id names one visit for good: a draft moved to a conflict keeps its visit.
        const settled = await findConflict(trx, organizationId, body.clientId);
        if (settled && (settled.jobId !== body.jobId || settled.technicianUserId !== userId)) throw settled.jobId !== body.jobId ? conflict("client_id_reused", "This clientId belongs to another visit") : notAssigned();
        // Once the office decided, every replay just learns the outcome (an attached record may sit on a new visit).
        if (settled && settled.status !== "held") return { kind: "resolved" as const, c: settled };
        const before = settled ?? (await findRecord(trx, organizationId, body.clientId));
        if (before && before.jobId !== body.jobId) throw conflict("client_id_reused", "This clientId belongs to another visit");
        if (before && before.technicianUserId !== userId) throw notAssigned();
        if (!before && !enabled) throw fieldWorkOff();

        const { wo, job } = await lockVisit(trx, organizationId, body.jobId);
        // Read again under the locks: the office may have just moved a draft to a conflict.
        const record = await findRecord(trx, organizationId, body.clientId);
        if (record?.status === "completed") return { kind: "record" as const, id: record.id };
        const held0 = record ? null : await findConflict(trx, organizationId, body.clientId);
        if (held0) {
          if (held0.status !== "held") return { kind: "resolved" as const, c: held0 };
          if (body.revision >= held0.phoneRevision) {
            await trx
              .updateTable("workSyncConflicts")
              .set({ payload: JSON.stringify(body), phoneRevision: body.revision, updatedAt: at })
              .where("organizationId", "=", organizationId)
              .where("id", "=", held0.id)
              .execute();
          }
          return { kind: "held" as const, c: held0 };
        }

        const decision = await decide(trx, organizationId, userId, wo, job);
        if (decision.kind === "not_assigned") throw notAssigned();
        if (decision.kind === "held") {
          const c = await trx
            .insertInto("workSyncConflicts")
            .values({
              organizationId,
              offlineClientId: body.clientId,
              jobId: job.id,
              workOrderId: job.workOrderId,
              technicianUserId: userId,
              reason: decision.reason,
              payload: JSON.stringify(body),
              phoneRevision: body.revision,
              updatedAt: at,
            })
            .returning(["id", "reason"])
            .executeTakeFirstOrThrow();
          await workOrderEvent(trx, req, { organizationId, workOrderId: wo.id, eventType: "field_record_held", summary: "A field record arrived after the visit changed; held for the office", details: { conflictId: c.id, reason: c.reason }, at });
          await audit(trx, req, { action: "work_record.held", entityType: "work_sync_conflict", entityId: c.id, changes: { jobId: job.id, reason: c.reason } });
          return { kind: "held" as const, c };
        }

        // The current technician on a live visit. An older revision arriving late (a retried
        // request, a second tab) never overwrites a newer one, and never completes it; the same
        // revision may (the phone sends its draft, then its uploads, then completion).
        if (record && body.revision < record.phoneRevision) return { kind: "record" as const, id: record.id };
        const template = await workTemplate(trx, organizationId, body.templateId);
        if (!template) throw unprocessable("templateId does not match a work form available to this organization");
        if (record && record.templateId !== body.templateId) throw conflict("template_changed", "A record keeps the form it started with");
        const definition = template.definition as TemplateDefinition;
        const unknown = unknownKeys(definition, body.values);
        if (unknown.length) throw unprocessable(`Unknown fields: ${unknown.join(", ")}`);
        if (body.removedPhotoClientIds?.length) {
          const removed = await trx.deleteFrom("workAttachments").where("organizationId", "=", organizationId).where("recordClientId", "=", body.clientId)
            .where("offlineClientId", "in", body.removedPhotoClientIds).returning("id").execute();
          if (removed.length) await audit(trx, req, { action: "work_record.draft_photos_removed", entityType: "work_record", entityId: record?.id ?? body.clientId, changes: { attachmentIds: removed.map(p => p.id) } });
        }
        const check = body.status === "completed" ? await completionCheck(trx, organizationId, body.clientId, definition, body.values, body.summary, { workOrderId: job.workOrderId, pumpOut: body.pumpOut, finalVisit: body.finalVisit }) : null;
        const values = check?.values ?? Object.fromEntries(Object.entries(body.values).filter(([, v]) => v !== null && v !== ""));
        const summarySha256 = body.summary ? await snapshotSha256(body.summary) : null;
        const times = boundPhoneTimes(body, at);
        const columns = {
          answers: JSON.stringify(values),
          summary: body.summary ? JSON.stringify(body.summary) : null,
          summarySha256,
          finalVisit: body.finalVisit,
          phoneRevision: body.revision,
          arrivedAt: times.arrivedAt,
          arrivalLat: body.arrivalGps?.lat ?? null,
          arrivalLng: body.arrivalGps?.lng ?? null,
          completionLat: body.completionGps?.lat ?? null,
          completionLng: body.completionGps?.lng ?? null,
          locationStatus: body.locationStatus ?? (body.arrivalGps ? "recorded" : null),
          validationStatus: "pending" as const,
          validationProblems: "[]",
          updatedAt: at,
        };
        let recordId: string;
        if (record) {
          recordId = record.id;
          await trx.updateTable("workRecords").set(columns).where("organizationId", "=", organizationId).where("id", "=", recordId).execute();
        } else {
          const created = await trx
            .insertInto("workRecords")
            .values({ ...columns, organizationId, offlineClientId: body.clientId, jobId: job.id, workOrderId: job.workOrderId, siteId: job.siteId, technicianUserId: userId, templateId: template.id, completedAt: null, attachedBy: null })
            .returning("id")
            .executeTakeFirstOrThrow()
            .catch((err) => {
              if ((err as { code?: string }).code === "23505") throw conflict("job_has_record", "This visit already has a field record");
              throw err;
            });
          recordId = created.id;
          await audit(trx, req, { action: "work_record.started", entityType: "work_record", entityId: recordId, changes: { jobId: job.id } });
        }

        if (check) {
          // A signed summary must be the summary sent now, byte for byte.
          if (check.mismatch) throw signatureMismatch();
          const problems = check.problems;
          if (problems.length) {
            await trx
              .updateTable("workRecords")
              .set({ validationStatus: "invalid", validationProblems: JSON.stringify(problems) })
              .where("organizationId", "=", organizationId)
              .where("id", "=", recordId)
              .execute();
          } else {
            await completeRecord(trx, req, { organizationId, recordId, wo, jobId: job.id, finalVisit: body.finalVisit, completedAt: times.completedAt ? new Date(times.completedAt) : at, at, pumpOut: body.pumpOut });
            if (times.adjusted.length) await audit(trx, req, { action: "work.clock_adjusted", entityType: "work_record", entityId: recordId, changes: { adjusted: times.adjusted } });
          }
        }
        return { kind: "record" as const, id: recordId };
      });

      if (result.kind === "held") return reply.status(202).send(held(result.c));
      if (result.kind === "resolved") return reply.status(200).send(resolved(result.c));
      return reply.status(200).send(await loadRecord(db, organizationId, result.id));
    },
  );

  /** Completes a record, its visit and, on the final visit, its work order. */
  async function completeRecord(
    trx: Trx,
    req: FastifyRequest,
    a: {
      organizationId: string;
      recordId: string;
      wo: { id: string; status: string };
      jobId: string;
      finalVisit: boolean;
      completedAt: Date;
      at: Date;
      attachedBy?: string;
      pumpOut?: PumpOutInput | null;
    },
  ) {
    await trx
      .updateTable("workRecords")
      .set({ status: "completed", completedAt: a.completedAt, validationStatus: "valid", validationProblems: "[]", updatedAt: a.at, ...(a.attachedBy ? { attachedBy: a.attachedBy } : {}) })
      .where("organizationId", "=", a.organizationId)
      .where("id", "=", a.recordId)
      .execute();
    await trx
      .updateTable("jobs")
      .set({ status: "completed", updatedAt: a.at })
      .where("organizationId", "=", a.organizationId)
      .where("id", "=", a.jobId)
      .where("status", "in", ["scheduled", "in_progress"])
      .execute();
    const live = a.wo.status === "open" || a.wo.status === "scheduled" || a.wo.status === "in_progress";
    if (live) {
      if (a.finalVisit) await setWorkOrderStatus(trx, a.organizationId, a.wo, "completed", a.at, { completedAt: a.at });
      else if (a.wo.status !== "open") await setWorkOrderStatus(trx, a.organizationId, a.wo, "open", a.at);
    }
    await workOrderEvent(trx, req, {
      organizationId: a.organizationId,
      workOrderId: a.wo.id,
      eventType: "visit_completed",
      summary: a.finalVisit ? "Visit completed; work done" : "Visit completed; another visit is needed",
      details: { jobId: a.jobId, recordId: a.recordId, finalVisit: a.finalVisit },
      homeownerVisible: true,
      at: a.at,
    });
    await audit(trx, req, { action: "work_record.completed", entityType: "work_record", entityId: a.recordId, changes: { jobId: a.jobId, finalVisit: a.finalVisit } });
    // SW-6: the pump-out becomes a record when its field record completes, exactly once, whether
    // the technician completes it or the office accepts it from a held record. Credited to the
    // technician; whoever completed it is the one who recorded it.
    if (a.pumpOut) {
      const groupId = await insertPumpOut(trx, { organizationId: a.organizationId, recordId: a.recordId, pumpOut: a.pumpOut, completedAt: a.completedAt, recordedBy: req.requireAuth().userId });
      await audit(trx, req, { action: "pumping_record.recorded", entityType: "pumping_record", entityId: groupId, changes: { recordId: a.recordId, volume: a.pumpOut.volume, unit: a.pumpOut.unit } });
    }
  }

  // ---- Photos and signatures ----

  /**
   * Who an upload for this record client id goes to: its record (normal path), its conflict
   * (held, or already resolved), or nothing yet: 409 record_not_synced, which the phone retries.
   */
  async function uploadOwner(trx: Trx, organizationId: string, userId: string, clientId: string) {
    const settled = await findConflict(trx, organizationId, clientId);
    if (settled && settled.status !== "held") {
      if (settled.technicianUserId !== userId) throw notAssigned();
      return { kind: "resolved" as const, c: settled, templateId: null, jobId: settled.jobId };
    }
    const record = await findRecord(trx, organizationId, clientId);
    if (record) {
      if (record.technicianUserId !== userId) throw notAssigned();
      return { kind: "record" as const, record, templateId: record.templateId, jobId: record.jobId };
    }
    const c = await findConflict(trx, organizationId, clientId);
    if (c) {
      if (c.technicianUserId !== userId) throw notAssigned();
      const templateId = (c.payload as { templateId?: string } | null)?.templateId ?? null;
      return { kind: c.status === "held" ? ("held" as const) : ("resolved" as const), c, templateId, jobId: c.jobId };
    }
    throw conflict("record_not_synced", "Send the record before its photos and signatures");
  }

  app.put(
    "/work/:clientId/photos/:photoClientId",
    {
      config: { permission: "work:complete", imageUpload: true },
      bodyLimit: MAX_PHOTO_BYTES,
      schema: {
        tags: ["work"],
        summary: "Upload one work photo as the raw image body (idempotent by photoClientId)",
        description: "Headers: x-photo-key (a photo requirement key), optional x-captured-at, x-lat, x-lng, x-sha256.",
        params: z.object({ clientId: z.uuid(), photoClientId: z.uuid() }),
        response: { 200: z.union([workPhoto, alreadyResolved]), 201: workPhoto, 202: heldForReview },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const headers = photoHeaders.safeParse(req.headers);
      if (!headers.success) throw new HttpError(400, "invalid_request", "Photo headers failed validation");
      const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, "invalid_request", "Send the image as the request body");
      const { clientId, photoClientId } = req.params;
      const h = headers.data;

      const out = await db.transaction().execute(async (trx) => {
        await clientLock(trx, organizationId, clientId);
        const owner = await uploadOwner(trx, organizationId, userId, clientId);
        if (owner.kind === "resolved") return { status: 200, body: resolved(owner.c) };
        const existing = await trx.selectFrom("workAttachments").select([...PHOTO_COLUMNS, "recordClientId"]).where("organizationId", "=", organizationId).where("offlineClientId", "=", photoClientId).executeTakeFirst();
        if (existing && existing.recordClientId !== clientId) throw conflict("client_id_reused", "This photo id belongs to another record");
        const answer = (photo: Parameters<typeof toPhoto>[1], created: boolean) =>
          owner.kind === "held" ? { status: 202, body: held(owner.c) } : { status: created ? 201 : 200, body: toPhoto(organizationId, photo) };
        if (existing) return answer(existing, false);
        if (owner.kind === "record" && owner.record.status === "completed") throw conflict("record_final", "Photos cannot be added to a completed record");
        if (owner.templateId) {
          const t = await workTemplate(trx, organizationId, owner.templateId);
          const keys = new Set(((t?.definition as TemplateDefinition | undefined)?.photos ?? []).map((p) => p.key));
          if (t && !keys.has(h["x-photo-key"])) throw unprocessable(`Unknown photo key ${h["x-photo-key"]}`);
        }
        const sha256 = createHash("sha256").update(body).digest("hex");
        if (h["x-sha256"] && h["x-sha256"] !== sha256) throw unprocessable("The photo was corrupted in transit; upload it again");
        // Keyed by the record's client id, which never changes, so the object stays put when
        // the record moves to a conflict or back.
        const storageKey = `${organizationId}/work/${clientId}/${photoClientId}.${PHOTO_TYPES[contentType] ?? "bin"}`;
        await store.put(storageKey, body, contentType);
        const inserted = await trx
          .insertInto("workAttachments")
          .values({ organizationId, offlineClientId: photoClientId, recordClientId: clientId, photoKey: h["x-photo-key"], storageKey, contentType, byteSize: body.length, sha256, capturedAt: h["x-captured-at"] ?? null, lat: h["x-lat"] ?? null, lng: h["x-lng"] ?? null, uploadedBy: userId })
          .returning(PHOTO_COLUMNS)
          .executeTakeFirstOrThrow();
        return answer(inserted, true);
      });
      return reply.status(out.status as 200 | 201 | 202).send(out.body as never);
    },
  );

  app.put(
    "/work/:clientId/signatures/:signatureClientId",
    {
      config: { permission: "work:complete" },
      schema: {
        tags: ["work"],
        summary: "Upload a customer's signature on the work summary (idempotent by signatureClientId)",
        description: "The summary is hashed (sha256 of its canonical JSON) and must match summarySha256. Completing the record later checks the record's summary against it.",
        params: z.object({ clientId: z.uuid(), signatureClientId: z.uuid() }),
        body: workSignatureUpload,
        response: { 200: z.union([workSignature, alreadyResolved]), 201: workSignature, 202: heldForReview },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const { clientId, signatureClientId } = req.params;
      const b = req.body;
      if ((await snapshotSha256(b.summary)) !== b.summarySha256) throw unprocessable("summarySha256 is not the sha256 of the summary sent");

      const out = await db.transaction().execute(async (trx) => {
        await clientLock(trx, organizationId, clientId);
        const owner = await uploadOwner(trx, organizationId, userId, clientId);
        if (owner.kind === "resolved") return { status: 200, body: resolved(owner.c) };
        const SIGNATURE_COLUMNS = ["id", "offlineClientId", "recordClientId", "requirementKey", "signerName", "signatureKind", "contentSha256", "signedAt"] as const;
        const existing = await trx.selectFrom("signedDocuments").select(SIGNATURE_COLUMNS).where("organizationId", "=", organizationId).where("offlineClientId", "=", signatureClientId).executeTakeFirst();
        if (existing && existing.recordClientId !== clientId) throw conflict("client_id_reused", "This signature id belongs to another record");
        const toSignature = (s: NonNullable<typeof existing>) => ({ id: s.id, clientId: s.offlineClientId!, requirementKey: s.requirementKey!, signerName: s.signerName, signatureKind: s.signatureKind, contentSha256: s.contentSha256, signedAt: s.signedAt.toISOString() });
        const answer = (s: NonNullable<typeof existing>, created: boolean) => (owner.kind === "held" ? { status: 202, body: held(owner.c) } : { status: created ? 201 : 200, body: toSignature(s) });
        if (existing) return answer(existing, false);
        if (owner.kind === "record" && owner.record.status === "completed") throw conflict("record_final", "A completed record cannot be signed again");
        if (owner.templateId) {
          const t = await workTemplate(trx, organizationId, owner.templateId);
          const keys = new Set(((t?.definition as TemplateDefinition | undefined)?.signatures ?? []).map((s) => s.key));
          if (t && !keys.has(b.requirementKey)) throw unprocessable(`Unknown signature requirement ${b.requirementKey}`);
        }
        const site = await trx
          .selectFrom("jobs as j")
          .innerJoin("sites as s", (k) => k.onRef("s.id", "=", "j.siteId").onRef("s.organizationId", "=", "j.organizationId"))
          .select(["s.id", "s.customerId"])
          .where("j.organizationId", "=", organizationId)
          .where("j.id", "=", owner.jobId)
          .executeTakeFirstOrThrow();
        const inserted = await trx
          .insertInto("signedDocuments")
          .values({
            organizationId,
            kind: "work_completion",
            renewalId: null,
            siteId: site.id,
            customerId: site.customerId,
            title: "Work completion sign-off",
            content: JSON.stringify(b.summary),
            contentSha256: b.summarySha256,
            signerName: b.signerName,
            signatureKind: b.capture.kind,
            signatureImage: b.capture.kind === "drawn" ? b.capture.image : null,
            consentText: b.consentText,
            signedAt: b.signedAt,
            ipAddress: req.ip ?? null,
            userAgent: req.headers["user-agent"]?.slice(0, 500) ?? null,
            pdfStorageKey: null,
            pdfSha256: null,
            pdfByteSize: null,
            offlineClientId: signatureClientId,
            recordClientId: clientId,
            requirementKey: b.requirementKey,
          })
          .returning(SIGNATURE_COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "work_signature.received", entityType: "signed_document", entityId: inserted.id, changes: { recordClientId: clientId, requirementKey: b.requirementKey, held: owner.kind === "held" } });
        return answer(inserted, true);
      });
      return reply.status(out.status as 200 | 201 | 202).send(out.body as never);
    },
  );

  // ---- The technician's work visits ----

  app.get(
    "/work/route",
    {
      config: { permission: "work:complete" },
      schema: {
        tags: ["work"],
        summary: "The signed-in technician's work visits for a day, with the form each uses",
        querystring: z.object({ date: z.iso.date().optional() }),
        response: { 200: z.object({ date: z.iso.date(), items: z.array(workStop) }) },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      // The company's today, as the inspection route uses, not the server's UTC date.
      const day = req.query.date ?? (await organizationToday(db, organizationId, now()));
      if (!enabled) return { date: day, items: [] };
      const rows = await db
        .selectFrom("jobs as j")
        .innerJoin("workOrders as w", (k) => k.onRef("w.id", "=", "j.workOrderId").onRef("w.organizationId", "=", "j.organizationId"))
        .innerJoin("workTypes as t", (k) => k.onRef("t.id", "=", "w.workTypeId").onRef("t.organizationId", "=", "w.organizationId"))
        .innerJoin("sites as s", (k) => k.onRef("s.id", "=", "j.siteId").onRef("s.organizationId", "=", "j.organizationId"))
        .innerJoin("customers as c", (k) => k.onRef("c.id", "=", "s.customerId").onRef("c.organizationId", "=", "s.organizationId"))
        .leftJoin("workRecords as r", "r.jobId", "j.id")
        .select([
          "j.id as jobId",
          "j.workOrderId",
          "j.visitNumber",
          "j.scheduledDate",
          "j.routePosition",
          "j.status",
          "j.notes",
          "j.siteId",
          "w.number",
          "w.title",
          "w.description",
          "t.name as workTypeName",
          "w.category",
          "t.defaultDurationMinutes",
          "t.defaultFormTemplateKey",
          "t.requiresDisposalRecord",
          "c.displayName as customerName",
          "s.addressLine1",
          "s.city",
          "s.lat",
          "s.lng",
          "r.offlineClientId as recordClientId",
          "r.status as recordStatus",
          "r.technicianUserId as recordTechnicianId",
          jsonText("w.coverageSnapshot").as("coverageText"),
        ])
        .where("j.organizationId", "=", organizationId)
        .where("j.type", "=", "work")
        .where("j.technicianUserId", "=", userId)
        .where("j.scheduledDate", "=", day)
        .where("j.status", "<>", "cancelled")
        .orderBy("j.routePosition")
        .execute();
      const forms = new Map((await currentForms(db, organizationId, { purpose: "work" })).map((f) => [f.key, f.id]));
      return {
        date: day,
        items: rows.map((r) => ({
          jobId: r.jobId,
          workOrderId: r.workOrderId!,
          workOrderLabel: workOrderLabel(r.number),
          title: r.title,
          description: r.description,
          workTypeName: r.workTypeName,
          category: r.category,
          durationMinutes: r.defaultDurationMinutes,
          visitNumber: r.visitNumber!,
          scheduledDate: r.scheduledDate,
          routePosition: r.routePosition,
          status: r.status,
          siteId: r.siteId,
          customerName: r.customerName,
          address: [r.addressLine1, r.city].filter(Boolean).join(", "),
          lat: r.lat,
          lng: r.lng,
          notes: r.notes,
          templateId: (r.defaultFormTemplateKey && forms.get(r.defaultFormTemplateKey)) || null,
          requiresDisposalRecord: features.has("pumping") && r.requiresDisposalRecord,
          record: r.recordClientId && r.recordTechnicianId === userId ? { clientId: r.recordClientId, status: r.recordStatus! } : null,
          ...(planBuilder ? { coverage: techCoverage(parseJson(r.coverageText)) } : {}),
        })),
      };
    },
  );

  // ---- The office reads records and settles held items ----

  app.get(
    "/work-records/:id",
    {
      config: { permission: "work:read" },
      schema: { tags: ["work"], summary: "One work visit's field record", params, response: { 200: workRecord } },
    },
    async (req) => {
      const { organizationId, role, userId } = req.requireAuth();
      const rec = await loadRecord(db, organizationId, req.params.id);
      if (role === "technician" && rec.technicianId !== userId) throw notFound("Work record");
      return rec;
    },
  );

  app.get(
    "/jobs/:id/work-record",
    {
      config: { permission: "work:read" },
      schema: { tags: ["work"], summary: "The field record for a work visit", params, response: { 200: workRecord } },
    },
    async (req) => {
      const { organizationId, role, userId } = req.requireAuth();
      const row = await db.selectFrom("workRecords").select(["id", "technicianUserId"]).where("organizationId", "=", organizationId).where("jobId", "=", req.params.id).executeTakeFirst();
      if (!row || (role === "technician" && row.technicianUserId !== userId)) throw notFound("Work record");
      return loadRecord(db, organizationId, row.id);
    },
  );

  async function loadConflicts(organizationId: string, where: { id?: string; status?: string }): Promise<WorkSyncConflict[]> {
    let q = db
      .selectFrom("workSyncConflicts as c")
      .innerJoin("workOrders as w", (k) => k.onRef("w.id", "=", "c.workOrderId").onRef("w.organizationId", "=", "c.organizationId"))
      .innerJoin("users as u", "u.id", "c.technicianUserId")
      .select([
        "c.id",
        "c.offlineClientId",
        "c.jobId",
        "c.workOrderId",
        "w.number",
        "c.technicianUserId",
        "u.name as technicianName",
        "c.reason",
        "c.status",
        jsonText("c.payload").as("payloadText"),
        "c.resolutionNote",
        "c.resolvedAt",
        "c.attachedJobId",
        "c.createdAt",
        (eb) => eb.selectFrom("workAttachments as a").select(sql<number>`count(*)`.as("n")).whereRef("a.organizationId", "=", "c.organizationId").whereRef("a.recordClientId", "=", "c.offlineClientId").as("photoCount"),
        (eb) => eb.selectFrom("signedDocuments as d").select(sql<number>`count(*)`.as("n")).whereRef("d.organizationId", "=", "c.organizationId").whereRef("d.recordClientId", "=", "c.offlineClientId").as("signatureCount"),
      ])
      .where("c.organizationId", "=", organizationId);
    if (where.id) q = q.where("c.id", "=", where.id);
    if (where.status) q = q.where("c.status", "=", where.status as "held");
    const rows = await q.orderBy("c.createdAt", "desc").limit(200).execute();
    return rows.map((r) => ({
      id: r.id,
      clientId: r.offlineClientId,
      jobId: r.jobId,
      workOrderId: r.workOrderId,
      workOrderLabel: workOrderLabel(r.number),
      technicianId: r.technicianUserId,
      technicianName: r.technicianName,
      reason: r.reason,
      status: r.status,
      payload: (parseJson(r.payloadText) as Record<string, unknown> | null) ?? null,
      photoCount: Number(r.photoCount ?? 0),
      signatureCount: Number(r.signatureCount ?? 0),
      resolutionNote: r.resolutionNote,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      attachedJobId: r.attachedJobId,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  app.get(
    "/work/conflicts",
    {
      config: { permission: "work:write" },
      schema: {
        tags: ["work"],
        summary: "Field records held for the office because the visit changed while the phone was offline",
        querystring: z.object({ status: z.enum(["held", "attached", "dismissed"]).optional() }),
        response: { 200: z.object({ items: z.array(workSyncConflict) }) },
      },
    },
    async (req) => ({ items: await loadConflicts(req.requireAuth().organizationId, { status: req.query.status }) }),
  );

  app.get(
    "/work/conflicts/:id",
    { config: { permission: "work:write" }, schema: { tags: ["work"], summary: "One held field record", params, response: { 200: workSyncConflict } } },
    async (req) => {
      const [c] = await loadConflicts(req.requireAuth().organizationId, { id: req.params.id });
      if (!c) throw notFound("Held record");
      return c;
    },
  );

  /** Locks a held conflict for a decision, after its client id and its work order. */
  async function lockHeld(trx: Trx, organizationId: string, id: string) {
    const peek = await trx.selectFrom("workSyncConflicts").select(["offlineClientId", "workOrderId"]).where("organizationId", "=", organizationId).where("id", "=", id).executeTakeFirst();
    if (!peek) throw notFound("Held record");
    await clientLock(trx, organizationId, peek.offlineClientId);
    const wo = await lockWorkOrder(trx, organizationId, peek.workOrderId);
    const c = await trx
      .selectFrom("workSyncConflicts")
      .selectAll()
      .select(jsonText("payload").as("payloadText"))
      .where("organizationId", "=", organizationId)
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (c.status !== "held") throw conflict("already_resolved", `This record was already ${c.status}`);
    return { wo, c };
  }

  app.post(
    "/work/conflicts/:id/attach",
    {
      config: { permission: "work:write" },
      schema: {
        tags: ["work"],
        summary: "Accept a held field record as submitted by its technician",
        description:
          "Recorded on its own visit when that visit is still open and has no record; otherwise on a new completed visit of the same " +
          "work order, so a cancellation and the work both stay in the history. On a work order the office completed without a " +
          "field record, it becomes that record.",
        params,
        body: conflictAttachInput,
        response: { 200: workSyncConflict },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      await db.transaction().execute(async (trx) => {
        const { wo, c } = await lockHeld(trx, organizationId, req.params.id);
        const payload = workSync.safeParse(parseJson(c.payloadText));
        if (!payload.success || payload.data.status !== "completed") throw conflict("not_finished", "The technician has not finished this record on the phone yet");
        const p = payload.data;
        // The form version the record was started on, even if the company has since saved a newer one.
        const template = await workTemplate(trx, organizationId, p.templateId);
        if (!template) throw unprocessable("The record's form is not available to this organization");
        // Accepted only as the technician could have completed it: the same checks, against the
        // photos and signatures held for it. Refused, it stays held with everything kept.
        const definition = template.definition as TemplateDefinition;
        const unknown = unknownKeys(definition, p.values);
        if (unknown.length) throw conflict("record_incomplete", `The record has answers its form does not ask: ${unknown.join(", ")}`);
        const check = await completionCheck(trx, organizationId, c.offlineClientId, definition, p.values, p.summary, { workOrderId: wo.id, pumpOut: p.pumpOut, finalVisit: p.finalVisit });
        if (check.mismatch) throw signatureMismatch();
        if (check.problems.length) throw conflict("record_incomplete", `The record is not complete: ${check.problems.map((x) => x.message).join("; ")}`);

        const job = await trx.selectFrom("jobs").select(["id", "status", "siteId", "scheduledDate"]).where("organizationId", "=", organizationId).where("id", "=", c.jobId).forUpdate().executeTakeFirstOrThrow();
        const hasRecord = await trx.selectFrom("workRecords").select("id").where("jobId", "=", job.id).executeTakeFirst();
        let targetJobId = job.id;
        if (!(job.status === "scheduled" || job.status === "in_progress") || hasRecord) {
          const next = await trx.selectFrom("jobs").select(sql<number>`coalesce(max(visit_number), 0) + 1`.as("n")).where("organizationId", "=", organizationId).where("workOrderId", "=", wo.id).executeTakeFirstOrThrow();
          const created = await trx
            .insertInto("jobs")
            .values({
              organizationId,
              type: "work",
              workOrderId: wo.id,
              visitNumber: Number(next.n),
              siteId: job.siteId,
              obligationId: null,
              status: "completed",
              stateMachineVersion: JOB_STATE_MACHINE.version,
              scheduledDate: p.arrivedAt.slice(0, 10),
              technicianUserId: c.technicianUserId,
              routePosition: 0,
              notes: "Field record accepted by the office after the visit changed",
              cancelledAt: null,
              cancelReason: null,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
          targetJobId = created.id;
        }
        const rec = await trx
          .insertInto("workRecords")
          .values({
            organizationId,
            offlineClientId: c.offlineClientId,
            jobId: targetJobId,
            workOrderId: wo.id,
            siteId: job.siteId,
            technicianUserId: c.technicianUserId,
            templateId: template.id,
            answers: JSON.stringify(check.values),
            summary: p.summary ? JSON.stringify(p.summary) : null,
            summarySha256: check.summarySha256,
            finalVisit: p.finalVisit,
            phoneRevision: c.phoneRevision,
            arrivedAt: p.arrivedAt,
            arrivalLat: p.arrivalGps?.lat ?? null,
            arrivalLng: p.arrivalGps?.lng ?? null,
            completionLat: p.completionGps?.lat ?? null,
            completionLng: p.completionGps?.lng ?? null,
            locationStatus: p.locationStatus ?? (p.arrivalGps ? "recorded" : null),
            completedAt: null,
            attachedBy: userId,
            updatedAt: at,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await completeRecord(trx, req, { organizationId, recordId: rec.id, wo, jobId: targetJobId, finalVisit: p.finalVisit, completedAt: p.completedAt ? new Date(p.completedAt) : at, at, attachedBy: userId, pumpOut: p.pumpOut });
        // The office had completed it without a field record: this is that record now.
        if (wo.status === "completed") {
          await trx.updateTable("workOrders").set({ completedWithoutRecordReason: null, updatedAt: at }).where("organizationId", "=", organizationId).where("id", "=", wo.id).execute();
        }
        await trx
          .updateTable("workSyncConflicts")
          .set({ status: "attached", resolvedAt: at, resolvedBy: userId, attachedJobId: targetJobId, resolutionNote: req.body.note ?? null, updatedAt: at })
          .where("organizationId", "=", organizationId)
          .where("id", "=", c.id)
          .execute();
        await workOrderEvent(trx, req, { organizationId, workOrderId: wo.id, eventType: "field_record_attached", summary: "Held field record accepted by the office", details: { conflictId: c.id, jobId: targetJobId, recordId: rec.id }, at });
        // Credited to the technician who did the work; the office user is who accepted it.
        await audit(trx, req, { action: "work_record.attached", entityType: "work_record", entityId: rec.id, changes: { conflictId: c.id, technicianUserId: c.technicianUserId, jobId: targetJobId } });
      });
      const [c] = await loadConflicts(organizationId, { id: req.params.id });
      return c!;
    },
  );

  app.post(
    "/work/conflicts/:id/dismiss",
    {
      config: { permission: "work:write" },
      schema: { tags: ["work"], summary: "Set a held field record aside, saying why (its photos and signatures are kept)", params, body: conflictDismissInput, response: { 200: workSyncConflict } },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      await db.transaction().execute(async (trx) => {
        const { wo, c } = await lockHeld(trx, organizationId, req.params.id);
        await trx
          .updateTable("workSyncConflicts")
          .set({ status: "dismissed", resolvedAt: at, resolvedBy: userId, resolutionNote: req.body.reason, updatedAt: at })
          .where("organizationId", "=", organizationId)
          .where("id", "=", c.id)
          .execute();
        await workOrderEvent(trx, req, { organizationId, workOrderId: wo.id, eventType: "field_record_dismissed", summary: `Held field record set aside: ${req.body.reason}`, details: { conflictId: c.id }, at });
        await audit(trx, req, { action: "work_record.dismissed", entityType: "work_sync_conflict", entityId: c.id, changes: { reason: req.body.reason, technicianUserId: c.technicianUserId } });
      });
      const [c] = await loadConflicts(organizationId, { id: req.params.id });
      return c!;
    },
  );

  // ---- Photo links ----

  app.get(
    "/work-files/:id",
    {
      config: { public: true },
      schema: { tags: ["files"], summary: "Download a work photo through a signed link", params, querystring: z.object({ exp: z.coerce.number().int(), sig: z.string().max(100) }) },
    },
    async (req, reply) => {
      const row = await db.selectFrom("workAttachments").select(["id", "organizationId", "storageKey", "contentType"]).where("id", "=", req.params.id).executeTakeFirst();
      if (!row || !signer.verify(row.organizationId, row.id, req.query.exp, req.query.sig, now().getTime(), "work-files")) throw notFound("File");
      const data = await readForDownload(db, store, row.storageKey);
      if (!data) throw notFound("File");
      return reply.type(row.contentType).header("x-content-type-options", "nosniff").send(data);
    },
  );

};
