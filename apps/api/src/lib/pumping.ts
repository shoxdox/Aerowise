import type { Database, DB } from "@aerowise/db";
import {
  formatEntered,
  formatGallons,
  toMilligallons,
  workOrderLabel,
  type DisposalLoad,
  type Feature,
  type PumpingRecord,
  type PumpOutInput,
  type ValidationProblem,
  type VolumeUnit,
} from "@aerowise/domain";
import { sql, type Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import { organizationToday } from "./today.ts";

// SW-6: pump-outs and loads, shared by the visit sync (a pump-out is recorded when its field
// record completes) and the pumping routes. Everything that counts or links reads the current
// revision of a group (the current_* views); revisions are immutable rows.

type Trx = Transaction<DB>;
type Executor = Database | Trx;

/** Whether completing this work order's visits needs a pump-out: its kind of work asks, and pumping is on. */
export async function pumpOutRequired(ex: Executor, features: ReadonlySet<Feature>, organizationId: string, workOrderId: string) {
  if (!features.has("pumping")) return false;
  const t = await ex
    .selectFrom("workOrders as w")
    .innerJoin("workTypes as t", (k) => k.onRef("t.id", "=", "w.workTypeId").onRef("t.organizationId", "=", "w.organizationId"))
    .select("t.requiresDisposalRecord")
    .where("w.organizationId", "=", organizationId)
    .where("w.id", "=", workOrderId)
    .executeTakeFirst();
  return !!t?.requiresDisposalRecord;
}

/** A pump-out that names a truck this company does not have (another company's, or a made-up id). */
export async function pumpOutVehicleProblems(ex: Executor, organizationId: string, pumpOut: { vehicleId?: string | null } | null | undefined): Promise<ValidationProblem[]> {
  if (!pumpOut?.vehicleId) return [];
  const v = await ex.selectFrom("vehicles").select("id").where("organizationId", "=", organizationId).where("id", "=", pumpOut.vehicleId).executeTakeFirst();
  return v ? [] : [{ key: "pump_out", label: "Pump-out", problem: "invalid", message: "The truck is not one of this company's vehicles; pick another" }];
}

/**
 * Records a completed visit's pump-out as revision 1 of a new group. Runs once per record: the
 * record completes once, and its client id and the record are both unique.
 */
export async function insertPumpOut(
  trx: Trx,
  a: { organizationId: string; recordId: string; pumpOut: PumpOutInput; completedAt: Date; recordedBy: string },
) {
  const rec = await trx
    .selectFrom("workRecords")
    .select(["jobId", "workOrderId", "siteId", "technicianUserId"])
    .where("organizationId", "=", a.organizationId)
    .where("id", "=", a.recordId)
    .executeTakeFirstOrThrow();
  const id = randomUUID();
  const p = a.pumpOut;
  await trx
    .insertInto("pumpingRecords")
    .values({
      id,
      organizationId: a.organizationId,
      groupId: id,
      revision: 1,
      correctionReason: null,
      offlineClientId: p.clientId,
      workOrderId: rec.workOrderId,
      jobId: rec.jobId,
      workRecordId: a.recordId,
      siteId: rec.siteId,
      technicianUserId: rec.technicianUserId,
      vehicleId: p.vehicleId ?? null,
      serviceDate: await organizationToday(trx, a.organizationId, a.completedAt),
      wasteType: p.wasteType,
      wasteTypeNote: p.wasteTypeNote ?? null,
      tanks: JSON.stringify(p.tanks ?? []),
      enteredVolume: p.volume,
      enteredUnit: p.unit,
      volumeMilligallons: toMilligallons(p.volume, p.unit),
      recordedBy: a.recordedBy,
    })
    .execute();
  return id;
}

/** "1,000.0 gallons" plus the canonical gallons when the unit was liters. */
export function volumeText(entered: number, unit: VolumeUnit, milligallons: number) {
  return unit === "gallons" ? formatEntered(entered, unit) : `${formatEntered(entered, unit)} (${formatGallons(milligallons)})`;
}

// ---- Reading ----

/** A page of a list: rows are never dropped silently, the caller asks for the next page. */
export interface Page {
  limit: number;
  offset: number;
}
/** Exact reads by id go in chunks this size, so no list of ids is ever cut short. */
const CHUNK = 1000;
const chunked = async <T>(ids: string[], read: (part: string[]) => Promise<T[]>) => {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await read(ids.slice(i, i + CHUNK))));
  return out;
};

