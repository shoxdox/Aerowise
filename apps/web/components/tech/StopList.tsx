import type { Stop, WorkStop } from "@aerowise/domain";
import { useState } from "react";
import { SafetyBadges } from "@/components/SafetyBadges";
import { TechRouteMap } from "@/components/tech/TechRouteMap";
import type { LocalInspection } from "@/lib/offline/db";
import { day, today, when } from "@/lib/format";
import { plural } from "./plural";

export function stopStatus(stop: Stop, insp: LocalInspection | undefined): { label: string; tone: "" | "ok" | "warn" } {
  if (insp?.held) return insp.held.status === "attached" ? { label: "Done", tone: "ok" } : { label: "Held for the office", tone: "warn" };
  if (insp?.status === "completed") return insp.server?.status === "completed" ? { label: "Done", tone: "ok" } : { label: "Done · not sent yet", tone: "warn" };
  if (stop.status === "completed") return { label: "Done", tone: "ok" };
  if (insp) return { label: "In progress", tone: "warn" };
  if (stop.inspection?.status === "draft") return { label: "In progress · on another phone", tone: "warn" };
  return { label: "To do", tone: "" };
}

export type RouteView = "list" | "map";

export function StopList({
  route,
  fetchedAt,
  inspections,
  onOpen,
  onRefresh,
  view = "list",
  onView,
  work,
  numbers,
}: {
  route: { date: string; items: Stop[] } | null;
  fetchedAt: string | undefined;
  inspections: Map<string, LocalInspection>;
  onOpen: (jobId: string) => void;
  onRefresh: () => void;
  view?: RouteView;
  onView?: (view: RouteView) => void;
  /** The day's work visits, shown with the inspections on the map (the list of them is below). */
  work?: { stops: WorkStop[]; done: (jobId: string) => boolean };
  /** Each stop's number in the whole day, inspections and work together. */
  numbers?: Map<string, number>;
}) {
  // The map could not be shown (no signal, no map installed): the list shows under the note.
  const [mapFailed, setMapFailed] = useState(false);
  if (!route) {
    return (
      <div className="card stack">
        <p>Your route has not been downloaded to this phone yet. Open the app once with signal to save it.</p>
        <button onClick={onRefresh}>Try again</button>
      </div>
    );
  }
  const done = route.items.filter((s) => stopStatus(s, inspections.get(s.jobId)).label.startsWith("Done")).length;
  const sameDayWork = work?.stops.filter(s => s.scheduledDate === route.date) ?? [];
  const workDone = sameDayWork.filter(s => work?.done(s.jobId)).length;
  const total = route.items.length + sameDayWork.length;
  const mappable = route.items.length + (work?.stops.filter((s) => numbers?.has(s.jobId)).length ?? 0);
  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1>{day(route.date)}</h1>
          <p className="muted small">
            {done + workDone} of {plural(total, "stop")} done · {plural(route.items.length, "inspection")}
            {sameDayWork.length > 0 && `, ${plural(sameDayWork.length, "work visit")}`}
            {fetchedAt && ` · route last downloaded ${when(fetchedAt)}`}
          </p>
        </div>
        <span className="spacer" />
        <button className="secondary" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {route.date !== today() && <p className="card warn" role="status">This is the cached route for {day(route.date)}. Refresh with signal to download today’s work.</p>}
      {route.items.length === 0 && <p className="muted">{mappable > 0 ? "No inspections on your route today." : "No stops on your route today."}</p>}
      {mappable > 0 && onView && (
        <div className="view-toggle" role="group" aria-label="Show the route as">
          <button type="button" aria-pressed={view === "list"} onClick={() => onView("list")}>
            List
          </button>
          <button type="button" aria-pressed={view === "map"} onClick={() => onView("map")}>
            Map
          </button>
        </div>
      )}
      {view === "map" && mappable > 0 && (
        <TechRouteMap route={route} inspections={inspections} work={work} numbers={numbers} onOpen={onOpen} onUnavailable={() => setMapFailed(true)} />
      )}
      {(view === "list" || mapFailed) && (
        <ol className="stops">
          {route.items.map((s, i) => {
            const status = stopStatus(s, inspections.get(s.jobId));
            return (
              <li key={s.jobId}>
                <button className="stop-card" onClick={() => onOpen(s.jobId)}>
                  <span className="stop-num">{numbers?.get(s.jobId) ?? i + 1}</span>
                  <span className="stop-body">
                    <strong>{s.customer.displayName}</strong>
                    <span className="muted">
                      {s.site.addressLine1}, {s.site.city}
                    </span>
                    <SafetyBadges flags={s.site.safetyFlags} />
                  </span>
                  <span className={`badge ${status.tone}`}>{status.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
