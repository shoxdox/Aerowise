"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { planRouteMap, type MapBounds, type MapPoint, type RouteMapStopInput } from "@aerowise/domain";
import type { GeoJSONSource, Map as MapLibreMap, Marker } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDemoCompany } from "@/lib/demo";
import { MAP_KIND_LABEL, MAP_KIND_LETTER, MAP_STOP_KINDS, type MapStopKind } from "./kinds";

// A street map of one or more routes: numbered stops in each route's color over a street
// basemap served from this site (/map-data/basemap.pmtiles, fonts under /map/fonts). Nothing
// is fetched from any other site. The map library loads only when a map is shown, and any
// failure (no map installed, no signal, no WebGL) leaves a note in its place: the stop list
// beside it never depends on it.

export interface StreetMapStop extends RouteMapStopInput {
  /** What the stop is, for its label: an address or a customer. */
  title: string;
  /** Inspection or a kind of work, for the marker's shape and letter; omitted is an inspection. */
  kind?: MapStopKind;
}

export interface StreetMapRoute {
  id: string;
  /** Whose route, for notes about stops that are not on the map; omitted with one route. */
  name?: string;
  color: string;
  stops: StreetMapStop[];
}

interface Props {
  routes: StreetMapRoute[];
  start?: (MapPoint & { address?: string }) | null;
  returnToStart?: boolean;
  /** The selected stop's key (job id). */
  selected?: string | null;
  onSelect: (key: string) => void;
  /** The view fits the stops again when this changes (a different day, say). */
  fitKey: string;
  label: string;
  /** Called when the map cannot be shown: it failed to start, or no stop has a location. */
  onUnavailable?: () => void;
}

export const TILES_URL = "/map-data/basemap.pmtiles";
const SOURCE = "basemap";
type Status = "loading" | "ready" | "failed";
/** How long the map may take to start, from loading its library to the first drawn view. */
const START_TIMEOUT_MS = 20_000;

let protocolAdded = false;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The installed map's own credit, or OpenStreetMap's when the map is built from it. */
function attributionFor(text: string | undefined): string {
  if (!text) return "Map data source not recorded";
  if (/openstreetmap/i.test(text)) {
    return '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a> (ODbL) · <a href="https://protomaps.com" target="_blank" rel="noopener noreferrer">Protomaps</a>';
  }
  return escapeHtml(text.replace(/<[^>]*>/g, ""));
}

function stopElement(s: { number: number; done: boolean; title: string; outside: boolean; kind: MapStopKind }, color: string, routeName: string | undefined, onClick: () => void) {
  const el = document.createElement("button");
  el.type = "button";
  // Work is a rounded square with its kind's letter in a corner; an inspection stays round.
  el.className = `map-stop${s.done ? " done" : ""}${s.kind === "inspection" ? "" : " work"}`;
  el.dataset.kind = s.kind;
  if (MAP_KIND_LETTER[s.kind]) el.dataset.letter = MAP_KIND_LETTER[s.kind];
  el.style.setProperty("--route", color);
  el.textContent = String(s.number);
  const who = routeName ? `${routeName}, ` : "";
  // Inspections are the usual stop and read as before; work says its kind.
  const kind = s.kind === "inspection" ? "" : `, ${MAP_KIND_LABEL[s.kind]}`;
  el.setAttribute("aria-label", `${who}stop ${s.number}${kind}: ${s.title}${s.done ? ", done" : ""}${s.outside ? ", outside the street map" : ""}`);
  el.title = `${s.number}.${kind ? ` ${MAP_KIND_LABEL[s.kind]}:` : ""} ${s.title}${s.done ? " (done)" : ""}`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return el;
}

