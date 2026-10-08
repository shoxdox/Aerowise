import { z } from "zod";
import { id } from "./crm.ts";
import { signatureCapture } from "./forms.ts";
import { validationProblem } from "./inspections.ts";
import { pumpOutInput } from "./pumping.ts";

// What the phone sends for a work visit (SW-2) and what the server answers. Mirrors the
// inspection sync: the whole record every time, idempotent on the phone's client id. See the
// service workflows plan §8.1 and §8.5.

const answer = z.union([z.string().max(5000), z.number(), z.boolean(), z.null()]);
const gps = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100000).optional() });
const datetime = z.iso.datetime({ offset: true });

/** What the customer is shown and signs: work done, parts and notes meant for them. */
export const workSummary = z.record(z.string(), z.unknown());

export const workSync = z.object({
  clientId: z.uuid(),
  jobId: id,
  /** The work form version the phone started with. */
  templateId: id,
  status: z.enum(["draft", "completed"]),
  /** Increases with every edit on the phone; a held record keeps the newest. */
  revision: z.number().int().min(0).max(1_000_000).default(0),
  arrivedAt: datetime,
  completedAt: datetime.nullish(),
  arrivalGps: gps.nullish(),
  completionGps: gps.nullish(),
  values: z.record(z.string(), answer),
  /** The summary the customer signed, when the form asks for a signature. */
  summary: workSummary.nullish(),
  /** False when another visit is needed: the work order goes back to ready to schedule. */
  finalVisit: z.boolean().default(true),
  /** The pump-out, on a kind of work that needs a disposal record (SW-6). Recorded once, when the record completes. */
  pumpOut: pumpOutInput.nullish(),
});
export type WorkSync = z.input<typeof workSync>;

/** A held item: the office decides. 202, which the phone counts as delivered. */
export const heldForReview = z.object({ outcome: z.literal("held_for_review"), conflictId: id, reason: z.enum(["reassigned", "cancelled", "office_completed"]) });
/** The office already decided about a held item; nothing changes. */
export const alreadyResolved = z.object({ outcome: z.literal("resolved"), conflictId: id, resolution: z.enum(["attached", "dismissed"]) });

export const workPhoto = z.object({
  id,
  clientId: z.string(),
  photoKey: z.string(),
  contentType: z.string(),
  byteSize: z.number().int(),
  capturedAt: datetime.nullable(),
  url: z.string(),
});

export const workSignature = z.object({
  id,
  clientId: z.string(),
  requirementKey: z.string(),
  signerName: z.string(),
  signatureKind: z.enum(["typed", "drawn"]),
  contentSha256: z.string(),
  signedAt: datetime,
});

export const workRecord = z.object({
  id,
  clientId: z.string(),
  jobId: id,
  workOrderId: id,
  siteId: id,
  templateId: id,
  technicianId: id,
  status: z.enum(["draft", "completed"]),
  validationStatus: z.enum(["pending", "valid", "invalid"]),
  validationProblems: z.array(validationProblem),
  values: z.record(z.string(), answer),
  summary: workSummary.nullable(),
  summarySha256: z.string().nullable(),
  finalVisit: z.boolean(),
  arrivedAt: datetime,
  completedAt: datetime.nullable(),
  attachedByOffice: z.boolean(),
  photos: z.array(workPhoto),
  signatures: z.array(workSignature),
  createdAt: datetime,
  updatedAt: datetime,
});
export type WorkRecord = z.infer<typeof workRecord>;

/** A customer signature on a work summary, uploaded on its own (idempotent by its client id). */
export const workSignatureUpload = z.object({
  /** Which of the form's signature requirements this is. */
  requirementKey: z.string().min(1).max(63),
  signerName: z.string().trim().min(1).max(200),
  capture: signatureCapture,
  /** The summary shown to the signer, and the sha256 the phone computed of it. */
  summary: workSummary,
  summarySha256: z.string().regex(/^[0-9a-f]{64}$/),
  consentText: z.string().trim().min(1).max(2000),
  signedAt: datetime,
});
export type WorkSignatureUpload = z.input<typeof workSignatureUpload>;

export const CONFLICT_REASON_LABELS = {
  reassigned: "The visit was given to another technician",
  cancelled: "The visit or work order was cancelled",
  office_completed: "The office completed the work order without a field record",
} as const;

export const workSyncConflict = z.object({
  id,
  clientId: z.string(),
  jobId: id,
  workOrderId: id,
  workOrderLabel: z.string(),
  technicianId: id,
  technicianName: z.string(),
  reason: z.enum(["reassigned", "cancelled", "office_completed"]),
  status: z.enum(["held", "attached", "dismissed"]),
  /** The newest full record the phone sent, or what was kept of its draft. */
  payload: z.record(z.string(), z.unknown()).nullable(),
  photoCount: z.number().int(),
  signatureCount: z.number().int(),
  resolutionNote: z.string().nullable(),
  resolvedAt: datetime.nullable(),
  attachedJobId: id.nullable(),
  createdAt: datetime,
});
export type WorkSyncConflict = z.infer<typeof workSyncConflict>;

export const conflictDismissInput = z.object({ reason: z.string().trim().min(3).max(2000) });
export const conflictAttachInput = z.object({ note: z.string().trim().max(2000).optional() });

/** A work visit on the technician's day, with the form it uses. */
export const workStop = z.object({
  jobId: id,
  workOrderId: id,
  workOrderLabel: z.string(),
  title: z.string(),
  description: z.string(),
  workTypeName: z.string(),
  visitNumber: z.number().int(),
  scheduledDate: z.iso.date(),
  routePosition: z.number().int(),
  status: z.string(),
  siteId: id,
  customerName: z.string(),
  address: z.string(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  notes: z.string().nullable(),
  /** The form version this visit is filled in on, or null when the kind of work has none. */
  templateId: id.nullable(),
  /** The visit records a pump-out before it can be completed (SW-6, flag pumping). */
  requiresDisposalRecord: z.boolean().default(false),
  /** This technician's record for the visit, if the server has one. */
  record: z.object({ clientId: z.string(), status: z.enum(["draft", "completed"]) }).nullable(),
});
export type WorkStop = z.infer<typeof workStop>;
