import type { Database } from "@aerowise/db";

/** Today's calendar date (YYYY-MM-DD) in the organization's own timezone. */
export async function organizationToday(db: Database, organizationId: string, now: Date): Promise<string> {
  const org = await db.selectFrom("organizations").select("timezone").where("id", "=", organizationId).executeTakeFirstOrThrow();
  return dateInZone(now, org.timezone);
}

export function dateInZone(now: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