export function StreetMap({ routes, start = null, returnToStart = false, selected = null, onSelect, fitKey, label, onUnavailable }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const startMarker = useRef<Marker | null>(null);
  const lib = useRef<typeof import("maplibre-gl") | null>(null);
  const fitted = useRef<string | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  const [status, setStatus] = useState<Status>("loading");
  const [coverage, setCoverage] = useState<MapBounds | null>(null);
  const [partial, setPartial] = useState(false);
  const demo = useDemoCompany();

  const plan = useMemo(() => planRouteMap({ routes, start, returnToStart, coverage }), [routes, start, returnToStart, coverage]);
  const located = plan.placed.length > 0 || !!start;

  // Create the map while there is something to put on it, and take it down when the map area
  // goes (no stop located any more) or the component unmounts. The deadline covers the whole
  // start-up, from loading the library to the first drawn view, so a request that never
  // answers ends in the note and the list, not an endless "Loading map…". Anything that
  // finishes after the deadline or the teardown is ignored.
  useEffect(() => {
    if (!located) {
      unavailable.current?.();
      return;
    }
    let settled = false;
    let loaded = false;
    let created: MapLibreMap | null = null;
    const teardown = () => {
      for (const marker of markers.current.values()) marker.remove();
      markers.current.clear();
      startMarker.current?.remove();
      startMarker.current = null;
      created?.remove();
      created = null;
      map.current = null;
      lib.current = null;
      fitted.current = null;
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      teardown();
      setStatus("failed");
      unavailable.current?.();
    };
    const deadline = setTimeout(fail, START_TIMEOUT_MS);
    (async () => {
      try {
        const [maplibre, pmtiles, basemaps] = await Promise.all([import("maplibre-gl"), import("pmtiles"), import("@protomaps/basemaps")]);
        if (settled || !container.current) return;
        const url = `${window.location.origin}${TILES_URL}`;
        const archive = new pmtiles.PMTiles(url);
        if (!protocolAdded) {
          const protocol = new pmtiles.Protocol();
          maplibre.addProtocol("pmtiles", protocol.tile);
          (globalThis as { __awPmtiles?: InstanceType<typeof pmtiles.Protocol> }).__awPmtiles = protocol;
          protocolAdded = true;
        }
        (globalThis as { __awPmtiles?: InstanceType<typeof pmtiles.Protocol> }).__awPmtiles!.add(archive);
        // No installed map (or no signal) shows here, before any map is drawn.
        const header = await archive.getHeader();
        if (settled) return;
        const metadata = (await archive.getMetadata().catch(() => ({}))) as { attribution?: string };
        if (settled || !container.current) return;
        setCoverage([header.minLon, header.minLat, header.maxLon, header.maxLat]);

        const layers = basemaps
          .layers(SOURCE, basemaps.namedFlavor("light"), { lang: "en" })
          // No icon sheet is served: drop the layers that are only icons, and icons from the rest.
          .filter((l) => !["pois", "roads_oneway", "roads_shields"].includes(l.id))
          .map((l) => {
            if (l.type !== "symbol" || !l.layout || !("icon-image" in l.layout)) return l;
            const layout = { ...l.layout };
            delete layout["icon-image"];
            return { ...l, layout };
          });
        // Copied next to the fonts at build time (scripts/copy-map-worker.mjs).
        maplibre.setWorkerUrl(`${window.location.origin}/map/maplibre/maplibre-gl-worker.mjs`);
        const m = new maplibre.Map({
          container: container.current,
          style: {
            version: 8,
            glyphs: `${window.location.origin}/map/fonts/{fontstack}/{range}.pbf`,
            sources: { [SOURCE]: { type: "vector", url: `pmtiles://${url}`, attribution: attributionFor(metadata.attribution) } },
            layers,
          },
          bounds: plan.fit ?? undefined,
          fitBoundsOptions: { padding: 40, maxZoom: 14 },
          attributionControl: { compact: false },
          cooperativeGestures: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
        });
        created = m;
        m.touchZoomRotate.disableRotation();
        m.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
        m.addControl(new maplibre.ScaleControl({ unit: "imperial" }), "bottom-left");
        m.on("error", (e: { error?: { message?: string; url?: string } }) => {
          const where = `${e.error?.url ?? ""} ${e.error?.message ?? ""}`;
          // A missing glyph range only costs a few characters of a label.
          if (where.includes("/map/fonts/")) return;
          if (!loaded) fail();
          else setPartial(true);
        });
        m.on("load", () => {
          if (settled) return;
          settled = true;
          loaded = true;
          clearTimeout(deadline);
          m.addSource("aw-order", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          m.addLayer({
            id: "aw-order-line",
            type: "line",
            source: "aw-order",
            paint: { "line-color": ["get", "color"], "line-width": 2.5, "line-opacity": 0.85, "line-dasharray": [2, 1.5] },
          });
          m.addLayer({
            id: "aw-order-label",
            type: "symbol",
            source: "aw-order",
            layout: { "symbol-placement": "line-center", "text-field": ["get", "label"], "text-font": ["Noto Sans Medium"], "text-size": 11, "text-allow-overlap": false },
            paint: { "text-color": ["get", "color"], "text-halo-color": "#ffffff", "text-halo-width": 2 },
          });
          lib.current = maplibre;
          map.current = m;
          setStatus("ready");
        });
      } catch {
        fail();
      }
    })();
    return () => {
      // Taken down (no stop located any more, or unmounted): the next map starts afresh.
      settled = true;
      clearTimeout(deadline);
      teardown();
      setStatus("loading");
      setPartial(false);
    };
    // plan.fit is only the first view; later changes fit in the effect below.
  }, [located]);

  // Draw the stops, the start and the visit-order lines; fit the view when the day changes.
  useEffect(() => {
    const m = map.current;
    const maplibre = lib.current;
    if (status !== "ready" || !m || !maplibre) return;
    for (const marker of markers.current.values()) marker.remove();
    markers.current.clear();
    startMarker.current?.remove();
    startMarker.current = null;

    const routeOf = new Map(routes.map((r) => [r.id, r]));
    const stopOf = new Map(routes.flatMap((r) => r.stops.map((s) => [s.key, s] as const)));
    for (const p of plan.placed) {
      const route = routeOf.get(p.routeId)!;
      const stop = stopOf.get(p.key);
      const el = stopElement({ ...p, title: stop?.title ?? "", kind: stop?.kind ?? "inspection" }, route.color, routes.length > 1 ? route.name : undefined, () => select.current(p.key));
      el.dataset.stop = p.key;
      el.dataset.route = p.routeId;
      if (p.key === selected) el.classList.add("selected");
      markers.current.set(p.key, new maplibre.Marker({ element: el, offset: p.offset }).setLngLat([p.lng, p.lat]).addTo(m));
    }
    if (start) {
      const el = document.createElement("div");
      el.className = "map-start";
      el.textContent = "S";
      el.title = `Start${start.address ? `: ${start.address}` : ""}`;
      el.setAttribute("role", "img");
      el.setAttribute("aria-label", `Start${start.address ? `: ${start.address}` : ""}`);
      startMarker.current = new maplibre.Marker({ element: el }).setLngLat([start.lng, start.lat]).addTo(m);
    }
    (m.getSource("aw-order") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: plan.segments.map((s) => ({
        type: "Feature",
        properties: { label: s.label, color: routeOf.get(s.routeId)?.color ?? "#1c2321" },
        geometry: {
          type: "LineString",
          coordinates: [
            [s.from.lng, s.from.lat],
            [s.to.lng, s.to.lat],
          ],
        },
      })),
    });
    if (fitted.current !== fitKey && plan.fit) {
      fitted.current = fitKey;
      m.fitBounds(plan.fit, { padding: 40, maxZoom: 14, duration: 0 });
    }
    // `selected` is applied by the next effect without redrawing.
  }, [status, plan, routes, start, fitKey]);

  useEffect(() => {
    for (const [key, marker] of markers.current) marker.getElement().classList.toggle("selected", key === selected);
  }, [selected, status, plan]);

  const multi = routes.length > 1;
  const nameOf = (routeId: string) => (multi ? `${routes.find((r) => r.id === routeId)?.name ?? ""}'s ` : "");
  const outside = plan.placed.filter((p) => p.outside);
  const kinds = useMemo(() => {
    const present = new Set(routes.flatMap((r) => r.stops.map((s) => s.kind ?? "inspection")));
    return MAP_STOP_KINDS.filter((k) => present.has(k));
  }, [routes]);

  if (!located) {
    return (
      <p className="muted small" data-testid="map-empty">
        {routes.some((r) => r.stops.length) ? "None of these stops has a map location yet, so there is no map. Use the list." : "No stops to show on the map."}
      </p>
    );
  }

  return (
    <div className="street-map-wrap" data-testid="street-map">
      <div className="street-map" aria-label={label} role="region" data-status={status}>
        <div ref={container} className="street-map-canvas" />
        {status === "loading" && <div className="street-map-overlay">Loading map…</div>}
        {status === "failed" && (
          <div className="street-map-overlay failed" role="status" data-testid="map-unavailable">
            The street map is not available right now. Every stop is still in the list.
          </div>
        )}
        {demo && status !== "failed" && <span className="map-chip">Demo: made-up locations</span>}
      </div>
      <p className="map-key small muted">Numbers are the visit order. Dashed lines join visits in that order; they are straight lines, not roads.</p>
      {kinds.some((k) => k !== "inspection") && (
        <p className="map-kinds small muted" data-testid="map-kinds">
          {kinds.map((k) => (
            <span key={k} className="map-kind">
              <span className={`map-kind-mark${k === "inspection" ? "" : " work"}`} data-letter={MAP_KIND_LETTER[k] || undefined} aria-hidden="true" />
              {MAP_KIND_LABEL[k]}
            </span>
          ))}
        </p>
      )}
      {partial && status === "ready" && <p className="small muted">Part of the street map could not load. The stops are still placed correctly.</p>}
      {plan.unlocated.length > 0 && (
        <p className="small warn-text" data-testid="map-unlocated">
          Not on the map (no location yet): {plan.unlocated.map((u) => `${nameOf(u.routeId)}stop ${u.number}`).join(", ")}.
        </p>
      )}
      {outside.length > 0 && status === "ready" && (
        <p className="small warn-text" data-testid="map-outside">
          Outside the installed street map, so shown without streets: {outside.map((p) => `${nameOf(p.routeId)}stop ${p.number}`).join(", ")}.
        </p>
      )}
    </div>
  );
}
