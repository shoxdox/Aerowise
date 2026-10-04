import type { Database } from "@aerowise/db";
import { dateInZone } from "@aerowise/domain";

export { dateInZone };

/** Today's calendar date (YYYY-MM-DD) in the organization's own timezone. */
export async function organizationToday(db: Database, organizationId: string, now: Date): Promise<string> {
  const org = await db.selectFrom("organizations").select("timezone").where("id", "=", organizationId).executeTakeFirstOrThrow();
  return dateInZone(now, org.timezone);
}
