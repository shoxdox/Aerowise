import { z } from "zod";
import { id } from "./crm.ts";
import type { ValidationProblem } from "./inspections.ts";

// SW-6: pumping and disposal records (service workflows plan §2). A pump-out is recorded on the
// work visit; a load is a separate delivery of one truck's pump-outs to a facility. Both are kept
// as immutable revisions of a stable group, read through the current revision.
//
// Wording rule (§2.4): "Disposal record" and "Manifest/reference number". Nothing here says a
// load is legally compliant, that a manifest satisfies a regulator, or that a facility accepted it.

export const VOLUME_UNITS = ["gallons", "liters"] as const;
export const volumeUnit = z.enum(VOLUME_UNITS);
export type VolumeUnit = (typeof VOLUME_UNITS)[number];

export const WASTE_TYPES = ["septage", "grease_trap", "holding_tank", "portable_toilet", "other"] as const;
export const wasteType = z.enum(WASTE_TYPES);
export type WasteType = (typeof WASTE_TYPES)[number];
export const WASTE_TYPE_LABELS: Record<WasteType, string> = {
  septage: "Septage",
  grease_trap: "Grease trap",
  holding_tank: "Holding tank",
  portable_toilet: "Portable toilet",
  other: "Other",
};

export const FACILITY_KINDS = ["wastewater_treatment_plant", "land_application_site", "transfer_station", "other"] as const;
export const facilityKind = z.enum(FACILITY_KINDS);
export const FACILITY_KIND_LABELS: Record<(typeof FACILITY_KINDS)[number], string> = {
  wastewater_treatment_plant: "Wastewater treatment plant",
  land_application_site: "Land application site",
  transfer_station: "Transfer station",
  other: "Other",
};

/** Exactly 3.785411784 L per US gallon, as ten-thousand-millionths so the arithmetic is exact. */
const LITERS_PER_GALLON_E9 = 3_785_411_784n;

/**
 * A volume as entered (one decimal place) in thousandths of a US gallon, rounded once, half away
 * from zero: the same value the database checks (`round(liters × 1000 / 3.785411784)`).
 */
export function toMilligallons(volume: number, unit: VolumeUnit): number {
  const tenths = BigInt(Math.round(volume * 10));
  if (unit === "gallons") return Number(tenths * 100n);
  // tenths/10 L × 1000 / 3.785411784 = tenths × 100 × 1e9 / 3785411784.
  const num = tenths * 100n * 1_000_000_000n;
  const sign = num < 0n ? -1n : 1n;
  const abs = num * sign;
  return Number(sign * ((2n * abs + LITERS_PER_GALLON_E9) / (2n * LITERS_PER_GALLON_E9)));
}

/** "1,234.5 gal" from thousandths of a gallon. */
export function formatGallons(milligallons: number): string {
  return `${(Math.round(milligallons / 100) / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} gal`;
}

/** "1,234.5 gallons" / "500.0 liters", as recorded. */
export function formatEntered(volume: number, unit: VolumeUnit): string {
  return `${volume.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`;
}

/** One decimal place, the precision a volume is entered and stored at. */
const volume = z.number().positive().max(999_999_999.9).refine((v) => Math.abs(Math.round(v * 10) - v * 10) < 1e-6, "Use at most one decimal place");
const tank = z.object({ label: z.string().trim().min(1).max(60), volume: volume.optional() });

// ---- Pump-out, sent with the visit's field record ----

/** What the phone records for a pump-out; sent inside the visit's PUT /work/sync body. */
export const pumpOutInput = z.object({
  /** The phone's id for the pump-out: it becomes the group's offline id, once. */
  clientId: z.uuid(),
  volume,
  unit: volumeUnit,
  wasteType,
  wasteTypeNote: z.string().trim().max(500).nullish(),
  tanks: z.array(tank).max(20).default([]),
  vehicleId: id.nullish(),
});
export type PumpOutInput = z.input<typeof pumpOutInput>;

/**
 * What completing a visit finds missing about its pump-out: a kind of work that needs a disposal
 * record completes only with one. The phone shows these before sending, and the server refuses a
 * completion (or an office attach of a held record) with the same problems.
 */
export function pumpOutProblems(requiresDisposalRecord: boolean, pumpOut: unknown): ValidationProblem[] {
  if (!requiresDisposalRecord || pumpOut) return [];
  return [{ key: "pump_out", label: "Pump-out", problem: "missing", message: "Pump-out volume is required" }];
}

// ---- Corrections ----

export const correctionReason = z.string().trim().min(3).max(2000);

export const pumpingCorrectionInput = z.object({
  volume,
  unit: volumeUnit,
  wasteType,
  wasteTypeNote: z.string().trim().max(500).nullish(),
  tanks: z.array(tank).max(20).default([]),
  vehicleId: id.nullish(),
  serviceDate: z.iso.date(),
  reason: correctionReason,
});

// ---- Loads ----

/** A load as the phone or the office records it (idempotent by clientId). */
export const disposalLoadSync = z.object({
  clientId: z.uuid(),
  vehicleId: id.nullish(),
  facilityId: id,
  deliveredOn: z.iso.date(),
  manifestReference: z.string().trim().max(200).nullish(),
  total: volume,
  unit: volumeUnit,
  notes: z.string().trim().max(2000).nullish(),
  /** The pump-out groups the truck delivered; each must still be in no load. */
  pumpingGroupIds: z.array(id).min(1).max(100),
});
export type DisposalLoadSync = z.input<typeof disposalLoadSync>;

export const disposalLoadCorrectionInput = z.object({
  vehicleId: id.nullish(),
  facilityId: id,
  deliveredOn: z.iso.date(),
  manifestReference: z.string().trim().max(200).nullish(),
  total: volume,
  unit: volumeUnit,
  notes: z.string().trim().max(2000).nullish(),
  reason: correctionReason,
});

