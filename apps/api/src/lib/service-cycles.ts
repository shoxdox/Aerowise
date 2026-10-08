import type { DB } from "@aerowise/db";
import type { Transaction } from "kysely";

// Pumping and maintenance visits (SW-9, service workflows plan §4.4) are done as work orders.

type Trx = Transaction<DB>;

/**
 * A work order closed: the pumping or maintenance visit it was booked for follows, in the
 * same transaction. Completed work completes the visit. A cancelled order leaves the visit
 * open to book again, unless its contract no longer serves it (cancelled, or the visit starts
 * after the last day of service), when the visit is cancelled too. Called from
 * `setWorkOrderStatus`, so every way an order closes takes this path.
 */
export async function cycleVisitOnClose(trx: Trx, organizationId: string, workOrderId: string, to: "completed" | "cancelled", at: Date) {
  const wo = await trx.selectFrom("workOrders").select("obligationId").where("organizationId", "=", organizationId).where("id", "=", workOrderId).executeTakeFirstOrThrow();
  if (!wo.obligationId) return;
  const o = await trx
    .selectFrom("serviceObligations as o")
    .innerJoin("contracts as c", (j) => j.onRef("c.id", "=", "o.contractId").onRef("c.organizationId", "=", "o.organizationId"))
    .select(["o.id", "o.status", "o.windowStart", "c.status as contractStatus", "c.serviceEndsOn"])
    .where("o.organizationId", "=", organizationId)
    .where("o.id", "=", wo.obligationId)
    .forUpdate("o")
    .executeTakeFirstOrThrow();
  if (o.status !== "open") return;
  if (to === "completed") {
    await trx.updateTable("serviceObligations").set({ status: "completed", completedAt: at, updatedAt: at }).where("organizationId", "=", organizationId).where("id", "=", o.id).execute();
    return;
  }
  const ended = o.contractStatus === "cancelled" || (o.serviceEndsOn !== null && o.windowStart > o.serviceEndsOn);
  if (ended) await trx.updateTable("serviceObligations").set({ status: "cancelled", updatedAt: at }).where("organizationId", "=", organizationId).where("id", "=", o.id).execute();
}
