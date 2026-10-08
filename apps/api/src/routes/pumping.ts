import { createHash, randomUUID } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import {
  disposalFacility,
  disposalAck,
  disposalLoad,
  disposalLoadCorrectionInput,
  disposalLoadDetail,
  disposalLoadSync,
  facilityInput,
  facilityPatch,
  formatGallons,
  loadItemAddInput,
  loadItemRemoveInput,
  manifestPhoto,
  pageQuery,
  pumpingCorrectionInput,
  pumpingFieldData,
  pumpingRecord,
  pumpingRecordDetail,
  pumpingSettings,
  roleHasPermission,
  toMilligallons,
  vehicle,
  vehicleInput,
  vehiclePatch,
  WASTE_TYPE_LABELS,
  type DisposalLoadSync,
  type Feature,
  type Role,
} from "@aerowise/domain";
import { renderDisposalLog, watermarkPdf } from "@aerowise/reports";
import type { ObjectStore } from "@aerowise/storage";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { readLoads, readPumpingRecords, volumeText } from "../lib/pumping.ts";
import { organizationToday } from "../lib/today.ts";
import type { UrlSigner } from "../storage/signed-urls.ts";

// SW-6: trucks, disposal facilities, pump-out history and corrections, and disposal loads with
// their manifest photos (service workflows plan §2). A pump-out is recorded with its visit's
// field record (routes/work-sync.ts); everything here reads and corrects it by its group.
//
// Corrections never change a row: the current revision is locked, marked not current, and the
// next revision is inserted in the same transaction. A load's pump-outs are linked by group,
// so either side's corrections keep the link; adding or removing one is an explicit action.

type Trx = Transaction<DB>;

