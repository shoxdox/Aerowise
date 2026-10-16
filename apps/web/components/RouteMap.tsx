"use client";

import type { RouteDay, Stop } from "@aerowise/domain";
import Link from "next/link";
import { useMemo, useState } from "react";
import { MAP_KIND_LABEL, MAP_STOP_KINDS, stopKind, type MapStopKind } from "@/components/map/kinds";
import { StreetMap, type StreetMapRoute } from "@/components/map/StreetMap";
import { SafetyBadges } from "@/components/SafetyBadges";
import { day as formatDay, duration, plural } from "@/lib/format";

/** One color per technician column, in column order. */
export const ROUTE_COLORS = ["#1f6f5c", "#2b59c3", "#b54708", "#7a3fb0", "#c4314b", "#4d7c0f"];

interface Props {
  day: RouteDay;
  /** Technician ids in column order, so each route keeps its column's color. */
  technicianIds: string[];
  /** Stop number shown on each marker, by job id. */
  numbers: Map<string, number>;
  /** The day's stops, for the details of a selected one. */
  stops: Stop[];
}

const STATUS_LABEL: Record<string, string> = { scheduled: "To do", in_progress: "In progress", completed: "Done", cancelled: "Cancelled" };

/**
 * The day's routes on a street map: numbered stops in each technician's color, the start,
 * and straight dashed lines in visit order. Selecting a stop shows its details and a link
 * to its site. The stop list beside it stays the way to work the schedule. Kinds of stop can
 * be hidden from the map; that changes only what is drawn, never the route or its numbers.
 */
export function RouteMap({ day, technicianIds, numbers, stops }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<MapStopKind>>(new Set());
  const stopOf = useMemo(() => new Map(stops.map((s) => [s.jobId, s])), [stops]);
  const kinds = useMemo(() => {
    const present = new Set(
      day.technicians.flatMap((t) =>
        t.stops.map((s) => {
          const full = stopOf.get(s.jobId);
          return full ? stopKind(full) : "inspection";
        }),
      ),
    );
    return MAP_STOP_KINDS.filter((k) => present.has(k));
  }, [day, stopOf]);

  const routes: StreetMapRoute[] = useMemo(
    () =>
      day.technicians.map((t) => ({
        id: t.technicianId,
        name: t.technicianName,
        color: ROUTE_COLORS[Math.max(0, technicianIds.indexOf(t.technicianId)) % ROUTE_COLORS.length]!,
        stops: t.stops
          .map((s, i) => {
            const full = stopOf.get(s.jobId);
            return {
              key: s.jobId,
              lat: s.lat,
              lng: s.lng,
              number: numbers.get(s.jobId) ?? i + 1,
              done: s.status === "completed",
              title: full ? `${full.site.addressLine1}, ${full.site.city}` : "Stop",
              kind: full ? stopKind(full) : ("inspection" as const),
            };
          })
          // Hidden kinds leave the map only; the lines join the stops still shown, labelled with their own numbers.
          .filter((s) => !hidden.has(s.kind)),
      })),
    [day, technicianIds, numbers, stopOf, hidden],
  );

  const sel = selected ? stopOf.get(selected) : undefined;
  const selRoute = sel ? day.technicians.find((t) => t.technicianId === sel.technicianId) : undefined;
  const leg = sel ? selRoute?.legs.find((l) => l.toJobId === sel.jobId) : undefined;
  const color = sel ? routes.find((r) => r.id === sel.technicianId)?.color : undefined;

  const toggle = (k: MapStopKind) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(k)) next.add(k);
      return next;
    });

  return (
    <div className="stack">
      {kinds.length > 1 && (
        <fieldset className="map-filter small" data-testid="map-kind-filter">
          <legend className="muted">Show on the map</legend>
          {kinds.map((k) => (
            <label key={k} className="row">
              <input type="checkbox" checked={!hidden.has(k)} onChange={() => toggle(k)} />
              {MAP_KIND_LABEL[k]}
            </label>
          ))}
        </fieldset>
      )}
      <StreetMap
        routes={routes}
        start={day.start}
        returnToStart={day.returnToStart}
        selected={selected}
        onSelect={setSelected}
        fitKey={day.date}
        label={`Map of ${plural(day.technicians.length, "route")} on ${formatDay(day.date, { month: "short", day: "numeric" })}`}
      />
      {sel && (
        <div className="card tight map-detail" data-testid="map-stop-detail">
          <div className="row">
            <span className="stop-number" style={{ background: color }}>
              {numbers.get(sel.jobId)}
            </span>
            <strong>
              {sel.site.addressLine1}, {sel.site.city}
            </strong>
            <span className="spacer" />
            <button className="link" aria-label="Close stop details" onClick={() => setSelected(null)}>
              ✕
            </button>
          </div>
          <div className="small">
            {sel.technicianName} · stop {numbers.get(sel.jobId)} ·{" "}
            <span className={`badge ${sel.status === "completed" ? "completed" : ""}`}>{STATUS_LABEL[sel.status] ?? sel.status}</span>
          </div>
          {sel.workOrder && (
            <div className="small">
              {sel.workOrder.label} · {sel.workOrder.workTypeName} · {sel.workOrder.title}
            </div>
          )}
          <div className="muted small">
            {sel.customer.displayName}
            {sel.obligation && (
              <>
                {" "}
                · visit #{sel.obligation.sequence} · due {formatDay(sel.obligation.dueOn, { month: "short", day: "numeric" })}
              </>
            )}
          </div>
          {leg && (
            <div className="muted small">
              About {leg.miles} mi · {duration(leg.minutes)} from the {leg.fromJobId ? "previous stop" : "start"} (estimate from straight-line distance, no traffic)
            </div>
          )}
          <SafetyBadges flags={sel.site.safetyFlags} />
          {sel.site.schedulingNotes && <div className="small restriction">⚠ {sel.site.schedulingNotes}</div>}
          <Link href={`/sites/${sel.site.id}`}>Open site</Link>
        </div>
      )}
    </div>
  );
}
