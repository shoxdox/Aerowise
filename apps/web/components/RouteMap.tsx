"use client";

import type { RouteDay } from "@aerowise/domain";

/** One color per technician column, in column order. */
export const ROUTE_COLORS = ["#1f6f5c", "#2b59c3", "#b54708", "#7a3fb0", "#c4314b", "#4d7c0f"];

interface Props {
  day: RouteDay;
  /** Technician ids in column order, so each route keeps its column's color. */
  technicianIds: string[];
  /** Stop number shown on each marker, by job id. */
  numbers: Map<string, number>;
}

const W = 640;

/**
 * The day's routes drawn to scale on a plain background: no map tiles, so it needs no
 * map service or key. Each route is a line from the start through its stops in order.
 */
export function RouteMap({ day, technicianIds, numbers }: Props) {
  const points = [
    ...(day.start ? [day.start] : []),
    ...day.technicians.flatMap((t) => t.stops.flatMap((s) => (s.lat !== null && s.lng !== null ? [{ lat: s.lat, lng: s.lng }] : []))),
  ];
  if (points.length === 0) return <p className="muted small">No stops on the map for this day.</p>;

  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const k = Math.cos((midLat * Math.PI) / 180);
  // Degrees across, with a margin and a floor so one stop is not drawn at infinite zoom.
  const spanX = Math.max((Math.max(...lngs) - Math.min(...lngs)) * k, 0.05);
  const spanY = Math.max(Math.max(...lats) - Math.min(...lats), 0.05);
  const cx = ((Math.min(...lngs) + Math.max(...lngs)) / 2) * k;
  const cy = (Math.min(...lats) + Math.max(...lats)) / 2;
  const H = Math.round(Math.min(420, Math.max(240, (W * spanY) / spanX)));
  const scale = Math.min((W - 48) / spanX, (H - 48) / spanY);
  const xy = (p: { lat: number; lng: number }) => [W / 2 + (p.lng * k - cx) * scale, H / 2 - (p.lat - cy) * scale] as const;

  // A scale bar of a round number of miles, about a fifth of the width.
  const milesPerPx = 69 / scale;
  const barMiles = [1, 2, 5, 10, 20, 50, 100].find((m) => m / milesPerPx >= W / 8) ?? 100;

  return (
    <svg className="route-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Map of ${day.technicians.length} routes`}>
      <rect width={W} height={H} className="route-map-bg" />
      {day.technicians.map((t) => {
        const color = ROUTE_COLORS[Math.max(0, technicianIds.indexOf(t.technicianId)) % ROUTE_COLORS.length];
        const path = [
          ...(day.start ? [day.start] : []),
          ...t.stops.flatMap((s) => (s.lat !== null && s.lng !== null ? [{ lat: s.lat, lng: s.lng }] : [])),
          ...(day.start && day.returnToStart ? [day.start] : []),
        ].map(xy);
        return (
          <g key={t.technicianId}>
            <polyline points={path.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" opacity={0.75} />
            {t.stops.map((s) => {
              if (s.lat === null || s.lng === null) return null;
              const [x, y] = xy({ lat: s.lat, lng: s.lng });
              return (
                <g key={s.jobId}>
                  <circle cx={x} cy={y} r={11} fill={s.status === "completed" ? "#ffffff" : color} stroke={color} strokeWidth={2} />
                  <text x={x} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={600} fill={s.status === "completed" ? color : "#ffffff"}>
                    {numbers.get(s.jobId) ?? ""}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
      {day.start &&
        (() => {
          const [x, y] = xy(day.start);
          return (
            <g>
              <rect x={x - 8} y={y - 8} width={16} height={16} rx={3} fill="#1c2321" />
              <text x={x + 12} y={y + 4} fontSize={11} fill="#1c2321">
                Start
              </text>
            </g>
          );
        })()}
      <g transform={`translate(16, ${H - 16})`}>
        <line x1={0} x2={barMiles / milesPerPx} y1={0} y2={0} stroke="#5d6b66" strokeWidth={2} />
        <text x={0} y={-5} fontSize={10} fill="#5d6b66">
          {barMiles} mi
        </text>
      </g>
    </svg>
  );
}
