import { z } from "zod";
import { id, SAFETY_FLAGS } from "./crm.ts";
import { inspectionRequirements } from "./filings.ts";
import { JOB_TYPES, WORK_CATEGORIES } from "./work.ts";

export const JOB_STATUSES = ["scheduled", "in_progress", "completed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Versioned job state machine. Every job row records the version it was created under,
 * so a later change to the allowed transitions never reinterprets old jobs.
 */
export const JOB_STATE_MACHINE = {
  version: 1,
  transitions: {
    scheduled: ["in_progress", "cancelled"],
    in_progress: ["completed", "cancelled"],
    completed: [],
    cancelled: [],
  } satisfies Record<JobStatus, readonly JobStatus[]>,
} as const;

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return (JOB_STATE_MACHINE.transitions[from] as readonly JobStatus[]).includes(to);
}

const date = z.iso.date();

export const scheduleInput = z
  .object({
    /** A contract visit. */
    obligationId: id.optional(),
    /**
     * Or an extra visit to retest after this inspection's report (Hays 10.V.4): it is not one
     * of the contract's visits, so the regular schedule does not move.
     */
    retestOfInspectionId: id.optional(),
    technicianId: id,
    scheduledDate: date,
    notes: z.string().trim().max(2000).nullish(),
  })
  .refine((v) => Boolean(v.obligationId) !== Boolean(v.retestOfInspectionId), { message: "Give either obligationId or retestOfInspectionId", path: ["obligationId"] });

export const reschedulePatch = z.object({
  technicianId: id.optional(),
  scheduledDate: date.optional(),
  notes: z.string().trim().max(2000).nullish(),
});

export const jobCancelInput = z.object({ reason: z.string().trim().min(1).max(2000) });

export const reorderInput = z.object({
  technicianId: id,
  scheduledDate: date,
  /** Every live job on that technician's day, in the new order. */
  jobIds: z.array(id).min(1).max(200),
});

/** What a technician needs at the curb, per UX-FLOWS §3. */
export const stop = z.object({
  jobId: id,
  status: z.enum(JOB_STATUSES),
  routePosition: z.number().int(),
  scheduledDate: date,
  technicianId: id,
  technicianName: z.string(),
  notes: z.string().nullable(),
  /** When the technician told the customer they were on the way. */
  onTheWayAt: z.iso.datetime({ offset: true }).nullable(),
  obligation: z.object({ id, sequence: z.number().int(), dueOn: date, windowEnd: date }).nullable(),
  site: z.object({
    id,
    addressLine1: z.string(),
    addressLine2: z.string().nullable(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string().nullable(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    gateCode: z.string().nullable(),
    accessNotes: z.string().nullable(),
    schedulingNotes: z.string().nullable(),
    safetyFlags: z.array(z.enum(SAFETY_FLAGS)),
    permitNumber: z.string().nullable(),
  }),
  customer: z.object({ id, displayName: z.string(), phone: z.string().nullable() }),
  system: z
    .object({ manufacturer: z.string().nullable(), model: z.string().nullable(), disposalType: z.string().nullable(), chlorinationMethod: z.string().nullable() })
    .nullable(),
  /** An inspection visit or a work order's visit. Older clients ignore it; every inspection stop says "inspection". */
  kind: z.enum(JOB_TYPES).optional(),
  /** The work order a work visit belongs to; null on inspection stops. */
  workOrder: z
    .object({ id, number: z.number().int(), label: z.string(), title: z.string(), category: z.enum(WORK_CATEGORIES), workTypeName: z.string(), visitNumber: z.number().int() })
    .nullable()
    .optional(),
  /** What the site's reporting authority adds to the inspection. Only on the technician's route. */
  requirements: inspectionRequirements.nullable().optional(),
});

export const technician = z.object({ id, name: z.string(), technicianLicense: z.string().nullable() });

export type Stop = z.infer<typeof stop>;
export type Technician = z.infer<typeof technician>;
