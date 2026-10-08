import type { Stop, WorkStop } from "@aerowise/domain";

// The phone keeps inspections (from /route) and work visits (from /work/route) apart: phones on
// the SW-2a floor read every /route stop as an inspection. The office orders both in one route,
// so the phone puts them back together by route position, and the list and the map number every
// stop from that one order.

export interface RouteEntry {
  jobId: string;
  kind: "inspection" | "work";
}

/** The day's stops in visit order. Work saved for another day than the route's is left out. */
export function routeOrder(route: { date: string; items: Stop[] } | null, work: WorkStop[]): RouteEntry[] {
  const day = route?.date ?? work[0]?.scheduledDate;
  const entries = [
    ...(route?.items ?? []).map((s, i) => ({ jobId: s.jobId, kind: "inspection" as const, position: s.routePosition, i })),
    ...work.filter((w) => w.scheduledDate === day).map((w, i) => ({ jobId: w.jobId, kind: "work" as const, position: w.routePosition, i })),
  ];
  // Equal positions (an older saved route, say) keep each list's own order, inspections first.
  entries.sort((a, b) => a.position - b.position || (a.kind === b.kind ? a.i - b.i : a.kind === "inspection" ? -1 : 1));
  return entries.map(({ jobId, kind }) => ({ jobId, kind }));
}

/** Each stop's number in the day, by job id. */
export const routeNumbers = (order: RouteEntry[]) => new Map(order.map((e, i) => [e.jobId, i + 1]));
