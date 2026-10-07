"use client";

import type { Stop } from "@aerowise/domain";
import { useMemo } from "react";
import { StreetMap } from "@/components/map/StreetMap";
import type { LocalInspection } from "@/lib/offline/db";
import { stopStatus } from "./StopList";

/**
 * The technician's own route on the street map. Tapping a stop opens it, as in the list.
 * Uses only the route already on the phone; the map itself needs signal (or a recent visit).
 */
export function TechRouteMap({
  route,
  inspections,
  onOpen,
  onUnavailable,
}: {
  route: { date: string; items: Stop[] };
  inspections: Map<string, LocalInspection>;
  onOpen: (jobId: string) => void;
  onUnavailable: () => void;
}) {
  const routes = useMemo(
    () => [
      {
        id: "mine",
        color: "#1f6f5c",
        stops: route.items.map((s, i) => ({
          key: s.jobId,
          lat: s.site.lat,
          lng: s.site.lng,
          number: i + 1,
          done: stopStatus(s, inspections.get(s.jobId)).label.startsWith("Done"),
          title: `${s.customer.displayName}, ${s.site.addressLine1}, ${s.site.city}`,
        })),
      },
    ],
    [route, inspections],
  );
  return <StreetMap routes={routes} onSelect={onOpen} fitKey={route.date} label={`Map of your ${route.items.length} stops`} onUnavailable={onUnavailable} />;
}
