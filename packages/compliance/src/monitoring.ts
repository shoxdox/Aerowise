import type { Database, DB } from "@aerowise/db";
import type { Transaction } from "kysely";

type Executor = Database | Transaction<DB>;

/**
 * Whether a site had qualifying electronic monitoring on a date: an active system at the
 * site with a monitoring record that had started, been checked, and not ended by then.
 */
export async function siteMonitoredOn(db: Executor, organizationId: string, siteId: string, onDate: string): Promise<boolean> {
  const row = await db
    .selectFrom("systemMonitoring as m")
    .innerJoin("wastewaterSystems as w", (j) => j.onRef("w.id", "=", "m.systemId").onRef("w.organizationId", "=", "m.organizationId"))
    .select("m.id")
    .where("m.organizationId", "=", organizationId)
    .where("w.siteId", "=", siteId)
    .where("w.active", "=", true)
    .where("m.checkedOn", "<=", onDate)
    .where((eb) => eb.or([eb("m.endedOn", "is", null), eb("m.endedOn", ">", onDate)]))
    .executeTakeFirst();
  return row !== undefined;
}
