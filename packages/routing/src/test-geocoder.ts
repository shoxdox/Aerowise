import type { Point } from "./plan.ts";
import type { AddressQuery, Geocoder } from "./geocoder.ts";

/** FNV-1a, so the same address always lands on the same spot. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s.toLowerCase().replace(/\s+/g, " ").trim()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
const unit = (h: number) => (h % 10_000) / 10_000 - 0.5;

/**
 * Development and test stand-in for a real geocoder: no network, same answer every time.
 * Each city gets a made-up centre within about 35 miles of central Texas and each street
 * address a spot within about 3 miles of it, so a city's sites cluster like real ones.
 * Postal code 00000 is "not found".
 */
export class TestGeocoder implements Geocoder {
  readonly kind = "test" as const;
  static readonly CENTER: Point = { lat: 30.6, lng: -97.7 };

  async geocode(a: AddressQuery): Promise<Point | null> {
    if (a.postalCode?.trim() === "00000") return null;
    const city = hash(`${a.city}|${a.state}`);
    const street = hash(`${a.addressLine1}|${a.addressLine2 ?? ""}`);
    const lat = TestGeocoder.CENTER.lat + unit(city) + unit(street) * 0.08;
    const lng = TestGeocoder.CENTER.lng + unit(city >>> 7) * 1.2 + unit(street >>> 7) * 0.1;
    return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  }
}
