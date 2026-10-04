import type { Database } from "@aerowise/db";
import type { Geocoder } from "./geocoder.ts";

/**
 * Looks up sites that have no coordinates yet, a batch at a time. A site whose address
 * cannot be found is marked `not_found` and left for a person; it is tried again when its
 * address changes. Each site is saved as soon as it is found, so a geocoder outage
 * part-way through loses nothing.
 */
export async function locatePendingSites(db: Database, geocoder: Geocoder, organizationId: string, limit = 50) {
  const sites = await db
    .selectFrom("sites")
    .select(["id", "addressLine1", "addressLine2", "city", "state", "postalCode"])
    .where("organizationId", "=", organizationId)
    .where("lat", "is", null)
    .where("geocodeStatus", "is", null)
    .where("active", "=", true)
    .orderBy("createdAt")
    .limit(limit + 1)
    .execute();
  let located = 0;
  let notFound = 0;
  for (const s of sites.slice(0, limit)) {
    const point = await geocoder.geocode(s);
    // Only if nobody changed the address or placed the site meanwhile.
    const r = await db
      .updateTable("sites")
      .set(point ? { lat: point.lat, lng: point.lng, locationSource: "geocoder" } : { geocodeStatus: "not_found" })
      .where("organizationId", "=", organizationId)
      .where("id", "=", s.id)
      .where("lat", "is", null)
      .where("geocodeStatus", "is", null)
      .where("addressLine1", "=", s.addressLine1)
      .where("addressLine2", "is not distinct from", s.addressLine2)
      .where("city", "=", s.city)
      .where("state", "=", s.state)
      .where("postalCode", "is not distinct from", s.postalCode)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) continue;
    if (point) located++;
    else notFound++;
  }
  return { located, notFound, more: sites.length > limit };
}
