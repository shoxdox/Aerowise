"use client";

import type { DueObligation, NearbyResult, OptimizeResult, RouteDay, Stop, Technician } from "@aerowise/domain";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { ROUTE_COLORS, RouteMap } from "@/components/RouteMap";
import { SafetyBadges } from "@/components/SafetyBadges";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";
import { day, duration } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `date`. */
function weekStart(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

export default function SchedulePage() {
  const editable = canEdit(useSession());
  const todayProbe = useLoad<{ today: string }>("/obligations/due?limit=1");
  const today = todayProbe.data?.today;
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? today ?? null;
  const monday = selected ? weekStart(selected) : null;

  const techs = useLoad<{ items: Technician[] }>("/technicians");
  const unscheduled = useLoad<{ items: DueObligation[]; total: number }>(
    today ? `/obligations/due?unscheduledOnly=true&limit=500&through=${addDays(today, 30)}` : null,
  );
  const week = useLoad<{ items: Stop[] }>(monday ? `/schedule?from=${monday}&to=${addDays(monday, 6)}` : null);
  const routes = useLoad<RouteDay>(selected ? `/routing/day?date=${selected}` : null);
  const [assignTo, setAssignTo] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<"due" | "nearby">("due");
  const [previews, setPreviews] = useState<Record<string, OptimizeResult>>({});
  // Which kinds of visit the day's columns list; the route and numbering always cover every stop.
  const [show, setShow] = useState<"all" | "inspection" | "work">("all");
  const hasWork = useMemo(() => (week.data?.items ?? []).some((s) => s.kind === "work"), [week.data]);

  const technicianId = assignTo || techs.data?.items[0]?.id || "";
  const nearby = useLoad<NearbyResult>(sort === "nearby" && technicianId && selected ? `/routing/nearby?technicianId=${technicianId}&date=${selected}` : null);
  const dayStops = useMemo(() => (week.data?.items ?? []).filter((s) => s.scheduledDate === selected), [week.data, selected]);
  const routeOf = useMemo(() => new Map((routes.data?.technicians ?? []).map((r) => [r.technicianId, r])), [routes.data]);
  const numbers = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of techs.data?.items ?? []) dayStops.filter((s) => s.technicianId === t.id).forEach((s, i) => m.set(s.jobId, i + 1));
    return m;
  }, [dayStops, techs.data]);
  const unscheduledItems = useMemo(() => {
    const items = unscheduled.data?.items ?? [];
    if (sort !== "nearby" || !nearby.data) return items;
    const rank = new Map(nearby.data.items.map((n, i) => [n.obligationId, i]));
    return [...items].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  }, [unscheduled.data, nearby.data, sort]);
  const nearbyOf = useMemo(() => new Map((nearby.data?.items ?? []).map((n) => [n.obligationId, n])), [nearby.data]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the schedule");
    }
    setPreviews({});
    await Promise.all([unscheduled.reload(), week.reload(), routes.reload(), nearby.reload()]);
  }

  const dismiss = (techId: string) => setPreviews((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== techId)));

  async function optimize(techId: string, apply: boolean) {
    setError(null);
    try {
      const r = await api<OptimizeResult>("/routing/optimize", { method: "POST", body: { technicianId: techId, scheduledDate: selected, apply } });
      if (apply) await run(async () => {});
      else setPreviews((p) => ({ ...p, [techId]: r }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not plan the route");
    }
  }

  const assign = (o: DueObligation) =>
    run(() => api("/jobs", { method: "POST", body: { obligationId: o.id, technicianId, scheduledDate: selected } }));
  const unschedule = (s: Stop) => {
    const reason = window.prompt("Why is this visit being unscheduled?", "Rescheduling");
    if (reason) void run(() => api(`/jobs/${s.jobId}/cancel`, { method: "POST", body: { reason } }));
  };
  const move = (s: Stop, stops: Stop[], delta: number) => {
    const ids = stops.map((x) => x.jobId);
    const i = ids.indexOf(s.jobId);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void run(() => api("/schedule/reorder", { method: "POST", body: { technicianId: s.technicianId, scheduledDate: s.scheduledDate, jobIds: ids } }));
  };

  // Wait for the first answer of each list, so the unscheduled list arriving last doesn't push
  // the day's routes down under a thumb (a 0.3 layout shift on a phone, W11.3).
  const settled = [techs, unscheduled, week, routes].every((l) => l.data || l.error);
  if (!selected || !monday || !settled) return <p className="muted">Loading…</p>;

  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const countFor = (d: string) => (week.data?.items ?? []).filter((s) => s.scheduledDate === d).length;

  return (
    <div className="stack">
      <div className="row">
        <h1>Schedule</h1>
        <span className="spacer" />
        <button className="secondary" onClick={() => setPicked(addDays(selected, -7))}>
          ← Week
        </button>
        <input type="date" aria-label="Day" value={selected} onChange={(e) => e.target.value && setPicked(e.target.value)} />
        <button className="secondary" onClick={() => setPicked(addDays(selected, 7))}>
          Week →
        </button>
      </div>

      <div className="week">
        {days.map((d) => (
          <button key={d} className={`weekday ${d === selected ? "selected" : ""} ${d === today ? "today" : ""}`} onClick={() => setPicked(d)}>
            <span>{day(d, { weekday: "short" })}</span>
            <strong>{day(d, { month: "short", day: "numeric" })}</strong>
            <span className="muted small">{countFor(d)} stops</span>
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}

      <div className="schedule">
        <section className="stack">
          <div className="row">
            <h2>Unscheduled</h2>
            <span className="muted small">{unscheduled.data ? `${unscheduled.data.total} due in 30 days` : ""}</span>
          </div>
          {editable && (
            <label>
              Assign to
              <select value={technicianId} onChange={(e) => setAssignTo(e.target.value)}>
                {techs.data?.items.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as "due" | "nearby")}>
              <option value="due">By due date</option>
              <option value="nearby">Nearest to {techs.data?.items.find((t) => t.id === technicianId)?.name ?? "the"}&apos;s route</option>
            </select>
          </label>
          {unscheduled.data?.items.length === 0 && <p className="muted">Everything due is scheduled.</p>}
          {unscheduledItems.map((o) => (
            <div key={o.id} className={`card tight ${o.overdue ? "overdue-card" : ""}`}>
              <div className="row">
                <Link href={`/sites/${o.site.id}`}>
                  <strong>{o.site.addressLine1}</strong>, {o.site.city}
                </Link>
                <span className="spacer" />
                {editable && (
                  <button className="secondary" onClick={() => assign(o)} disabled={!technicianId}>
                    Assign {day(selected, { month: "short", day: "numeric" })}
                  </button>
                )}
              </div>
              <div className="muted small">
                {o.customer.displayName} · visit #{o.sequence} · due {day(o.dueOn, { month: "short", day: "numeric" })}
                {o.overdue && <span className="badge danger">overdue</span>}
              </div>
              {sort === "nearby" && nearby.data && (
                <div className="small">
                  {nearbyOf.get(o.id) ? (
                    <>
                      <span className="badge">
                        +{nearbyOf.get(o.id)!.detourMiles} mi · +{duration(nearbyOf.get(o.id)!.detourMinutes)}
                      </span>
                      {!nearbyOf.get(o.id)!.fits && <span className="badge warn">day would run long</span>}
                    </>
                  ) : (
                    <span className="muted">Not on the map</span>
                  )}
                </div>
              )}
              <SafetyBadges flags={o.site.safetyFlags} />
              {o.site.schedulingNotes && <div className="small restriction">⚠ {o.site.schedulingNotes}</div>}
            </div>
          ))}
        </section>

        <section className="stack">
          {routes.data && dayStops.length > 0 && (
            <RouteMap day={routes.data} technicianIds={techs.data?.items.map((t) => t.id) ?? []} numbers={numbers} />
          )}
          <div className="row small">
            {routes.data && !routes.data.start && <span className="muted">Routes start at their first stop.</span>}
            <span className="spacer" />
            {hasWork && (
              <label className="row">
                Show
                <select value={show} onChange={(e) => setShow(e.target.value as typeof show)} aria-label="Kinds of visit shown">
                  <option value="all">All visits</option>
                  <option value="inspection">Inspections</option>
                  <option value="work">Work orders</option>
                </select>
              </label>
            )}
            <Link href="/settings/routing">Route settings</Link>
          </div>
          <div className="columns">
            {techs.data?.items.map((t, ti) => {
              const stops = dayStops.filter((s) => s.technicianId === t.id);
              const r = routeOf.get(t.id);
              const legTo = new Map((r?.legs ?? []).map((l) => [l.toJobId ?? "end", l]));
              const preview = previews[t.id];
              return (
                <div key={t.id} className="stack column">
                  <div className="row">
                    <h2>
                      <span className="route-legend" style={{ background: ROUTE_COLORS[ti % ROUTE_COLORS.length] }} />
                      {t.name}
                    </h2>
                    <span className="muted small">
                      {stops.length} stop{stops.length === 1 ? "" : "s"} · {day(selected, { weekday: "short", month: "short", day: "numeric" })}
                    </span>
                  </div>
                  {r && stops.length > 0 && (
                    <div className="route-summary small">
                      <span>
                        {r.driveMiles} mi · {duration(r.driveMinutes)} driving
                      </span>
                      <span className="muted">{duration(r.totalMinutes)} with stops</span>
                      {r.overCapacity && <span className="badge danger">longer than a working day</span>}
                      {r.unlocatedJobIds.length > 0 && (
                        <span className="badge warn">
                          {r.unlocatedJobIds.length} not on the map
                        </span>
                      )}
                    </div>
                  )}
                  {editable && stops.length > 1 && !preview && (
                    <button className="secondary" onClick={() => void optimize(t.id, false)}>
                      Optimize route
                    </button>
                  )}
                  {preview && (
                    <div className="card tight optimize stack">
                      {preview.changed ? (
                        <>
                          <div>
                            A shorter order saves <strong>{Math.round((preview.before.driveMiles - preview.after.driveMiles) * 10) / 10} mi</strong> and{" "}
                            <strong>{duration(preview.before.driveMinutes - preview.after.driveMinutes)}</strong> of driving ({preview.before.driveMiles} → {preview.after.driveMiles} mi).
                          </div>
                          <div className="muted small">New order: {preview.proposedJobIds.map((id) => numbers.get(id)).join(", ")}</div>
                          <div className="row">
                            <button onClick={() => void optimize(t.id, true)}>Use this order</button>
                            <button className="secondary" onClick={() => dismiss(t.id)}>
                              Keep current
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="row">
                          <span>This is already the shortest order found.</span>
                          <button className="link" onClick={() => dismiss(t.id)}>
                            OK
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  {stops.length === 0 && <p className="muted small">No stops.</p>}
                  {stops.map((s, i) => (show !== "all" && (s.kind ?? "inspection") !== show ? null :
                    <Fragment key={s.jobId}>
                      {show === "all" && legTo.get(s.jobId) && (
                        <div className="leg muted small">
                          ↓ {legTo.get(s.jobId)!.miles} mi · {duration(legTo.get(s.jobId)!.minutes)}
                          {legTo.get(s.jobId)!.fromJobId === null ? " from the start" : ""}
                        </div>
                      )}
                      <div className="card tight">
                        <div className="row">
                          <span className="stop-number">{i + 1}</span>
                          <Link href={`/sites/${s.site.id}`}>
                            <strong>{s.site.addressLine1}</strong>, {s.site.city}
                          </Link>
                          <span className="spacer" />
                          {editable && (
                            <>
                              <button className="link" aria-label="Move up" onClick={() => move(s, stops, -1)} disabled={i === 0}>
                                ↑
                              </button>
                              <button className="link" aria-label="Move down" onClick={() => move(s, stops, 1)} disabled={i === stops.length - 1}>
                                ↓
                              </button>
                            </>
                          )}
                        </div>
                        <div className="muted small">
                          {s.workOrder ? (
                            <Link href={`/work/${s.workOrder.id}`} className="badge work" data-testid="stop-kind">
                              {s.workOrder.workTypeName} · {s.workOrder.label}
                            </Link>
                          ) : (
                            <span className="badge" data-testid="stop-kind">
                              Inspection
                            </span>
                          )}{" "}
                          {s.customer.displayName}
                          {s.obligation && <> · visit #{s.obligation.sequence} · due {day(s.obligation.dueOn, { month: "short", day: "numeric" })}</>}
                          {s.workOrder && <> · {s.workOrder.title}{s.workOrder.visitNumber > 1 ? ` · visit ${s.workOrder.visitNumber}` : ""}</>}
                        </div>
                        <SafetyBadges flags={s.site.safetyFlags} />
                        {s.site.schedulingNotes && <div className="small restriction">⚠ {s.site.schedulingNotes}</div>}
                        {s.site.lat === null && <div className="small muted">Not on the map yet</div>}
                        {editable && (
                          <button className="link small" onClick={() => unschedule(s)}>
                            Unschedule
                          </button>
                        )}
                      </div>
                    </Fragment>
                  ))}
                  {legTo.get("end") && (
                    <div className="leg muted small">
                      ↩ {legTo.get("end")!.miles} mi · {duration(legTo.get("end")!.minutes)} back to the start
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
