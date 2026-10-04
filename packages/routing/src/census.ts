import type { Point } from "./plan.ts";
import { GeocodeError, oneLine, type AddressQuery, type Geocoder } from "./geocoder.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The US Census Bureau geocoder: free, no account or key, and US addresses only, which
 * suits Texas providers. https://geocoding.geo.census.gov/geocoder/
 */
export class CensusGeocoder implements Geocoder {
  readonly kind = "census" as const;
  constructor(
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
    private readonly baseUrl = "https://geocoding.geo.census.gov/geocoder",
  ) {}

  async geocode(address: AddressQuery): Promise<Point | null> {
    const url = `${this.baseUrl}/locations/onelineaddress?${new URLSearchParams({ address: oneLine(address), benchmark: "Public_AR_Current", format: "json" })}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new GeocodeError(`Census geocoder unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new GeocodeError(`Census geocoder answered ${res.status}`);
    const body = (await res.json()) as { result?: { addressMatches?: { coordinates?: { x?: number; y?: number } }[] } };
    const c = body.result?.addressMatches?.[0]?.coordinates;
    if (typeof c?.x !== "number" || typeof c.y !== "number") return null;
    return { lat: c.y, lng: c.x };
  }
}
