import type { Database, DB } from "@aerowise/db";
import { aerobicContractWarning } from "@aerowise/domain";
import type { Transaction } from "kysely";
import { HttpError } from "./errors.ts";

/**
 * SW-7: the warning before an aerobic inspection contract starts on a site whose active systems
 * are all recorded as something else (null when there is nothing to say). Other kinds of
 * contract never get it.
 */
export async function siteSystemWarning(ex: Database | Transaction<DB>, organizationId: string, siteId: string, serviceType: string): Promise<string | null> {
  if (serviceType !== "aerobic_inspection") return null;
  const systems = await ex
    .selectFrom("wastewaterSystems")
    .select("systemCategory")
    .where("organizationId", "=", organizationId)
    .where("siteId", "=", siteId)
    .where("active", "=", true)
    .execute();
  return aerobicContractWarning(systems.map((s) => s.systemCategory));
}

/** Refuses (409 `system_not_aerobic`) until the office confirms it, the way extra visits are confirmed. */
export async function requireSystemConfirmation(ex: Database | Transaction<DB>, organizationId: string, siteId: string, serviceType: string, confirmed: boolean | undefined) {
  const warning = await siteSystemWarning(ex, organizationId, siteId, serviceType);
  if (warning && !confirmed) throw new HttpError(409, "system_not_aerobic", warning);
}
