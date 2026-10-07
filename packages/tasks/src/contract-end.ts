import type { Database, DB } from "@aerowise/db";
import type { Transaction } from "kysely";

/**
 * Cancels a contract's open visits (all of them, or only those whose window starts after
 * `windowStartAfter`) and the jobs scheduled for them that have not started, so they leave
 * the technician's route. Completed visits and jobs already under way are kept.
 */
export async function cancelOpenVisits(
  trx: Transaction<DB>,
  args: { organizationId: string; contractIds: string[]; windowStartAfter?: string; reason: string; at: Date },
) {
  if (!args.contractIds.length) return { visits: 0, jobs: 0 };
  let q = trx
    .updateTable("serviceObligations")
    .set({ status: "cancelled", updatedAt: args.at })
    .where("organizationId", "=", args.organizationId)
    .where("contractId", "in", args.contractIds)
    .where("status", "=", "open");
  if (args.windowStartAfter) q = q.where("windowStart", ">", args.windowStartAfter);
  const visits = await q.returning("id").execute();
  if (!visits.length) return { visits: 0, jobs: 0 };
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
  return { visits: visits.length, jobs: jobs.length };
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
