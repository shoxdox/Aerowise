import { describe, expect, it } from "vitest";
import { fanOffsets, planRouteMap } from "./route-map.ts";

const stop = (key: string, number: number, lat: number | null, lng: number | null, done = false) => ({ key, number, lat, lng, done });

describe("planning the street map of a day's routes", () => {
  it("places located stops, lists the rest and joins visits in order", () => {
    const plan = planRouteMap({
      routes: [
        { id: "a", stops: [stop("a1", 1, 30.1, -98.0), stop("a2", 2, null, null), stop("a3", 3, 30.2, -98.1, true)] },
        { id: "b", stops: [stop("b1", 1, 30.3, -97.9)] },
      ],
      start: { lat: 30.0, lng: -97.95 },
      returnToStart: true,
    });
    expect(plan.placed.map((p) => [p.routeId, p.number, p.done])).toEqual([
      ["a", 1, false],
      ["a", 3, true],
      ["b", 1, false],
    ]);
    expect(plan.unlocated).toEqual([{ routeId: "a", key: "a2", number: 2 }]);
    // The missing stop is skipped: the line goes 1 → 3, never through a made-up spot.
    expect(plan.segments.map((s) => `${s.routeId}: ${s.label}`)).toEqual(["a: Start → 1", "a: 1 → 3", "a: 3 → Start", "b: Start → 1", "b: 1 → Start"]);
    expect(plan.fit).toEqual([-98.1, 30.0, -97.9, 30.3]);
  });

  it("starts at the first stop when there is no start, and has nothing to fit with nothing located", () => {
    const plan = planRouteMap({ routes: [{ id: "a", stops: [stop("a1", 1, 30.1, -98.0), stop("a2", 2, 30.2, -98.0)] }] });
    expect(plan.segments.map((s) => s.label)).toEqual(["1 → 2"]);
    const empty = planRouteMap({
      routes: [
        { id: "a", stops: [stop("a1", 1, null, null)] },
        { id: "b", stops: [] },
      ],
    });
    expect([empty.placed, empty.segments, empty.fit]).toEqual([[], [], null]);
  });

  it("fans out stops at the same spot so each stays tappable", () => {
    const plan = planRouteMap({
      routes: [
        { id: "a", stops: [stop("a1", 1, 30.1, -98.0), stop("a2", 2, 30.100001, -98.000001)] },
        { id: "b", stops: [stop("b1", 1, 30.1, -98.0), stop("b2", 2, 30.5, -98.0)] },
      ],
    });
    const offsets = plan.placed.map((p) => p.offset);
    expect(new Set(offsets.slice(0, 3).map((o) => o.join(","))).size).toBe(3);
    expect(offsets[3]).toEqual([0, 0]);
    expect(fanOffsets(1)).toEqual([[0, 0]]);
    for (const [x, y] of fanOffsets(4)) expect(Math.hypot(x, y)).toBeGreaterThanOrEqual(15);
  });

  it("flags stops outside the map's coverage and ignores impossible coordinates", () => {
    const plan = planRouteMap({
      routes: [{ id: "a", stops: [stop("in", 1, 30.2, -98.0), stop("out", 2, 32.8, -96.8), stop("bad", 3, 95, -98)] }],
      coverage: [-98.6, 29.85, -97.0, 31.25],
    });
    expect(plan.placed.map((p) => [p.key, p.outside])).toEqual([
      ["in", false],
      ["out", true],
    ]);
    expect(plan.unlocated.map((u) => u.key)).toEqual(["bad"]);
  });
});
