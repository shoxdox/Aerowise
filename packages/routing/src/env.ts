import { CensusGeocoder } from "./census.ts";
import type { Geocoder } from "./geocoder.ts";
import { TestGeocoder } from "./test-geocoder.ts";

/**
 * The geocoder the environment asks for with GEOCODER: `census` (the default in
 * production), `test` (the default elsewhere; never in production) or `off`.
 */
export function geocoderFromEnv(env: Record<string, string | undefined>, production: boolean): Geocoder | null {
  const choice = env.GEOCODER ?? (production ? "census" : "test");
  if (choice === "off") return null;
  if (choice === "census") return new CensusGeocoder();
  if (choice === "test" && !production) return new TestGeocoder();
  throw new Error(`GEOCODER must be census or off${production ? "" : ", or test"}; got ${choice}`);
}
