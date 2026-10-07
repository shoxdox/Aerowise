// What the street map of a day's routes draws, worked out without a map library: which stops
// can be placed, which are outside the map's coverage, which share a spot (and how to fan
// them out so each stays tappable), the visit-order lines and the area to show first.

export interface MapPoint {
  lat: number;
  lng: number;
}

/** West, south, east, north, in degrees. */
export type MapBounds = [number, number, number, number];

export interface RouteMapStopInput {
  /** The job id. */
  key: string;
  lat: number | null;
  lng: number | null;
  /** The stop's number in its route, as in the stop list. */
  number: number;
  done: boolean;
}

export interface RouteMapRouteInput {
  id: string;
  stops: RouteMapStopInput[];
}

export interface PlacedStop extends RouteMapStopInput {
  lat: number;
  lng: number;
  routeId: string;
  /** Screen offset in pixels, so stops at the same spot fan out instead of hiding each other. */
  offset: [number, number];
  /** Outside the area the installed map covers: drawn on a blank background. */
  outside: boolean;
}

/** One straight line between two consecutive visits, labelled with the visit order. */
export interface OrderSegment {
  routeId: string;
  from: MapPoint;
  to: MapPoint;
  label: string;
}

export interface RouteMapPlan {
  placed: PlacedStop[];
  /** Stops with no coordinates, by route. */
  unlocated: { routeId: string; key: string; number: number }[];
  segments: OrderSegment[];
  /** The area to show first: every placed stop and the start; null when there is nothing to place. */
  fit: MapBounds | null;
}

const located = (s: { lat: number | null; lng: number | null }): s is { lat: number; lng: number } =>
  s.lat !== null && s.lng !== null && Number.isFinite(s.lat) && Number.isFinite(s.lng) && Math.abs(s.lat) <= 90 && Math.abs(s.lng) <= 180;

export function insideBounds(p: MapPoint, b: MapBounds): boolean {
  return p.lng >= b[0] && p.lng <= b[2] && p.lat >= b[1] && p.lat <= b[3];
}

/** Pixel offsets around a shared spot: none for one stop, a small ring for more. */
export function fanOffsets(n: number, radius = 16): [number, number][] {
  if (n <= 1) return [[0, 0]];
  const r = radius + Math.max(0, n - 6) * 3;
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)] as [number, number];
  });
}

/** Stops closer than this (degrees, about 10 m) are treated as the same spot. */
const SAME_SPOT = 0.0001;

export function planRouteMap(input: { routes: RouteMapRouteInput[]; start?: MapPoint | null; returnToStart?: boolean; coverage?: MapBounds | null }): RouteMapPlan {
  const { routes, start = null, returnToStart = false, coverage = null } = input;
  const placed: PlacedStop[] = [];
  const unlocated: RouteMapPlan["unlocated"] = [];
  const segments: OrderSegment[] = [];

  for (const route of routes) {
    let prev: { point: MapPoint; label: string } | null = start ? { point: start, label: "Start" } : null;
    for (const s of route.stops) {
      if (!located(s)) {
        unlocated.push({ routeId: route.id, key: s.key, number: s.number });
        continue;
      }
      const point = { lat: s.lat, lng: s.lng };
      placed.push({ ...s, ...point, routeId: route.id, offset: [0, 0], outside: coverage ? !insideBounds(point, coverage) : false });
      if (prev) segments.push({ routeId: route.id, from: prev.point, to: point, label: `${prev.label} → ${s.number}` });
      prev = { point, label: String(s.number) };
    }
    if (start && returnToStart && prev && prev.label !== "Start") segments.push({ routeId: route.id, from: prev.point, to: start, label: `${prev.label} → Start` });
  }

  // Stops at one spot (two visits at one address, or several routes through one yard) fan out.
  const groups = new Map<string, PlacedStop[]>();
  for (const p of placed) {
    const k = `${Math.round(p.lat / SAME_SPOT)}:${Math.round(p.lng / SAME_SPOT)}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  for (const g of groups.values()) {
    const offsets = fanOffsets(g.length);
    g.forEach((p, i) => (p.offset = offsets[i]!));
  }

  const points: MapPoint[] = [...placed, ...(start ? [start] : [])];
  const fit: MapBounds | null = points.length
    ? [Math.min(...points.map((p) => p.lng)), Math.min(...points.map((p) => p.lat)), Math.max(...points.map((p) => p.lng)), Math.max(...points.map((p) => p.lat))]
    : null;
  return { placed, unlocated, segments, fit };
}