const params = z.object({ id: z.uuid() });
const groupParams = z.object({ groupId: z.uuid() });
const range = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};
const photoHeaders = z.object({
  "x-photo-key": z.literal("manifest").optional(),
  "x-captured-at": z.iso.datetime({ offset: true }).optional(),
  "x-lat": z.coerce.number().min(-90).max(90).optional(),
  "x-lng": z.coerce.number().min(-180).max(180).optional(),
  "x-sha256": z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const conflict = (code: string, message: string) => new HttpError(409, code, message);
const pumpingOff = () => new HttpError(409, "feature_off", "Pumping records are not switched on for this deployment");
const notYours = () => new HttpError(403, "not_assigned", "Only the office can record another technician's pump-outs");

export const pumpingRoutes: FastifyPluginAsyncZod<{
  db: Database;
  now: () => Date;
  store: ObjectStore;
  signer: UrlSigner;
  features: ReadonlySet<Feature>;
}> = async (app, { db, now, store, signer, features }) => {
  const enabled = features.has("pumping");
  app.addContentTypeParser(Object.keys(PHOTO_TYPES), { parseAs: "buffer", bodyLimit: MAX_PHOTO_BYTES }, (_req, body, done) => done(null, body));

  const photoUrl = (organizationId: string) => (photoId: string) => signer.url(organizationId, photoId, now().getTime(), "work-files");
  const may = (role: Role, p: "work:write" | "work:complete") => roleHasPermission(role, p);
  /** A technician reads only their own work, as with field records. */
  const ownWork = (role: Role, userId: string) => (role === "technician" ? { technicianUserId: userId } : {});
  /** One load client id at a time: its sync and its photo uploads queue behind each other. */
  const clientLock = (trx: Trx, organizationId: string, clientId: string) =>
    sql`select pg_advisory_xact_lock(hashtext(${`disposal-client:${organizationId}:${clientId}`}))`.execute(trx);

  // ---- Trucks ----

  const VEHICLE_COLUMNS = ["id", "name", "plate", "capacityGallons", "registrationReference", "active"] as const;

  app.get(
    "/vehicles",
    { config: { permission: "work:read" }, schema: { tags: ["pumping"], summary: "The company's trucks", response: { 200: z.object({ items: z.array(vehicle) }) } } },
    async (req) => ({
      items: await db.selectFrom("vehicles").select(VEHICLE_COLUMNS).where("organizationId", "=", req.requireAuth().organizationId).orderBy("active", "desc").orderBy("name").execute(),
    }),
  );

  app.post(
    "/vehicles",
    { config: { permission: "work:write" }, schema: { tags: ["pumping"], summary: "Add a truck", body: vehicleInput, response: { 201: vehicle } } },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      if (!enabled) throw pumpingOff();
      const b = req.body;
      const v = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto("vehicles")
          .values({ organizationId, name: b.name, plate: b.plate ?? null, capacityGallons: b.capacityGallons ?? null, registrationReference: b.registrationReference ?? null, active: b.active, updatedAt: now() })
          .returning(VEHICLE_COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "vehicle.created", entityType: "vehicle", entityId: row.id, changes: b });
        return row;
      });
      return reply.status(201).send(v);
    },
  );

  app.patch(
    "/vehicles/:id",
    { config: { permission: "work:write" }, schema: { tags: ["pumping"], summary: "Change or switch off a truck (records keep naming it)", params, body: vehiclePatch, response: { 200: vehicle } } },
    async (req) => {
      const { organizationId } = req.requireAuth();
      return db.transaction().execute(async (trx) => {
        const row = await trx
          .updateTable("vehicles")
          .set({ ...req.body, updatedAt: now() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .returning(VEHICLE_COLUMNS)
          .executeTakeFirst();
        if (!row) throw notFound("Vehicle");
        await audit(trx, req, { action: "vehicle.updated", entityType: "vehicle", entityId: row.id, changes: req.body });
        return row;
      });
    },
  );

  // ---- Disposal facilities, entered by the company ----

  const FACILITY_COLUMNS = [
    "id",
    "name",
    "kind",
    "addressLine1",
    "city",
    "state",
    "postalCode",
    "lat",
    "lng",
    "permitOrRegistrationNumber",
    "source",
    "sourceUrl",
    "sourceRetrievedOn",
    "notes",
    "active",
  ] as const;

  app.get(
    "/disposal-facilities",
    { config: { permission: "work:read" }, schema: { tags: ["pumping"], summary: "Disposal facilities the company has entered", response: { 200: z.object({ items: z.array(disposalFacility) }) } } },
    async (req) => ({
      items: await db.selectFrom("disposalFacilities").select(FACILITY_COLUMNS).where("organizationId", "=", req.requireAuth().organizationId).orderBy("active", "desc").orderBy("name").execute(),
    }),
  );

  app.post(
    "/disposal-facilities",
    {
      config: { permission: "work:write" },
      schema: {
        tags: ["pumping"],
        summary: "Add a disposal facility by hand",
        description: "No facility list is shipped or imported; the company enters the facilities it uses.",
        body: facilityInput,
        response: { 201: disposalFacility },
      },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      if (!enabled) throw pumpingOff();
      const b = req.body;
      const f = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto("disposalFacilities")
          .values({
            organizationId,
            name: b.name,
            kind: b.kind,
            addressLine1: b.addressLine1 ?? null,
            city: b.city ?? null,
            state: b.state ?? null,
            postalCode: b.postalCode ?? null,
            lat: b.lat ?? null,
            lng: b.lng ?? null,
            permitOrRegistrationNumber: b.permitOrRegistrationNumber ?? null,
            sourceUrl: null,
            sourceRetrievedOn: null,
            notes: b.notes ?? null,
            active: b.active,
            updatedAt: now(),
          })
          .returning(FACILITY_COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "disposal_facility.created", entityType: "disposal_facility", entityId: row.id, changes: b });
        return row;
      });
      return reply.status(201).send(f);
    },
  );

  app.patch(
    "/disposal-facilities/:id",
    { config: { permission: "work:write" }, schema: { tags: ["pumping"], summary: "Change or switch off a facility (loads keep naming it)", params, body: facilityPatch, response: { 200: disposalFacility } } },
    async (req) => {
      const { organizationId } = req.requireAuth();
      return db.transaction().execute(async (trx) => {
        const row = await trx
          .updateTable("disposalFacilities")
          .set({ ...req.body, updatedAt: now() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .returning(FACILITY_COLUMNS)
          .executeTakeFirst();
        if (!row) throw notFound("Disposal facility");
        await audit(trx, req, { action: "disposal_facility.updated", entityType: "disposal_facility", entityId: row.id, changes: req.body });
        return row;
      });
    },
  );

  // ---- The company's grace days for a disposal record ----

  const settings = (organizationId: string) => db.selectFrom("organizations").select("disposalOverdueDays").where("id", "=", organizationId).executeTakeFirstOrThrow();

  app.get(
    "/pumping/settings",
    { config: { permission: "work:read" }, schema: { tags: ["pumping"], summary: "The inbox raises a missing disposal record once a pump-out is more than this many days old", response: { 200: pumpingSettings } } },
    async (req) => settings(req.requireAuth().organizationId),
  );

  app.patch(
    "/pumping/settings",
    {
      config: { permission: "org:manage" },
      schema: { tags: ["pumping"], summary: "Change how many days old (more than; 1 to 60) a pump-out with no disposal record is before the inbox raises it", body: pumpingSettings, response: { 200: pumpingSettings } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      if (!enabled) throw pumpingOff();
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("organizations").set({ disposalOverdueDays: req.body.disposalOverdueDays }).where("id", "=", organizationId).execute();
        await audit(trx, req, { action: "organization.updated", entityType: "organization", entityId: organizationId, changes: req.body });
      });
      return settings(organizationId);
    },
  );

  // ---- What the phone caches ----

  app.get(
    "/pumping/field",
    {
      config: { permission: "work:complete" },
      schema: { tags: ["pumping"], summary: "Trucks, facilities and the signed-in technician's pump-outs in no load, for recording disposal offline", response: { 200: pumpingFieldData } },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      if (!enabled) return { vehicles: [], facilities: [], unloaded: [] };
      const [vehicles, facilities, unloaded] = await Promise.all([
        db.selectFrom("vehicles").select(VEHICLE_COLUMNS).where("organizationId", "=", organizationId).where("active", "=", true).orderBy("name").execute(),
        db.selectFrom("disposalFacilities").select(FACILITY_COLUMNS).where("organizationId", "=", organizationId).where("active", "=", true).orderBy("name").execute(),
        readPumpingRecords(db, organizationId, { technicianUserId: userId, unloaded: true }),
      ]);
      return { vehicles, facilities, unloaded };
    },
  );

  // ---- Pump-outs ----

  app.get(
    "/pumping-records",
    {
      config: { permission: "work:read" },
      schema: {
        tags: ["pumping"],
        summary: "Pump-outs at their current revision: a site's pumping history, a work order's, or those in no load",
        querystring: z.object({ siteId: z.uuid().optional(), workOrderId: z.uuid().optional(), unloaded: z.stringbool().optional(), ...range.shape, ...pageQuery.shape }),
        response: { 200: z.object({ items: z.array(pumpingRecord), nextOffset: z.number().int().nullable() }) },
      },
    },
    async (req) => {
      const { organizationId, role, userId } = req.requireAuth();
      const q = req.query;
      const rows = await readPumpingRecords(
        db,
        organizationId,
        { siteId: q.siteId, workOrderId: q.workOrderId, unloaded: q.unloaded, from: q.from, to: q.to, newestFirst: true, ...ownWork(role, userId) },
        { limit: q.limit + 1, offset: q.offset },
      );
      return { items: rows.slice(0, q.limit), nextOffset: rows.length > q.limit ? q.offset + q.limit : null };
    },
  );

  /** One revision's line in a group's history. */
  const pumpOutSummary = (r: { enteredVolume: string; enteredUnit: "gallons" | "liters"; volumeMilligallons: string; wasteType: keyof typeof WASTE_TYPE_LABELS; serviceDate: string }) =>
    `${volumeText(Number(r.enteredVolume), r.enteredUnit, Number(r.volumeMilligallons))} of ${WASTE_TYPE_LABELS[r.wasteType].toLowerCase()} on ${r.serviceDate}`;

  async function pumpingDetail(organizationId: string, groupId: string, role: Role, userId: string) {
    const [current] = await readPumpingRecords(db, organizationId, { groupIds: [groupId] });
    if (!current || (role === "technician" && current.technicianId !== userId)) throw notFound("Pump-out");
    const revisions = await db
      .selectFrom("pumpingRecords as p")
      .innerJoin("users as u", "u.id", "p.recordedBy")
      .select(["p.revision", "p.isCurrent", "p.enteredVolume", "p.enteredUnit", "p.volumeMilligallons", "p.wasteType", "p.serviceDate", "p.correctionReason", "u.name", "p.createdAt"])
      .where("p.organizationId", "=", organizationId)
      .where("p.groupId", "=", groupId)
      .orderBy("p.revision")
      .execute();
    return {
      ...current,
      revisions: revisions.map((r) => ({ revision: r.revision, current: r.isCurrent, summary: pumpOutSummary(r), correctionReason: r.correctionReason, recordedByName: r.name, createdAt: r.createdAt.toISOString() })),
    };
  }

  app.get(
    "/pumping-records/:groupId",
    { config: { permission: "work:read" }, schema: { tags: ["pumping"], summary: "A pump-out with every revision", params: groupParams, response: { 200: pumpingRecordDetail } } },
    async (req) => {
      const { organizationId, role, userId } = req.requireAuth();
      return pumpingDetail(organizationId, req.params.groupId, role, userId);
    },
  );

  /** The current revision of a pump-out group, locked for a change. */
  async function lockPumpOut(trx: Trx, organizationId: string, groupId: string) {
    const row = await trx.selectFrom("pumpingRecords").selectAll().where("organizationId", "=", organizationId).where("groupId", "=", groupId).where("isCurrent", "=", true).forUpdate().executeTakeFirst();
    if (!row) throw notFound("Pump-out");
    return row;
  }

  async function checkVehicle(ex: Database | Trx, organizationId: string, vehicleId: string | null | undefined) {
    if (!vehicleId) return;
    const v = await ex.selectFrom("vehicles").select("id").where("organizationId", "=", organizationId).where("id", "=", vehicleId).executeTakeFirst();
    if (!v) throw notFound("Vehicle");
  }

  app.post(
    "/pumping-records/:groupId/correct",
    {
      config: { permission: "work:write" },
      schema: {
        tags: ["pumping"],
        summary: "Correct a pump-out: its next revision replaces it everywhere it is counted",
        description: "The pump-out stays in its load. The load's total is not changed; a difference is shown, not refused.",
        params: groupParams,
        body: pumpingCorrectionInput,
        response: { 200: pumpingRecordDetail },
      },
    },
    async (req) => {
      const { organizationId, userId, role } = req.requireAuth();
      const b = req.body;
      await db.transaction().execute(async (trx) => {
        const cur = await lockPumpOut(trx, organizationId, req.params.groupId);
        await checkVehicle(trx, organizationId, b.vehicleId);
        await trx.updateTable("pumpingRecords").set({ isCurrent: false }).where("organizationId", "=", organizationId).where("id", "=", cur.id).execute();
        const id = randomUUID();
        await trx
          .insertInto("pumpingRecords")
          .values({
            id,
            organizationId,
            groupId: cur.groupId,
            revision: cur.revision + 1,
            correctionReason: b.reason,
            offlineClientId: null,
            workOrderId: cur.workOrderId,
            jobId: cur.jobId,
            workRecordId: cur.workRecordId,
            siteId: cur.siteId,
            technicianUserId: cur.technicianUserId,
            vehicleId: b.vehicleId ?? null,
            serviceDate: b.serviceDate,
            wasteType: b.wasteType,
            wasteTypeNote: b.wasteTypeNote ?? null,
            tanks: JSON.stringify(b.tanks),
            enteredVolume: b.volume,
            enteredUnit: b.unit,
            volumeMilligallons: toMilligallons(b.volume, b.unit),
            recordedBy: userId,
          })
          .execute();
        await audit(trx, req, {
          action: "pumping_record.corrected",
          entityType: "pumping_record",
          entityId: cur.groupId,
          changes: { revision: cur.revision + 1, reason: b.reason, from: { volume: Number(cur.enteredVolume), unit: cur.enteredUnit }, to: { volume: b.volume, unit: b.unit } },
        });
      });
      return pumpingDetail(organizationId, req.params.groupId, role, userId);
    },
  );

  // ---- Loads ----

  app.get(
    "/disposal/loads",
    {
      config: { permission: "work:read" },
      schema: {
        tags: ["pumping"],
        summary: "Disposal records (loads) by delivery date, newest first, a page at a time",
        querystring: range.extend(pageQuery.shape),
        response: { 200: z.object({ items: z.array(disposalLoad), nextOffset: z.number().int().nullable() }) },
      },
    },
    async (req) => {
      const { organizationId, role, userId } = req.requireAuth();
      const q = req.query;
      const rows = await readLoads(db, organizationId, { from: q.from, to: q.to, ...ownWork(role, userId) }, photoUrl(organizationId), { limit: q.limit + 1, offset: q.offset });
      return { items: rows.slice(0, q.limit), nextOffset: rows.length > q.limit ? q.offset + q.limit : null };
    },
  );

  const loadSummary = (r: { enteredTotal: string; enteredUnit: "gallons" | "liters"; totalMilligallons: string; deliveredOn: string; manifestReference: string | null }) =>
    `${volumeText(Number(r.enteredTotal), r.enteredUnit, Number(r.totalMilligallons))} delivered on ${r.deliveredOn}${r.manifestReference ? `, reference ${r.manifestReference}` : ""}`;

  async function loadDetail(organizationId: string, groupId: string, who: { technicianUserId?: string } = {}) {
    const [current] = await readLoads(db, organizationId, { groupIds: [groupId], ...who }, photoUrl(organizationId));
    if (!current) throw notFound("Disposal record");
    const revisions = await db
      .selectFrom("disposalLoads as l")
      .innerJoin("users as u", "u.id", "l.recordedBy")
      .select(["l.revision", "l.isCurrent", "l.enteredTotal", "l.enteredUnit", "l.totalMilligallons", "l.deliveredOn", "l.manifestReference", "l.correctionReason", "u.name", "l.createdAt"])
      .where("l.organizationId", "=", organizationId)
      .where("l.groupId", "=", groupId)
      .orderBy("l.revision")
      .execute();
    return {
      ...current,
      revisions: revisions.map((r) => ({ revision: r.revision, current: r.isCurrent, summary: loadSummary(r), correctionReason: r.correctionReason, recordedByName: r.name, createdAt: r.createdAt.toISOString() })),
    };
  }

  app.get(
    "/disposal/loads/:groupId",
    { config: { permission: "work:read" }, schema: { tags: ["pumping"], summary: "A disposal record with its pump-outs, manifest photos and every revision", params: groupParams, response: { 200: disposalLoadDetail } } },
    async (req) => {
      const { organizationId, role, userId } = req.requireAuth();
      return loadDetail(organizationId, req.params.groupId, ownWork(role, userId));
    },
  );

  /**
   * Records a load, once per client id. A replay returns the load as recorded. Each pump-out is
   * locked at its current revision; one already in a load, on another truck, or (for a
   * technician) someone else's is refused, and nothing is stored.
   */
  async function recordLoad(trx: Trx, req: Parameters<typeof audit>[1], b: DisposalLoadSync & { pumpingGroupIds: string[] }) {
    const { organizationId, userId, role } = req.requireAuth();
    const office = may(role, "work:write");
    if (!office && !may(role, "work:complete")) throw new HttpError(403, "forbidden", "Your role does not allow this action");
    await clientLock(trx, organizationId, b.clientId);
    const existing = await trx.selectFrom("disposalLoads").select(["groupId", "recordedBy"]).where("organizationId", "=", organizationId).where("offlineClientId", "=", b.clientId).executeTakeFirst();
    if (existing) {
      if (!office && existing.recordedBy !== userId) throw conflict("client_id_reused", "This clientId belongs to another disposal record");
      return { groupId: existing.groupId, created: false };
    }
    if (!enabled) throw pumpingOff();
    const facility = await trx.selectFrom("disposalFacilities").select("id").where("organizationId", "=", organizationId).where("id", "=", b.facilityId).executeTakeFirst();
    if (!facility) throw notFound("Disposal facility");
    await checkVehicle(trx, organizationId, b.vehicleId);
    const groupIds = [...new Set(b.pumpingGroupIds)].sort();
    // Locked in one order, so two loads claiming the same pump-outs queue rather than deadlock.
    const pumpOuts = await trx
      .selectFrom("pumpingRecords")
      .select(["groupId", "technicianUserId", "vehicleId"])
      .where("organizationId", "=", organizationId)
      .where("groupId", "in", groupIds)
      .where("isCurrent", "=", true)
      .orderBy("groupId")
      .forUpdate()
      .execute();
    if (pumpOuts.length !== groupIds.length) throw notFound("Pump-out");
    if (!office && pumpOuts.some((p) => p.technicianUserId !== userId)) throw notYours();
    if (pumpOuts.some((p) => (p.vehicleId ?? null) !== (b.vehicleId ?? null))) throw conflict("vehicle_mismatch", "Every pump-out in a load must be on the load's truck");
    const taken = await trx.selectFrom("disposalLoadItems").select("pumpingGroupId").where("organizationId", "=", organizationId).where("pumpingGroupId", "in", groupIds).execute();
    if (taken.length) throw conflict("already_in_load", `${taken.length === 1 ? "A pump-out is" : `${taken.length} pump-outs are`} already in another disposal record`);
    const id = randomUUID();
    await trx
      .insertInto("disposalLoads")
      .values({
        id,
        organizationId,
        groupId: id,
        revision: 1,
        correctionReason: null,
        offlineClientId: b.clientId,
        vehicleId: b.vehicleId ?? null,
        disposalFacilityId: b.facilityId,
        deliveredOn: b.deliveredOn,
        manifestReference: b.manifestReference || null,
        enteredTotal: b.total,
        enteredUnit: b.unit,
        totalMilligallons: toMilligallons(b.total, b.unit),
        notes: b.notes || null,
        recordedBy: userId,
      })
      .execute();
    await trx
      .insertInto("disposalLoadItems")
      .values(groupIds.map((g) => ({ organizationId, loadGroupId: id, pumpingGroupId: g, addedBy: userId })))
      .execute()
      .catch((err) => {
        if ((err as { code?: string }).code === "23505") throw conflict("already_in_load", "A pump-out is already in another disposal record");
        throw err;
      });
    await audit(trx, req, { action: "disposal_load.recorded", entityType: "disposal_load", entityId: id, changes: { clientId: b.clientId, pumpingGroupIds: groupIds, total: b.total, unit: b.unit } });
    return { groupId: id, created: true };
  }

  app.put(
    "/disposal/loads/sync",
    {
      config: { permission: "work:read" },
      schema: {
        tags: ["pumping"],
        summary: "Record a disposal load, from the phone or the office (idempotent by clientId)",
        description:
          "A technician records their own pump-outs (work:complete); the office records anyone's (work:write). A replay returns " +
          "the record as first stored. 409 already_in_load when a pump-out is in another load; 409 vehicle_mismatch when it was on another truck.",
        body: disposalLoadSync,
        response: { 200: z.union([disposalLoad, disposalAck]), 201: disposalLoad },
      },
    },
    async (req, reply) => {
      const { organizationId, role, userId } = req.requireAuth();
      const out = await db.transaction().execute((trx) => recordLoad(trx, req, req.body));
      // A technician sees the load only while it is all their own work; after the office mixed
      // another technician's pump-outs in, a replay still learns it was recorded, and no more.
      const [load] = await readLoads(db, organizationId, { groupIds: [out.groupId], ...ownWork(role, userId) }, photoUrl(organizationId));
      if (!load) return reply.status(200).send({ outcome: "recorded", groupId: out.groupId, clientId: req.body.clientId });
      return reply.status(out.created ? 201 : 200).send(load);
    },
  );

  /** The current revision of a load group, locked for a change. */
  async function lockLoad(trx: Trx, organizationId: string, groupId: string) {
    const row = await trx.selectFrom("disposalLoads").selectAll().where("organizationId", "=", organizationId).where("groupId", "=", groupId).where("isCurrent", "=", true).forUpdate().executeTakeFirst();
    if (!row) throw notFound("Disposal record");
    return row;
  }

  app.post(
    "/disposal/loads/:groupId/correct",
    {
      config: { permission: "work:write" },
      schema: {
        tags: ["pumping"],
        summary: "Correct a disposal record: its pump-outs and manifest photos stay with it",
        params: groupParams,
        body: disposalLoadCorrectionInput,
        response: { 200: disposalLoadDetail },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const b = req.body;
      await db.transaction().execute(async (trx) => {
        const cur = await lockLoad(trx, organizationId, req.params.groupId);
        const facility = await trx.selectFrom("disposalFacilities").select("id").where("organizationId", "=", organizationId).where("id", "=", b.facilityId).executeTakeFirst();
        if (!facility) throw notFound("Disposal facility");
        await checkVehicle(trx, organizationId, b.vehicleId);
        await trx.updateTable("disposalLoads").set({ isCurrent: false }).where("organizationId", "=", organizationId).where("id", "=", cur.id).execute();
        await trx
          .insertInto("disposalLoads")
          .values({
            id: randomUUID(),
            organizationId,
            groupId: cur.groupId,
            revision: cur.revision + 1,
            correctionReason: b.reason,
            offlineClientId: null,
            vehicleId: b.vehicleId ?? null,
            disposalFacilityId: b.facilityId,
            deliveredOn: b.deliveredOn,
            manifestReference: b.manifestReference || null,
            enteredTotal: b.total,
            enteredUnit: b.unit,
            totalMilligallons: toMilligallons(b.total, b.unit),
            notes: b.notes || null,
            recordedBy: userId,
          })
          .execute();
        await audit(trx, req, {
          action: "disposal_load.corrected",
          entityType: "disposal_load",
          entityId: cur.groupId,
          changes: { revision: cur.revision + 1, reason: b.reason, from: { total: Number(cur.enteredTotal), unit: cur.enteredUnit, manifestReference: cur.manifestReference }, to: { total: b.total, unit: b.unit, manifestReference: b.manifestReference ?? null } },
        });
      });
      return loadDetail(organizationId, req.params.groupId);
    },
  );

  app.post(
    "/disposal/loads/:groupId/items",
    {
      config: { permission: "work:write" },
      schema: { tags: ["pumping"], summary: "Add a pump-out to a disposal record (409 already_in_load if it is in one)", params: groupParams, body: loadItemAddInput, response: { 200: disposalLoadDetail } } },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const load = await lockLoad(trx, organizationId, req.params.groupId);
        const p = await lockPumpOut(trx, organizationId, req.body.pumpingGroupId);
        const taken = await trx.selectFrom("disposalLoadItems").select("loadGroupId").where("organizationId", "=", organizationId).where("pumpingGroupId", "=", p.groupId).executeTakeFirst();
        if (taken) throw conflict("already_in_load", taken.loadGroupId === load.groupId ? "This pump-out is already in this disposal record" : "This pump-out is already in another disposal record");
        await trx
          .insertInto("disposalLoadItems")
          .values({ organizationId, loadGroupId: load.groupId, pumpingGroupId: p.groupId, addedBy: userId })
          .execute()
          .catch((err) => {
            if ((err as { code?: string }).code === "23505") throw conflict("already_in_load", "This pump-out is already in another disposal record");
            throw err;
          });
        await audit(trx, req, { action: "disposal_load.item_added", entityType: "disposal_load", entityId: load.groupId, changes: { pumpingGroupId: p.groupId } });
      });
      return loadDetail(organizationId, req.params.groupId);
    },
  );

  app.post(
    "/disposal/loads/:groupId/items/remove",
    {
      config: { permission: "work:write" },
      schema: { tags: ["pumping"], summary: "Take a pump-out out of a disposal record, saying why", params: groupParams, body: loadItemRemoveInput, response: { 200: disposalLoadDetail } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const load = await lockLoad(trx, organizationId, req.params.groupId);
        await lockPumpOut(trx, organizationId, req.body.pumpingGroupId);
        const gone = await trx
          .deleteFrom("disposalLoadItems")
          .where("organizationId", "=", organizationId)
          .where("loadGroupId", "=", load.groupId)
          .where("pumpingGroupId", "=", req.body.pumpingGroupId)
          .returning("id")
          .executeTakeFirst();
        if (!gone) throw notFound("Pump-out in this disposal record");
        await audit(trx, req, { action: "disposal_load.item_removed", entityType: "disposal_load", entityId: load.groupId, changes: { pumpingGroupId: req.body.pumpingGroupId, reason: req.body.reason } });
      });
      return loadDetail(organizationId, req.params.groupId);
    },
  );

  // ---- Manifest photos ----

  app.put(
    "/disposal/loads/:clientId/photos/:photoClientId",
    {
      config: { permission: "work:read", imageUpload: true },
      bodyLimit: MAX_PHOTO_BYTES,
      schema: {
        tags: ["pumping"],
        summary: "Upload a manifest or facility receipt photo for a disposal record, as the raw image body (idempotent by photoClientId)",
        description: "The record is named by its clientId. 409 record_not_synced until the record itself has arrived. Headers: optional x-captured-at, x-lat, x-lng, x-sha256.",
        params: z.object({ clientId: z.uuid(), photoClientId: z.uuid() }),
        response: { 200: z.union([manifestPhoto, disposalAck]), 201: z.union([manifestPhoto, disposalAck]) },
      },
    },
    async (req, reply) => {
      const { organizationId, userId, role } = req.requireAuth();
      const office = may(role, "work:write");
      if (!office && !may(role, "work:complete")) throw new HttpError(403, "forbidden", "Your role does not allow this action");
      const headers = photoHeaders.safeParse(req.headers);
      if (!headers.success) throw new HttpError(400, "invalid_request", "Photo headers failed validation");
      const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, "invalid_request", "Send the image as the request body");
      const { clientId, photoClientId } = req.params;
      const h = headers.data;
      const out = await db.transaction().execute(async (trx) => {
        await clientLock(trx, organizationId, clientId);
        const load = await trx.selectFrom("disposalLoads").select(["groupId", "recordedBy"]).where("organizationId", "=", organizationId).where("offlineClientId", "=", clientId).executeTakeFirst();
        if (!load) throw conflict("record_not_synced", "Send the disposal record before its photos");
        if (!office && load.recordedBy !== userId) throw new HttpError(403, "not_assigned", "Only the office or whoever recorded it can add photos to this disposal record");
        const COLUMNS = ["id", "offlineClientId", "disposalLoadGroupId", "contentType", "byteSize", "capturedAt"] as const;
        const existing = await trx.selectFrom("workAttachments").select(COLUMNS).where("organizationId", "=", organizationId).where("offlineClientId", "=", photoClientId).executeTakeFirst();
        if (existing && existing.disposalLoadGroupId !== load.groupId) throw conflict("client_id_reused", "This photo id belongs to another record");
        const toPhoto = (p: NonNullable<typeof existing>) => ({ id: p.id, clientId: p.offlineClientId, contentType: p.contentType, byteSize: p.byteSize, capturedAt: p.capturedAt?.toISOString() ?? null, url: photoUrl(organizationId)(p.id) });
        // The same rule as reading the load: after another technician's work joined it, the
        // technician's upload is acknowledged without the record's details.
        const shown = office || (await readLoads(trx, organizationId, { groupIds: [load.groupId], technicianUserId: userId }, () => "")).length > 0;
        const answer = (p: NonNullable<typeof existing>) => (shown ? toPhoto(p) : { outcome: "recorded" as const, groupId: load.groupId, clientId });
        if (existing) return { status: 200, body: answer(existing) };
        const sha256 = createHash("sha256").update(body).digest("hex");
        if (h["x-sha256"] && h["x-sha256"] !== sha256) throw unprocessable("The photo was corrupted in transit; upload it again");
        // Under the company's folder, by the load group, so it stays put through load corrections.
        const storageKey = `${organizationId}/work/loads/${load.groupId}/${photoClientId}.${PHOTO_TYPES[contentType] ?? "bin"}`;
        await store.put(storageKey, body, contentType);
        const inserted = await trx
          .insertInto("workAttachments")
          .values({
            organizationId,
            offlineClientId: photoClientId,
            recordClientId: null,
            disposalLoadGroupId: load.groupId,
            photoKey: "manifest",
            storageKey,
            contentType,
            byteSize: body.length,
            sha256,
            capturedAt: h["x-captured-at"] ?? null,
            lat: h["x-lat"] ?? null,
            lng: h["x-lng"] ?? null,
            uploadedBy: userId,
          })
          .returning(COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "disposal_load.photo_added", entityType: "disposal_load", entityId: load.groupId, changes: { photoId: inserted.id } });
        return { status: 201, body: answer(inserted) };
      });
      return reply.status(out.status as 200 | 201).send(out.body);
    },
  );

  // ---- The provider's own disposal log ----

  const logRange = z.object({ from: z.iso.date(), to: z.iso.date() });

  async function logRows(organizationId: string, from: string, to: string) {
    if (from > to) throw unprocessable("from must be on or before to");
    return readLoads(db, organizationId, { from, to }, photoUrl(organizationId));
  }

  app.get(
    "/disposal/log.csv",
    {
      config: { permission: "work:write" },
      schema: { tags: ["pumping"], summary: "Disposal log for a date range, one row per pump-out in each load (for the provider's own records)", querystring: logRange },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const org = await db.selectFrom("organizations").select(["demo"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
      const loads = await logRows(organizationId, req.query.from, req.query.to);
      const head = ["delivered_on", "facility", "vehicle", "manifest_reference", "load_total_entered", "load_total_gallons", "pump_out_service_date", "work_order", "customer", "site", "waste_type", "pump_out_entered", "pump_out_gallons", "volumes_differ", "photos"];
      const cell = (v: string | number | boolean | null) => {
        if (v === null) return "";
        const text = String(v);
        const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
        return /[",\r\n]/.test(safe) || safe !== text ? `"${safe.replace(/"/g, '""')}"` : safe;
      };
      const gal = (m: number) => (m / 1000).toFixed(3);
      const rows: (string | number | boolean | null)[][] = [];
      for (const l of loads) {
        const base = [l.deliveredOn, l.facilityName, l.vehicleName, l.manifestReference, `${l.enteredTotal} ${l.enteredUnit}`, gal(l.totalMilligallons)];
        const tail = [l.volumesDiffer, l.photos.length];
        if (!l.items.length) rows.push([...base, null, null, null, null, null, null, null, ...tail]);
        for (const p of l.items) rows.push([...base, p.serviceDate, p.workOrderLabel, p.customerName, p.siteAddress, WASTE_TYPE_LABELS[p.wasteType], `${p.enteredVolume} ${p.enteredUnit}`, gal(p.volumeMilligallons), ...tail]);
      }
      // A demo company's file says on every row that it is fictional, as the data export does.
      const lead = org.demo ? ["aerowise_demo_notice"] : [];
      const notice = org.demo ? ["DEMO - FICTIONAL DATA - NOT FILED"] : [];
      const csv = [[...lead, ...head].join(","), ...rows.map((r) => [...notice, ...r].map(cell).join(","))].join("\r\n") + "\r\n";
      return reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="disposal-log-${req.query.from}-to-${req.query.to}.csv"`)
        .send(csv);
    },
  );

  app.get(
    "/disposal/log.pdf",
    { config: { permission: "work:write" }, schema: { tags: ["pumping"], summary: "Disposal log for a date range as a PDF (for the provider's own records)", querystring: logRange } },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const org = await db.selectFrom("organizations").select(["name", "demo"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
      const loads = await logRows(organizationId, req.query.from, req.query.to);
      const at = now();
      const pdf = await renderDisposalLog({
        companyName: org.name,
        from: req.query.from,
        to: req.query.to,
        generatedOn: await organizationToday(db, organizationId, at),
        generatedAt: at.toISOString(),
        loads: loads.map((l) => ({
          deliveredOn: l.deliveredOn,
          facilityName: l.facilityName,
          vehicleName: l.vehicleName,
          manifestReference: l.manifestReference,
          total: volumeText(l.enteredTotal, l.enteredUnit, l.totalMilligallons),
          itemsTotal: formatGallons(l.itemsMilligallons),
          volumesDiffer: l.volumesDiffer,
          photos: l.photos.length,
          revision: l.revision,
          items: l.items.map((p) => ({
            serviceDate: p.serviceDate,
            workOrderLabel: p.workOrderLabel,
            customerName: p.customerName,
            siteAddress: p.siteAddress,
            wasteType: WASTE_TYPE_LABELS[p.wasteType],
            volume: volumeText(p.enteredVolume, p.enteredUnit, p.volumeMilligallons),
          })),
        })),
      });
      // A demo company's copy is stamped as fictional, as every PDF it downloads is.
      const data = org.demo ? await watermarkPdf(pdf) : pdf;
      return reply
        .type("application/pdf")
        .header("content-disposition", `attachment; filename="disposal-log-${req.query.from}-to-${req.query.to}.pdf"`)
        .send(data);
    },
  );
};