/**
 * Current pump-outs, with what the office and the phone show beside them. Every matching row,
 * unless `page` asks for one page of them.
 */
export async function readPumpingRecords(
  ex: Executor,
  organizationId: string,
  where: { groupIds?: string[]; siteId?: string; workOrderId?: string; technicianUserId?: string; unloaded?: boolean; from?: string; to?: string; olderThan?: string; newestFirst?: boolean },
  page?: Page,
): Promise<PumpingRecord[]> {
  if (where.groupIds && !where.groupIds.length) return [];
  if (where.groupIds && where.groupIds.length > CHUNK) return chunked(where.groupIds, (groupIds) => readPumpingRecords(ex, organizationId, { ...where, groupIds }));
  let q = ex
    .selectFrom("currentPumpingRecords as p")
    .innerJoin("workOrders as w", (k) => k.onRef("w.id", "=", "p.workOrderId").onRef("w.organizationId", "=", "p.organizationId"))
    .innerJoin("sites as s", (k) => k.onRef("s.id", "=", "p.siteId").onRef("s.organizationId", "=", "p.organizationId"))
    .innerJoin("customers as c", (k) => k.onRef("c.id", "=", "s.customerId").onRef("c.organizationId", "=", "s.organizationId"))
    .innerJoin("users as u", "u.id", "p.technicianUserId")
    .leftJoin("vehicles as v", (k) => k.onRef("v.id", "=", "p.vehicleId").onRef("v.organizationId", "=", "p.organizationId"))
    .leftJoin("disposalLoadItems as i", (k) => k.onRef("i.pumpingGroupId", "=", "p.groupId").onRef("i.organizationId", "=", "p.organizationId"))
    .select([
      "p.groupId",
      "p.revision",
      "p.workOrderId",
      "w.number",
      "p.jobId",
      "p.workRecordId",
      "p.siteId",
      "s.addressLine1",
      "s.city",
      "c.displayName as customerName",
      "p.technicianUserId",
      "u.name as technicianName",
      "p.vehicleId",
      "v.name as vehicleName",
      "p.serviceDate",
      "p.wasteType",
      "p.wasteTypeNote",
      sql<string>`p.tanks::text`.as("tanksText"),
      "p.enteredVolume",
      "p.enteredUnit",
      "p.volumeMilligallons",
      "p.correctionReason",
      "i.loadGroupId",
      "p.createdAt",
    ])
    .where("p.organizationId", "=", organizationId);
  if (where.groupIds) q = q.where("p.groupId", "in", where.groupIds);
  if (where.siteId) q = q.where("p.siteId", "=", where.siteId);
  if (where.workOrderId) q = q.where("p.workOrderId", "=", where.workOrderId);
  if (where.technicianUserId) q = q.where("p.technicianUserId", "=", where.technicianUserId);
  if (where.unloaded) q = q.where("i.id", "is", null);
  if (where.from) q = q.where("p.serviceDate", ">=", where.from);
  if (where.to) q = q.where("p.serviceDate", "<=", where.to);
  if (where.olderThan) q = q.where("p.serviceDate", "<", where.olderThan);
  const dir = where.newestFirst ? "desc" : "asc";
  q = q.orderBy("p.serviceDate", dir).orderBy("p.createdAt", dir).orderBy("p.groupId");
  if (page) q = q.limit(page.limit).offset(page.offset);
  const rows = await q.execute();
  return rows.map((r) => ({
    groupId: r.groupId,
    revision: r.revision,
    workOrderId: r.workOrderId,
    workOrderLabel: workOrderLabel(r.number),
    jobId: r.jobId,
    workRecordId: r.workRecordId,
    siteId: r.siteId,
    siteAddress: [r.addressLine1, r.city].filter(Boolean).join(", "),
    customerName: r.customerName,
    technicianId: r.technicianUserId,
    technicianName: r.technicianName,
    vehicleId: r.vehicleId,
    vehicleName: r.vehicleName,
    serviceDate: r.serviceDate,
    wasteType: r.wasteType,
    wasteTypeNote: r.wasteTypeNote,
    tanks: JSON.parse(r.tanksText) as PumpingRecord["tanks"],
    enteredVolume: Number(r.enteredVolume),
    enteredUnit: r.enteredUnit,
    volumeMilligallons: Number(r.volumeMilligallons),
    correctionReason: r.correctionReason,
    loadGroupId: r.loadGroupId,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Current loads with their pump-outs (each at its current revision) and manifest photos. Every
 * matching load, unless `page` asks for one page of them; each load always has all its items.
 *
 * With `technicianUserId`, only that technician's own work: a load made entirely of their
 * pump-outs (or, with none left in it, one they recorded). A load mixing technicians is the
 * office's, so another technician's customers and sites never show.
 */
export async function readLoads(
  ex: Executor,
  organizationId: string,
  where: { groupIds?: string[]; from?: string; to?: string; technicianUserId?: string },
  photoUrl: (photoId: string) => string,
  page?: Page,
): Promise<DisposalLoad[]> {
  if (where.groupIds && !where.groupIds.length) return [];
  if (where.groupIds && where.groupIds.length > CHUNK) return chunked(where.groupIds, (groupIds) => readLoads(ex, organizationId, { ...where, groupIds }, photoUrl));
  let q = ex
    .selectFrom("currentDisposalLoads as l")
    .innerJoin("disposalFacilities as f", (k) => k.onRef("f.id", "=", "l.disposalFacilityId").onRef("f.organizationId", "=", "l.organizationId"))
    .innerJoin("users as u", "u.id", "l.recordedBy")
    .leftJoin("vehicles as v", (k) => k.onRef("v.id", "=", "l.vehicleId").onRef("v.organizationId", "=", "l.organizationId"))
    .select([
      "l.groupId",
      "l.revision",
      "l.recordedBy",
      "l.vehicleId",
      "v.name as vehicleName",
      "l.disposalFacilityId",
      "f.name as facilityName",
      "l.deliveredOn",
      "l.manifestReference",
      "l.enteredTotal",
      "l.enteredUnit",
      "l.totalMilligallons",
      "l.notes",
      "l.correctionReason",
      "u.name as recordedByName",
      "l.createdAt",
    ])
    .where("l.organizationId", "=", organizationId);
  if (where.groupIds) q = q.where("l.groupId", "in", where.groupIds);
  if (where.from) q = q.where("l.deliveredOn", ">=", where.from);
  if (where.to) q = q.where("l.deliveredOn", "<=", where.to);
  const tech = where.technicianUserId;
  if (tech) {
    q = q.where((eb) =>
      eb.and([
        eb.not(
          eb.exists(
            eb
              .selectFrom("disposalLoadItems as i")
              .innerJoin("currentPumpingRecords as p", (k) => k.onRef("p.groupId", "=", "i.pumpingGroupId").onRef("p.organizationId", "=", "i.organizationId"))
              .select("i.id")
              .whereRef("i.loadGroupId", "=", "l.groupId")
              .whereRef("i.organizationId", "=", "l.organizationId")
              .where("p.technicianUserId", "<>", tech),
          ),
        ),
        eb.or([eb("l.recordedBy", "=", tech), eb.exists(eb.selectFrom("disposalLoadItems as j").select("j.id").whereRef("j.loadGroupId", "=", "l.groupId").whereRef("j.organizationId", "=", "l.organizationId"))]),
      ]),
    );
  }
  q = q.orderBy("l.deliveredOn", "desc").orderBy("l.createdAt", "desc").orderBy("l.groupId");
  if (page) q = q.limit(page.limit).offset(page.offset);
  const loads = await q.execute();
  if (!loads.length) return [];
  const groupIds = loads.map((l) => l.groupId);
  // The offline id lives on the first revision.
  const firsts = await chunked(groupIds, (ids) => ex.selectFrom("disposalLoads").select(["id", "offlineClientId"]).where("organizationId", "=", organizationId).where("id", "in", ids).execute());
  const clientIds = new Map(firsts.map((f) => [f.id, f.offlineClientId]));
  const items = await chunked(groupIds, (ids) => ex.selectFrom("disposalLoadItems").select(["loadGroupId", "pumpingGroupId"]).where("organizationId", "=", organizationId).where("loadGroupId", "in", ids).execute());
  const pumpOuts = new Map((await readPumpingRecords(ex, organizationId, { groupIds: items.map((i) => i.pumpingGroupId) })).map((p) => [p.groupId, p]));
  const photos = await chunked(groupIds, (ids) =>
    ex
      .selectFrom("workAttachments")
      .select(["id", "offlineClientId", "disposalLoadGroupId", "contentType", "byteSize", "capturedAt"])
      .where("organizationId", "=", organizationId)
      .where("disposalLoadGroupId", "in", ids)
      .orderBy("createdAt")
      .execute(),
  );
  const itemsOf = (groupId: string) => items.filter((i) => i.loadGroupId === groupId).map((i) => pumpOuts.get(i.pumpingGroupId)!).filter(Boolean);
  return loads.map((l) => {
    const mine = itemsOf(l.groupId);
    const itemsMilligallons = mine.reduce((n, p) => n + p.volumeMilligallons, 0);
    const totalMilligallons = Number(l.totalMilligallons);
    return {
      groupId: l.groupId,
      clientId: clientIds.get(l.groupId) ?? null,
      revision: l.revision,
      vehicleId: l.vehicleId,
      vehicleName: l.vehicleName,
      facilityId: l.disposalFacilityId,
      facilityName: l.facilityName,
      deliveredOn: l.deliveredOn,
      manifestReference: l.manifestReference,
      enteredTotal: Number(l.enteredTotal),
      enteredUnit: l.enteredUnit,
      totalMilligallons,
      notes: l.notes,
      correctionReason: l.correctionReason,
      recordedByName: l.recordedByName,
      items: mine,
      itemsMilligallons,
      volumesDiffer: itemsMilligallons !== totalMilligallons,
      photos: photos
        .filter((p) => p.disposalLoadGroupId === l.groupId)
        .map((p) => ({ id: p.id, clientId: p.offlineClientId, contentType: p.contentType, byteSize: p.byteSize, capturedAt: p.capturedAt?.toISOString() ?? null, url: photoUrl(p.id) })),
      createdAt: l.createdAt.toISOString(),
    };
  });
}

/**
 * The work order's pumped volume for billing by the gallon: the sum of its current pump-outs, and
 * the text an invoice line cites ("1,000.0 gal pumped on 2026-10-08").
 */
export async function pumpedVolume(ex: Executor, organizationId: string, workOrderId: string) {
  const rows = await ex
    .selectFrom("currentPumpingRecords")
    .select(["volumeMilligallons", "serviceDate"])
    .where("organizationId", "=", organizationId)
    .where("workOrderId", "=", workOrderId)
    .orderBy("serviceDate")
    .execute();
  const milligallons = rows.reduce((n, r) => n + Number(r.volumeMilligallons), 0);
  const dates = [...new Set(rows.map((r) => r.serviceDate))];
  return { milligallons, text: `${formatGallons(milligallons)} pumped on ${dates.join(", ")}` };
}
