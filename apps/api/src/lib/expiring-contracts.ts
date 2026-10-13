import type { Database } from "@aerowise/db";
import { addDays, CONTRACT_EXPIRING_DAYS } from "@aerowise/domain";

/** The same full dataset backs the headline and its site-list destination. */
export function expiringContracts(db: Database, organizationId: string, today: string) {
  return db.selectFrom("contracts as k").innerJoin("sites as expSite", (j) => j.onRef("expSite.id", "=", "k.siteId").onRef("expSite.organizationId", "=", "k.organizationId"))
    .where("k.organizationId", "=", organizationId).where("k.status", "=", "active").where("k.serviceEndsOn", "is", null).where("expSite.active", "=", true)
    .where("k.endOn", ">=", today).where("k.endOn", "<=", addDays(today, CONTRACT_EXPIRING_DAYS))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("contracts as n").select("n.id").whereRef("n.organizationId", "=", "k.organizationId").whereRef("n.previousContractId", "=", "k.id"))))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("contracts as later").select("later.id").whereRef("later.organizationId", "=", "k.organizationId").whereRef("later.siteId", "=", "k.siteId").where("later.status", "=", "active").whereRef("later.startOn", ">", "k.endOn"))));
}
