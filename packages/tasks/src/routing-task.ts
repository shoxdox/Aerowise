import type { Database, DB } from "@aerowise/db";
import { locatePendingSites, type Geocoder } from "@aerowise/routing";
import type { Transaction } from "kysely";
import { enqueue } from "./queue.ts";

export const LOCATE_SITES = "routing.locate_sites";

type Executor = Database | Transaction<DB>;

/**
 * Queues a lookup of the organization's sites that are not on the map yet. `reason`
 * names what made it necessary (a site and its address, an import), so the same change
 * never queues twice; the periodic sweep picks up anything missed.
 */
export async function queueSiteLocating(db: Executor, organizationId: string, reason: string, now: Date) {
  await enqueue(db, {
    kind: LOCATE_SITES,
    organizationId,
    payload: { organizationId },
    dedupeKey: `${LOCATE_SITES}:${organizationId}:${reason}`.slice(0, 500),
    runAt: now,
  });
}

/** Queues a lookup for each organization that has sites waiting for one. */
export async function scheduleSiteLocating(db: Executor, now: Date, intervalMs: number) {
  const orgs = await db
    .selectFrom("sites")
    .select("organizationId")
    .distinct()
    .where("lat", "is", null)
    .where("geocodeStatus", "is", null)
    .where("active", "=", true)
    .execute();
  for (const { organizationId } of orgs) {
    await queueSiteLocating(db, organizationId, `sweep:${Math.floor(now.getTime() / intervalMs)}`, now);
  }
}

export async function locateSites(db: Database, geocoder: Geocoder, organizationId: string, now: Date) {
  const r = await locatePendingSites(db, geocoder, organizationId);
  // A big backlog (an import) goes in several runs, one after another.
  if (r.more) await queueSiteLocating(db, organizationId, `more:${now.getTime()}`, now);
  return r;
}
