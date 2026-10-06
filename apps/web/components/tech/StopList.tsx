import type { Stop } from "@aerowise/domain";
import { SafetyBadges } from "@/components/SafetyBadges";
import type { LocalInspection } from "@/lib/offline/db";
import { clock, day } from "@/lib/format";

export function stopStatus(stop: Stop, insp: LocalInspection | undefined): { label: string; tone: "" | "ok" | "warn" } {
  if (insp?.status === "completed") return insp.server?.status === "completed" ? { label: "Done", tone: "ok" } : { label: "Done · not sent yet", tone: "warn" };
  if (stop.status === "completed") return { label: "Done", tone: "ok" };
  if (insp) return { label: "In progress", tone: "warn" };
  return { label: "To do", tone: "" };
}

export function StopList({
  route,
  fetchedAt,
  inspections,
  onOpen,
  onRefresh,
}: {
  route: { date: string; items: Stop[] } | null;
  fetchedAt: string | undefined;
  inspections: Map<string, LocalInspection>;
  onOpen: (jobId: string) => void;
  onRefresh: () => void;
}) {
  if (!route) {
    return (
      <div className="card stack">
        <p>Your route has not been downloaded to this phone yet. Open the app once with signal to save it.</p>
        <button onClick={onRefresh}>Try again</button>
      </div>
    );
  }
  const done = route.items.filter((s) => stopStatus(s, inspections.get(s.jobId)).label.startsWith("Done")).length;
  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1>{day(route.date)}</h1>
          <p className="muted small">
            {done} of {route.items.length} stops done
            {fetchedAt && ` · route updated ${clock(fetchedAt)}`}
          </p>
        </div>
        <span className="spacer" />
        <button className="secondary" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {route.items.length === 0 && <p className="muted">No stops on your route today.</p>}
      <ol className="stops">
        {route.items.map((s, i) => {
          const status = stopStatus(s, inspections.get(s.jobId));
          return (
            <li key={s.jobId}>
              <button className="stop-card" onClick={() => onOpen(s.jobId)}>
                <span className="stop-num">{i + 1}</span>
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
    </div>
  );
}
