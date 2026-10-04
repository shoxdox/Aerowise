import { z } from "zod";
import { id } from "./crm.ts";

export const REPORT_AUDIENCES = ["customer", "authority"] as const;

export const report = z.object({
  id,
  inspectionId: id,
  audience: z.enum(REPORT_AUDIENCES),
  version: z.number().int(),
  generatedAt: z.iso.datetime({ offset: true }),
  byteSize: z.number().int(),
  sha256: z.string(),
  /** Signed link to the PDF, valid for 15 minutes. */
  url: z.string(),
});

export const complianceEvent = z.object({
  id,
  eventType: z.string(),
  occurredAt: z.iso.datetime({ offset: true }),
  summary: z.string(),
  actorName: z.string().nullable(),
  inspectionId: id.nullable(),
  report: report.pick({ id: true, audience: true, url: true }).nullable(),
});

export type Report = z.infer<typeof report>;
export type ComplianceEvent = z.infer<typeof complianceEvent>;
