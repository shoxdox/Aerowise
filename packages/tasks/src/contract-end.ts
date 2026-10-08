import type { Database, DB } from "@aerowise/db";
import type { Transaction } from "kysely";

/**
 * Cancels a contract's open visits (all of them, or only those whose window starts after
 * `windowStartAfter`) and the jobs scheduled for them that have not started, so they leave
 * the technician's route. Completed visits and jobs already under way are kept.
 *
 * A pumping or maintenance visit already booked as a work order is kept open with its order
 * (SW-9): the order may have a field record waiting on a phone, a coverage use, an invoice or
 * a deposit, which only the office's own finish or cancel settles through the work order
 * hooks. Cancelling that order then cancels the visit (`cycleVisitOnClose`).
 */
export async function cancelOpenVisits(
  trx: Transaction<DB>,
  args: { organizationId: string; contractIds: string[]; windowStartAfter?: string; reason: string; at: Date },
) {
  if (!args.contractIds.length) return { visits: 0, jobs: 0, keptForWork: 0 };
  // The visits are locked first, so a work order booked for one meanwhile is seen below.
  let q = trx
    .selectFrom("serviceObligations")
    .select(["id", "serviceType"])
    .where("organizationId", "=", args.organizationId)
    .where("contractId", "in", args.contractIds)
    .where("status", "=", "open");
  if (args.windowStartAfter) q = q.where("windowStart", ">", args.windowStartAfter);
  const open = await q.orderBy("id").forUpdate().execute();
  const cycleIds = open.filter((o) => o.serviceType !== "aerobic_inspection").map((o) => o.id);
  const booked = new Set(
    cycleIds.length
      ? (
          await trx
            .selectFrom("workOrders")
            .select("obligationId")
            .where("organizationId", "=", args.organizationId)
            .where("obligationId", "in", cycleIds)
            .where("status", "<>", "cancelled")
            .execute()
        ).map((w) => w.obligationId!)
      : [],
  );
  const ids = open.filter((o) => !booked.has(o.id)).map((o) => o.id);
  if (!ids.length) return { visits: 0, jobs: 0, keptForWork: booked.size };
  const visits = await trx
    .updateTable("serviceObligations")
    .set({ status: "cancelled", updatedAt: args.at })
    .where("organizationId", "=", args.organizationId)
    .where("id", "in", ids)
    .returning("id")
    .execute();
  const jobs = await trx
    .updateTable("jobs")
    .set({ status: "cancelled", cancelledAt: args.at, cancelReason: args.reason, updatedAt: args.at })
    .where("organizationId", "=", args.organizationId)
    .where("type", "=", "inspection")
    .where(
      "obligationId",
      "in",
      visits.map((v) => v.id),
    )
    .where("status", "=", "scheduled")
    .returning("id")
    .execute();
  return { visits: visits.length, jobs: jobs.length, keptForWork: booked.size };
}

/** The last day of service for the contract a visit belongs to, if its contract is ending or ended. */
export async function serviceEndForVisit(db: Transaction<DB> | Database, organizationId: string, obligationId: string) {
  const row = await db
    .selectFrom("serviceObligations as o")
    .innerJoin("contracts as c", (j) => j.onRef("c.id", "=", "o.contractId").onRef("c.organizationId", "=", "o.organizationId"))
    .select("c.serviceEndsOn")
    .where("o.organizationId", "=", organizationId)
    .where("o.id", "=", obligationId)
    .executeTakeFirst();
  return row?.serviceEndsOn ?? null;
}
