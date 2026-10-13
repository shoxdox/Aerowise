import { CONFLICT_REASON_LABELS, type WorkStop } from "@aerowise/domain";
import { day } from "@/lib/format";
import type { LocalWork } from "@/lib/offline/work";

// Work visits on the technician's day (SW-2), listed under the inspection route.

/** Where a work visit stands, from what the phone and the server last knew. */
export function workStatus(serverRecord: WorkStop["record"], rec: LocalWork | undefined, failed: boolean): { label: string; tone: "" | "ok" | "warn" | "danger" } {
  if (rec?.resolved) return rec.resolved.resolution === "attached" ? { label: "Accepted by the office", tone: "ok" } : { label: "Set aside by the office", tone: "" };
  if (rec?.held) return { label: "Held for the office", tone: "warn" };
  if (failed) return { label: "Needs attention", tone: "danger" };
  if (rec?.status === "completed") return rec.server?.status === "completed" ? { label: "Done", tone: "ok" } : { label: "Done · not sent yet", tone: "warn" };
  if (!rec && serverRecord?.status === "completed") return { label: "Done", tone: "ok" };
  if (rec || serverRecord) return { label: "In progress", tone: "warn" };
  return { label: "To do", tone: "" };
}

/** Why the office is deciding about a held record, for the technician. */
export const heldText = (rec: LocalWork) =>
  rec.held ? `${CONFLICT_REASON_LABELS[rec.held.reason]} while this phone was offline. Your record reached the office, and the office will decide what to do with it.` : "";

/** What became of a record whose visit is no longer on the technician's route (moved, cancelled, another day). */
function offRouteStatus(rec: LocalWork, failed: boolean): { label: string; tone: "" | "ok" | "warn" | "danger" } {
  if (rec.resolved || rec.held || failed) return workStatus(null, rec, failed);
  if (rec.status === "completed") return rec.server?.status === "completed" ? { label: "Sent to the office", tone: "ok" } : { label: "Done · not sent yet", tone: "warn" };
  return { label: "Not finished", tone: "warn" };
}

export function WorkStopList({
  stops,
  records,
  failedRecords,
  onOpen,
  numbers,
  routeDate,
}: {
  stops: WorkStop[];
  records: Map<string, LocalWork>;
  failedRecords: Set<string>;
  onOpen: (jobId: string) => void;
  /** Each visit's number in the whole day, as on the map; "W" when it is not on today's route. */
  numbers?: Map<string, number>;
  routeDate?: string;
}) {
  const listed = new Set(stops.map((s) => s.jobId));
  const offRoute = [...records.values()].filter((r) => !listed.has(r.jobId));
  if (stops.length === 0 && offRoute.length === 0) return null;
  return (
    <section className="stack" data-testid="work-stops">
      <h2>Work visits</h2>
      {routeDate && stops.some(s => s.scheduledDate !== routeDate) && <p className="card warn" role="status">Some downloaded work visits have a different date from the route above. Check each visit’s date and refresh with signal before traveling.</p>}
      <ol className="stops">
        {stops.map((s) => {
          const rec = records.get(s.jobId);
          const status = workStatus(s.record, rec, !!rec && failedRecords.has(rec.clientId));
          return (
            <li key={s.jobId}>
              <button className="work-card" onClick={() => onOpen(s.jobId)}>
                <span className="stop-num">{numbers?.get(s.jobId) ?? "W"}</span>
                <span className="stop-body">
                  <strong>
                    {s.workOrderLabel} · {s.title}
                  </strong>
                  <span className="muted">
                    {s.customerName} · {s.address}
                  </span>
                  <span className="muted small">
                    {s.workTypeName} · visit {s.visitNumber} · {day(s.scheduledDate)}
                  </span>
                </span>
                <span className={`badge ${status.tone}`} data-testid="work-stop-status">
                  {status.label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {offRoute.length > 0 && (
        <div className="stack" data-testid="off-route-work">
          <p className="muted small">Work recorded on this phone for visits no longer on your route today:</p>
          <ul className="stack plain">
            {offRoute.map((r) => {
              const status = offRouteStatus(r, failedRecords.has(r.clientId));
              return (
                <li key={r.clientId} className="card tight">
                  <strong>{r.label?.title ?? "Work visit"}</strong>
                  {r.label && <span className="muted small"> · {r.label.customerName}</span>}{" "}
                  <span className={`badge ${status.tone}`}>{status.label}</span>
                  {r.held && <div className="muted small">{heldText(r)}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
