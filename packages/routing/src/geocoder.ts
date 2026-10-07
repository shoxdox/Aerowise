import type { Point } from "./plan.ts";

export interface AddressQuery {
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  postalCode?: string | null;
}

/**
 * Finds an address on the map. Returns null when the address cannot be found.
 * `organizationId` names the company the address belongs to, so a demo company's made-up
 * addresses never reach a real geocoder (the gate in @aerowise/tasks decides by it).
 */
export interface Geocoder {
  readonly kind: "test" | "census";
  geocode(address: AddressQuery, organizationId?: string): Promise<Point | null>;
}

export function oneLine(a: AddressQuery): string {
  return [a.addressLine1, a.addressLine2, a.city, [a.state, a.postalCode].filter(Boolean).join(" ")]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(", ");
}

export class GeocodeError extends Error {}