export const loadItemAddInput = z.object({ pumpingGroupId: id });
export const loadItemRemoveInput = z.object({ pumpingGroupId: id, reason: correctionReason });

// ---- Vehicles and facilities ----

export const vehicleFields = z.object({
  name: z.string().trim().min(1).max(100),
  plate: z.string().trim().max(30).nullish(),
  capacityGallons: z.number().int().min(1).max(100_000).nullish(),
  registrationReference: z.string().trim().max(200).nullish(),
  active: z.boolean(),
});
export const vehicleInput = vehicleFields.extend({ active: z.boolean().default(true) });
export const vehiclePatch = vehicleFields.partial();
export const vehicle = z.object({
  id,
  name: z.string(),
  plate: z.string().nullable(),
  capacityGallons: z.number().int().nullable(),
  registrationReference: z.string().nullable(),
  active: z.boolean(),
});
export type Vehicle = z.infer<typeof vehicle>;

const facilityBase = z.object({
  name: z.string().trim().min(1).max(200),
  kind: facilityKind,
  addressLine1: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(100).nullish(),
  state: z.string().trim().max(50).nullish(),
  postalCode: z.string().trim().max(20).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  permitOrRegistrationNumber: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  active: z.boolean(),
});
/** A facility the company enters by hand. No facility list is shipped or imported (gate G-FAC). */
export const facilityInput = facilityBase.extend({ active: z.boolean().default(true) });
export const facilityPatch = facilityBase.partial();
export const disposalFacility = z.object({
  id,
  name: z.string(),
  kind: facilityKind,
  addressLine1: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  permitOrRegistrationNumber: z.string().nullable(),
  source: z.enum(["entered_by_provider", "public_source"]),
  sourceUrl: z.string().nullable(),
  sourceRetrievedOn: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
});
export type DisposalFacility = z.infer<typeof disposalFacility>;

// ---- What the API returns ----

const datetime = z.iso.datetime({ offset: true });
const tankOut = z.object({ label: z.string(), volume: z.number().optional() });

/** The current revision of a pump-out group. */
export const pumpingRecord = z.object({
  groupId: id,
  revision: z.number().int(),
  workOrderId: id,
  workOrderLabel: z.string(),
  jobId: id,
  workRecordId: id,
  siteId: id,
  siteAddress: z.string(),
  customerName: z.string(),
  technicianId: id,
  technicianName: z.string(),
  vehicleId: id.nullable(),
  vehicleName: z.string().nullable(),
  serviceDate: z.iso.date(),
  wasteType,
  wasteTypeNote: z.string().nullable(),
  tanks: z.array(tankOut),
  enteredVolume: z.number(),
  enteredUnit: volumeUnit,
  volumeMilligallons: z.number().int(),
  correctionReason: z.string().nullable(),
  /** The load it went in, if any. */
  loadGroupId: id.nullable(),
  createdAt: datetime,
});
export type PumpingRecord = z.infer<typeof pumpingRecord>;

/** One revision, for the history of a group. */
export const revisionEntry = z.object({
  revision: z.number().int(),
  current: z.boolean(),
  summary: z.string(),
  correctionReason: z.string().nullable(),
  recordedByName: z.string(),
  createdAt: datetime,
});

export const pumpingRecordDetail = pumpingRecord.extend({ revisions: z.array(revisionEntry) });

export const manifestPhoto = z.object({ id, clientId: z.string(), contentType: z.string(), byteSize: z.number().int(), capturedAt: datetime.nullable(), url: z.string() });

export const disposalLoad = z.object({
  groupId: id,
  clientId: z.string().nullable(),
  revision: z.number().int(),
  vehicleId: id.nullable(),
  vehicleName: z.string().nullable(),
  facilityId: id,
  facilityName: z.string(),
  deliveredOn: z.iso.date(),
  manifestReference: z.string().nullable(),
  enteredTotal: z.number(),
  enteredUnit: volumeUnit,
  totalMilligallons: z.number().int(),
  notes: z.string().nullable(),
  correctionReason: z.string().nullable(),
  recordedByName: z.string(),
  /** The pump-outs in it, each at its current revision. */
  items: z.array(pumpingRecord),
  /** Sum of the current pump-out volumes. */
  itemsMilligallons: z.number().int(),
  /** The load's total and its pump-outs' sum differ: shown, never refused. */
  volumesDiffer: z.boolean(),
  photos: z.array(manifestPhoto),
  createdAt: datetime,
});
export type DisposalLoad = z.infer<typeof disposalLoad>;

export const disposalLoadDetail = disposalLoad.extend({ revisions: z.array(revisionEntry) });

/**
 * A technician's replay or photo upload for a load they recorded that now holds another
 * technician's pump-outs: delivered, with nothing about the other work.
 */
export const disposalAck = z.object({ outcome: z.literal("recorded"), groupId: id, clientId: z.string() });

/** One page of a list; `nextOffset` is null on the last page. */
export const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) });

/** The inbox raises a pump-out with no disposal record once it is more than this many days old (owner's setting). */
export const pumpingSettings = z.object({ disposalOverdueDays: z.number().int().min(1).max(60) });
export type PumpingSettings = z.infer<typeof pumpingSettings>;

/** What the phone caches for recording disposal offline. */
export const pumpingFieldData = z.object({
  vehicles: z.array(vehicle),
  facilities: z.array(disposalFacility),
  /** The technician's pump-outs in no load yet, oldest first. */
  unloaded: z.array(pumpingRecord),
});
export type PumpingFieldData = z.infer<typeof pumpingFieldData>;
