import { z } from "zod";
import { id } from "./crm.ts";

// Full data exports: everything an organization keeps in Aerowise, as CSV files and its
// documents in one zip, built in the background and downloadable by the owner.

export const DATA_EXPORT_STATUSES = ["queued", "ready", "failed"] as const;

export const dataExport = z.object({
  id,
  status: z.enum(DATA_EXPORT_STATUSES),
  requestedAt: z.iso.datetime({ offset: true }),
  requestedBy: z.string(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  byteSize: z.number().int().nullable(),
  /** Rows per CSV file and how many documents went in, once ready. */
  contents: z
    .object({ files: z.array(z.object({ file: z.string(), rows: z.number().int() })), documents: z.number().int(), missing: z.array(z.string()) })
    .nullable(),
  error: z.string().nullable(),
});
export type DataExport = z.infer<typeof dataExport>;
