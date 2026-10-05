import { z } from "zod";
import { CUSTOMER_TYPES } from "./contracts.ts";
import { id } from "./crm.ts";

// Lab tests some authorities require on a schedule (for example annual BOD and TSS on
// effluent samples). What is required is ruleset data; results are recorded per site.

export const LAB_ANALYTES = ["bod", "tss"] as const;
export type LabAnalyte = (typeof LAB_ANALYTES)[number];
export const LAB_ANALYTE_LABELS: Record<LabAnalyte, string> = { bod: "BOD", tss: "TSS" };

/** A due lab test is shown as coming up this many days before its due date. */
export const LAB_TEST_DUE_SOON_DAYS = 30;

/** The ruleset part: which tests, how often, and for which systems. */
export const labTestRule = z.object({
  analytes: z.array(z.enum(LAB_ANALYTES)).min(1),
  everyMonths: z.number().int().min(1).max(24),
  appliesTo: z.array(z.enum(CUSTOMER_TYPES)).min(1),
  note: z.string().max(1000).optional(),
});
export type LabTestRule = z.infer<typeof labTestRule>;

const date = z.iso.date();
const result = z.object({ analyte: z.enum(LAB_ANALYTES), value: z.number().min(0).max(100_000) });

export const labTestInput = z
  .object({
    sampledOn: date,
    labName: z.string().trim().min(1).max(200),
    labReference: z.string().trim().max(200).nullish(),
    /** Results in mg/L, one per analyte. */
    results: z.array(result).min(1).max(LAB_ANALYTES.length),
    notes: z.string().trim().max(2000).nullish(),
    /** A correction: the earlier record this one replaces. */
    replacesId: id.optional(),
  })
  .refine((v) => new Set(v.results.map((r) => r.analyte)).size === v.results.length, { message: "Each analyte once", path: ["results"] });

export const labTest = z.object({
  id,
  siteId: id,
  sampledOn: date,
  labName: z.string(),
  labReference: z.string().nullable(),
  results: z.array(result),
  notes: z.string().nullable(),
  replacesId: id.nullable(),
  /** Set when a later correction replaced this record. */
  replacedById: id.nullable(),
  recordedBy: z.string(),
  recordedAt: z.iso.datetime({ offset: true }),
});
export type LabTest = z.infer<typeof labTest>;

export const LAB_TEST_STATES = ["ok", "due_soon", "late"] as const;

export const labTestStatus = z.object({
  authorityName: z.string(),
  analytes: z.array(z.enum(LAB_ANALYTES)),
  everyMonths: z.number().int(),
  note: z.string().nullable(),
  /** The latest sample that counts, if any. */
  lastSampledOn: date.nullable(),
  dueOn: date,
  /** What the due date counts from, in words. */
  dueBasis: z.string(),
  state: z.enum(LAB_TEST_STATES),
});
export type LabTestStatus = z.infer<typeof labTestStatus>;

export const siteLabTests = z.object({
  /** Null when the site's authority asks for no lab tests (or the site has none, or no contract). */
  requirement: labTestStatus.nullable(),
  items: z.array(labTest),
});
