"use client";

import type { Stop, WorkStop } from "@aerowise/domain";
import { useMemo } from "react";
import { StreetMap, type StreetMapStop } from "@/components/map/StreetMap";
import type { LocalInspection } from "@/lib/offline/db";
import { plural } from "./plural";
import { stopStatus } from "./StopList";

/**
 * The technician's own route on the street map, inspections and work visits together in visit
 * order, numbered as in the list. Tapping a stop opens it, as in the list. Uses only the route
 * already on the phone; the map itself needs signal (or a recent visit).
 */
export function TechRouteMap({
  route,
  inspections,
  work = { stops: [], done: () => false },
  numbers,
  onOpen,
  onUnavailable,
}: {
  route: { date: string; items: Stop[] };
  inspections: Map<string, LocalInspection>;
  /** The day's work visits, and whether each is done on this phone. */
  work?: { stops: WorkStop[]; done: (jobId: string) => boolean };
  /** Each stop's number in the day, by job id; the inspection order when there is no work. */
  numbers?: Map<string, number>;
  onOpen: (jobId: string) => void;
  onUnavailable: () => void;
}) {
  const routes = useMemo(() => {
    const stops: StreetMapStop[] = [
      ...route.items.map((s, i) => ({
        key: s.jobId,
        lat: s.site.lat,
        lng: s.site.lng,
        number: numbers?.get(s.jobId) ?? i + 1,
        done: stopStatus(s, inspections.get(s.jobId)).label.startsWith("Done"),
        title: `${s.customer.displayName}, ${s.site.addressLine1}, ${s.site.city}`,
        kind: "inspection" as const,
      })),
      ...work.stops
        .filter((s) => numbers?.has(s.jobId))
        .map((s) => ({
          key: s.jobId,
          lat: s.lat,
          lng: s.lng,
          number: numbers!.get(s.jobId)!,
          done: work.done(s.jobId),
          title: `${s.workTypeName}, ${s.customerName}, ${s.address}`,
          kind: s.category ?? ("other" as const),
        })),
    ];
    // The dashed lines join stops in the order given: the visit order.
    stops.sort((a, b) => a.number - b.number);
    return [{ id: "mine", color: "#1f6f5c", stops }];
  }, [route, inspections, work, numbers]);
  const count = routes[0]!.stops.length;
  return <StreetMap routes={routes} onSelect={onOpen} fitKey={route.date} label={`Map of your ${plural(count, "stop")}`} onUnavailable={onUnavailable} />;
}
