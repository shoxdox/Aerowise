import type { Database } from "@aerowise/db";
import { CompletionSummaryError, completionSummaryPdf as renderSummary } from "@aerowise/tasks";
import { HttpError } from "./errors.ts";

/** The completed work orders of these sites that have at least one completed field record, newest first. */
export async function completedWorkOrders(db: Database, organizationId: string, siteIds: string[]) {
  if (siteIds.length === 0) return [];
  return db
    .selectFrom("workOrders as w")
    .select(["w.id", "w.siteId", "w.number", "w.title", "w.completedAt"])
    .where("w.organizationId", "=", organizationId)
    .where("w.siteId", "in", siteIds)
    .where("w.status", "=", "completed")
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("workRecords as r")
          .select("r.id")
          .whereRef("r.organizationId", "=", "w.organizationId")
          .whereRef("r.workOrderId", "=", "w.id")
          .where("r.status", "=", "completed"),
      ),
    )
    .orderBy("w.completedAt", "desc")
    .limit(50)
    .execute();
}

/** The shared renderer preserves the same authorization scope and error contract. */
export async function completionSummaryPdf(db: Database, organizationId: string, workOrderId: string, at: Date, opts: { customerId?: string } = {}) {
  try { return await renderSummary(db, organizationId, workOrderId, at, opts); }
  catch (error) {
    if (error instanceof CompletionSummaryError) throw new HttpError(error.code === "not_found" ? 404 : 409, error.code, error.message);
    throw error;
  }
}
