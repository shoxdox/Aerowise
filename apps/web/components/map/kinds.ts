import { WORK_CATEGORIES, WORK_CATEGORY_LABELS, type Stop, type WorkCategory } from "@aerowise/domain";

// What a stop on the street map is: an inspection, or work of one of the six kinds. Each has a
// letter on its marker and a name in the map key; the number, the route color and the done
// state stay as they are.

export type MapStopKind = "inspection" | WorkCategory;

export const MAP_STOP_KINDS: readonly MapStopKind[] = ["inspection", ...WORK_CATEGORIES];

export const MAP_KIND_LABEL: Record<MapStopKind, string> = { inspection: "Inspection", ...WORK_CATEGORY_LABELS };

/** The letter on the marker's corner. Inspections, the usual stop, carry none: a round marker is an inspection. */
export const MAP_KIND_LETTER: Record<MapStopKind, string> = {
  inspection: "",
  pumping: "P",
  repair: "R",
  installation: "N",
  maintenance: "M",
  inspection_other: "C",
  other: "O",
};

/** A stop's kind from the schedule: work without a known kind shows as other. */
export function stopKind(s: Pick<Stop, "kind" | "workOrder">): MapStopKind {
  if (s.kind !== "work") return "inspection";
  return s.workOrder?.category ?? "other";
}
