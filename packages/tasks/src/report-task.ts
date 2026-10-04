import { generateReports as generate } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import type { ObjectStore } from "@aerowise/storage";
import { queueSms } from "./sms-task.ts";

export const GENERATE_REPORTS = "reports.generate";

/**
 * Makes the customer and authority PDFs for a completed inspection (see the compliance
 * package), and tells the homeowner by text when their copy is ready.
 */
export async function generateReports(db: Database, store: ObjectStore, organizationId: string, inspectionId: string, now: Date = new Date()) {
  return generate(db, store, organizationId, inspectionId, now, async (trx, report) => {
    if (report.audience !== "customer") return;
    await queueSms(
      trx,
      organizationId,
      { kind: "report_ready", customerId: report.customerId, siteId: report.siteId, relatedType: "report", relatedId: report.id, dedupeKey: `report_ready:${inspectionId}` },
      now,
    );
  });
}
