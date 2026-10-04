/**
 * Travel estimates and stop ordering. Pure functions: no database, no network.
 *
 * Distances are straight-line (great-circle) miles stretched by a road factor, and
 * times assume an average driving speed. That is close enough to compare one order of
 * stops with another and to tell whether a day fits, without a paid routing service.
 */

export interface Point {
  lat: number;
  lng: number;
}

export interface TravelModel {
  /** Average driving speed, miles per hour. */
  speedMph: number;
}

/** Roads are longer than the straight line; 1.3 is a common rural/suburban average. */
export const ROAD_FACTOR = 1.3;
const EARTH_RADIUS_MILES = 3958.8;

/** Straight-line distance in miles. */
export function crowMiles(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Estimated driving miles. */
export function roadMiles(a: Point, b: Point): number {
  return crowMiles(a, b) * ROAD_FACTOR;
}

export function driveMinutes(miles: number, model: TravelModel): number {
  return (miles / model.speedMph) * 60;
}

export interface RouteStop {
  id: string;
  point: Point | null;
}

export interface Leg {
  /** The stop this leg drives to; null for the drive back to the start. */
  toId: string | null;
  /** The stop it leaves from; null when it leaves from the start. */
  fromId: string | null;
  miles: number;
  minutes: number;
}

export interface RouteSummary {
  legs: Leg[];
  driveMiles: number;
  driveMinutes: number;
  /** Stops with no location: not on the map and not in the estimate. */
  unlocatedIds: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The drive for stops visited in the given order. Stops without a location are skipped
 * (the leg goes from the last located stop to the next one).
 */
export function summarizeRoute(stops: RouteStop[], opts: { start: Point | null; returnToStart: boolean; model: TravelModel }): RouteSummary {
  const legs: Leg[] = [];
  let at: { id: string | null; point: Point } | null = opts.start ? { id: null, point: opts.start } : null;
  for (const s of stops) {
    if (!s.point) continue;
    if (at) {
      const miles = roadMiles(at.point, s.point);
      legs.push({ fromId: at.id, toId: s.id, miles: round1(miles), minutes: Math.round(driveMinutes(miles, opts.model)) });
    }
    at = { id: s.id, point: s.point };
  }
  if (opts.start && opts.returnToStart && at && at.id !== null) {
    const miles = roadMiles(at.point, opts.start);
    legs.push({ fromId: at.id, toId: null, miles: round1(miles), minutes: Math.round(driveMinutes(miles, opts.model)) });
  }
  return {
    legs,
    driveMiles: round1(legs.reduce((n, l) => n + l.miles, 0)),
    driveMinutes: legs.reduce((n, l) => n + l.minutes, 0),
    unlocatedIds: stops.filter((s) => !s.point).map((s) => s.id),
  };
}

export interface PlanInput {
  /** Where the day begins and, with `returnToStart`, ends. Without it, the route starts at its first stop. */
  start: Point | null;
  returnToStart: boolean;
  /** Stops already done or under way, in the order they happened. They stay first. */
  fixed: RouteStop[];
  /** Stops still to visit, in their current order. */
  movable: RouteStop[];
}

/**
 * The shortest order found for the stops still to visit. Starts from a nearest-neighbour
 * tour and improves it with 2-opt and or-opt moves until neither helps. Stops without a
 * location go last, in their current order. The current order is kept unless the new one
 * is meaningfully shorter, so pressing the button twice never shuffles a route.
 */
export function planRoute(input: PlanInput): string[] {
  const located = input.movable.filter((s): s is RouteStop & { point: Point } => s.point !== null);
  const unlocated = input.movable.filter((s) => !s.point).map((s) => s.id);
  const lastFixed = [...input.fixed].reverse().find((s) => s.point)?.point ?? null;
  const origin = lastFixed ?? input.start;
  const end = input.returnToStart ? input.start : null;

  const cost = (seq: Point[]) => {
    let total = 0;
    let at = origin;
    for (const p of seq) {
      if (at) total += crowMiles(at, p);
      at = p;
    }
    if (end && at) total += crowMiles(at, end);
    return total;
  };

  const current = located;
  let best = nearestNeighbour(located, origin);
  if (!origin) {
    // A free start: try each stop as the first one.
    for (const first of located) {
      const tour = [first, ...nearestNeighbour(located.filter((s) => s !== first), first.point)];
      if (cost(tour.map((s) => s.point)) < cost(best.map((s) => s.point))) best = tour;
    }
  }
  best = improve(best, (seq) => cost(seq.map((s) => s.point)));
  const improved = improve(current, (seq) => cost(seq.map((s) => s.point)));
  if (cost(improved.map((s) => s.point)) < cost(best.map((s) => s.point))) best = improved;

  // Keep the current order unless the new one saves at least a quarter mile and 1%.
  const before = cost(current.map((s) => s.point));
  const after = cost(best.map((s) => s.point));
  const chosen = before - after > Math.max(0.25, before * 0.01) ? best : current;
  return [...input.fixed.map((s) => s.id), ...chosen.map((s) => s.id), ...unlocated];
}

function nearestNeighbour<T extends { point: Point }>(stops: T[], from: Point | null): T[] {
  const left = [...stops];
  const out: T[] = [];
  let at = from;
  while (left.length) {
    let k = 0;
    if (at) {
      let d = Infinity;
      left.forEach((s, i) => {
        const x = crowMiles(at!, s.point);
        if (x < d) [d, k] = [x, i];
      });
    }
    const next = left.splice(k, 1)[0]!;
    out.push(next);
    at = next.point;
  }
  return out;
}

/** 2-opt (reverse a stretch) and or-opt (move a run of 1-3 stops) until no move helps. */
function improve<T>(tour: T[], cost: (seq: T[]) => number): T[] {
  let best = [...tour];
  let bestCost = cost(best);
  const n = best.length;
  for (let pass = 0; pass < 100; pass++) {
    let better = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const cand = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const c = cost(cand);
        if (c < bestCost - 1e-9) [best, bestCost, better] = [cand, c, true];
      }
    }
    for (let len = 1; len <= Math.min(3, n - 1); len++) {
      for (let i = 0; i + len <= n; i++) {
        const run = best.slice(i, i + len);
        const rest = [...best.slice(0, i), ...best.slice(i + len)];
        for (let k = 0; k <= rest.length; k++) {
          if (k === i) continue;
          const cand = [...rest.slice(0, k), ...run, ...rest.slice(k)];
          const c = cost(cand);
          if (c < bestCost - 1e-9) [best, bestCost, better] = [cand, c, true];
        }
      }
    }
    if (!better) break;
  }
  return best;
}

/**
 * The extra driving, in miles, to fit a new stop into a route at its cheapest place.
 * `route` is the day's located stops in order; the start (and, with `returnToStart`,
 * the end) is included when there is one.
 */
export function detourMiles(route: Point[], candidate: Point, opts: { start: Point | null; returnToStart: boolean }): number {
  const seq = [...(opts.start ? [opts.start] : []), ...route, ...(opts.start && opts.returnToStart ? [opts.start] : [])];
  if (seq.length === 0) return 0;
  // Before the first point or after the last, when the route is open at that end.
  let best = Infinity;
  if (!opts.start) best = Math.min(best, roadMiles(candidate, seq[0]!));
  if (!(opts.start && opts.returnToStart)) best = Math.min(best, roadMiles(seq[seq.length - 1]!, candidate));
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i]!;
    const b = seq[i + 1]!;
    best = Math.min(best, roadMiles(a, candidate) + roadMiles(candidate, b) - roadMiles(a, b));
  }
  return round1(Math.max(0, best));
}
