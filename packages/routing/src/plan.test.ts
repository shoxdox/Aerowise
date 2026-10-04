import { describe, expect, it } from "vitest";
import { CensusGeocoder } from "./census.ts";
import { geocoderFromEnv } from "./env.ts";
import { crowMiles, detourMiles, planRoute, summarizeRoute, type Point, type RouteStop } from "./plan.ts";
import { TestGeocoder } from "./test-geocoder.ts";

// Points along a line, about 6.9 miles apart (0.1 degree of latitude).
const at = (i: number): Point => ({ lat: 30 + i / 10, lng: -97.7 });
const stop = (id: string, p: Point | null): RouteStop => ({ id, point: p });

describe("distances", () => {
  it("measures great-circle miles", () => {
    // Austin to San Antonio is about 74 miles in a straight line.
    expect(crowMiles({ lat: 30.2672, lng: -97.7431 }, { lat: 29.4241, lng: -98.4936 })).toBeCloseTo(74, 0);
  });
});

describe("planRoute", () => {
  it("visits stops along a road in order, from the start", () => {
    const movable = [stop("c", at(3)), stop("a", at(1)), stop("d", at(4)), stop("b", at(2))];
    expect(planRoute({ start: at(0), returnToStart: true, fixed: [], movable })).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps done stops first and plans the rest from the last of them", () => {
    const fixed = [stop("done", at(5))];
    const movable = [stop("a", at(1)), stop("b", at(4)), stop("c", at(6))];
    // From 5 with a return to 0, going out to 6 first and then back down is shortest.
    expect(planRoute({ start: at(0), returnToStart: true, fixed, movable })).toEqual(["done", "c", "b", "a"]);
  });

  it("puts stops without a location last, in their current order", () => {
    const movable = [stop("x", null), stop("b", at(2)), stop("y", null), stop("a", at(1))];
    expect(planRoute({ start: at(0), returnToStart: false, fixed: [], movable })).toEqual(["a", "b", "x", "y"]);
  });

  it("chooses the best first stop when there is no start", () => {
    const movable = [stop("m", at(2)), stop("e1", at(0)), stop("e2", at(4))];
    const order = planRoute({ start: null, returnToStart: false, fixed: [], movable });
    expect([order, [...order].reverse()]).toContainEqual(["e1", "m", "e2"]);
  });

  it("keeps the current order when the saving is trivial", () => {
    // Two stops at almost the same spot: swapping them saves a few feet.
    const movable = [stop("a", { lat: 30.1, lng: -97.7 }), stop("b", { lat: 30.10001, lng: -97.7 })];
    expect(planRoute({ start: at(0), returnToStart: false, fixed: [], movable })).toEqual(["a", "b"]);
  });

  it("finds the loop on a grid", () => {
    // Nine stops on a 3x3 grid; the best closed tour from a corner walks the edge.
    const pts: RouteStop[] = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) pts.push(stop(`${r}${c}`, { lat: 30 + r / 10, lng: -97.7 + c / 10 }));
    const shuffled = [pts[4]!, pts[8]!, pts[0]!, pts[2]!, pts[6]!, pts[1]!, pts[7]!, pts[3]!, pts[5]!];
    const start = { lat: 29.95, lng: -97.75 };
    const order = planRoute({ start, returnToStart: true, fixed: [], movable: shuffled });
    const byId = new Map(pts.map((p) => [p.id, p]));
    const summary = (ids: string[]) =>
      summarizeRoute(ids.map((i) => byId.get(i)!), { start, returnToStart: true, model: { speedMph: 30 } }).driveMiles;
    expect(summary(order)).toBeLessThan(summary(shuffled.map((s) => s.id)));
    expect(new Set(order)).toEqual(new Set(pts.map((p) => p.id)));
  });
});

describe("summarizeRoute", () => {
  it("adds up legs from the start, skipping unlocated stops, and back", () => {
    const s = summarizeRoute([stop("a", at(1)), stop("x", null), stop("b", at(2))], { start: at(0), returnToStart: true, model: { speedMph: 30 } });
    expect(s.legs.map((l) => [l.fromId, l.toId])).toEqual([
      [null, "a"],
      ["a", "b"],
      ["b", null],
    ]);
    // 4 × 6.9 mi × 1.3 road factor ≈ 36 mi, at 30 mph ≈ 72 minutes.
    expect(s.driveMiles).toBeCloseTo(36, 0);
    expect(s.driveMinutes).toBeGreaterThanOrEqual(70);
    expect(s.driveMinutes).toBeLessThanOrEqual(74);
    expect(s.unlocatedIds).toEqual(["x"]);
  });

  it("has no legs for a day with no located stops", () => {
    expect(summarizeRoute([stop("x", null)], { start: at(0), returnToStart: true, model: { speedMph: 30 } }).legs).toEqual([]);
  });
});

describe("detourMiles", () => {
  it("is nothing for a stop on the way, and more for one off it", () => {
    const route = [at(1), at(3)];
    expect(detourMiles(route, at(2), { start: at(0), returnToStart: false })).toBe(0);
    expect(detourMiles(route, { lat: 30.2, lng: -97.5 }, { start: at(0), returnToStart: false })).toBeGreaterThan(10);
  });
});

describe("geocoders", () => {
  it("test geocoder is stable, clusters a city and has a not-found address", async () => {
    const g = new TestGeocoder();
    const a = await g.geocode({ addressLine1: "1 Main St", city: "Bastrop", state: "TX", postalCode: "78602" });
    expect(await g.geocode({ addressLine1: "1 Main St", city: "Bastrop", state: "TX", postalCode: "78602" })).toEqual(a);
    const b = await g.geocode({ addressLine1: "900 Elm Rd", city: "Bastrop", state: "TX", postalCode: "78602" });
    expect(crowMiles(a!, b!)).toBeLessThan(10);
    expect(await g.geocode({ addressLine1: "1 Main St", city: "Bastrop", state: "TX", postalCode: "00000" })).toBeNull();
  });

  it("census geocoder reads the first match", async () => {
    const urls: string[] = [];
    const census = new CensusGeocoder(async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -97.74, y: 30.27 } }] } }));
    });
    expect(await census.geocode({ addressLine1: "1100 Congress Ave", city: "Austin", state: "TX", postalCode: "78701" })).toEqual({ lat: 30.27, lng: -97.74 });
    expect(urls[0]).toContain("address=1100+Congress+Ave%2C+Austin%2C+TX+78701");
    expect(urls[0]).toContain("benchmark=Public_AR_Current");
  });

  it("census geocoder returns null for no match and throws on an outage", async () => {
    const none = new CensusGeocoder(async () => new Response(JSON.stringify({ result: { addressMatches: [] } })));
    expect(await none.geocode({ addressLine1: "x", city: "y", state: "TX" })).toBeNull();
    const down = new CensusGeocoder(async () => new Response("busy", { status: 503 }));
    await expect(down.geocode({ addressLine1: "x", city: "y", state: "TX" })).rejects.toThrow(/503/);
  });

  it("is chosen from the environment", () => {
    expect(geocoderFromEnv({}, false)?.kind).toBe("test");
    expect(geocoderFromEnv({}, true)?.kind).toBe("census");
    expect(geocoderFromEnv({ GEOCODER: "off" }, true)).toBeNull();
    expect(() => geocoderFromEnv({ GEOCODER: "test" }, true)).toThrow();
  });
});
