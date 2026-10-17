"use client";

import { addDays, type DueObligation, type NearbyResult, type OptimizeResult, type RouteDay, type Stop, type Technician } from "@aerowise/domain";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react";
import { ROUTE_COLORS, RouteMap } from "@/components/RouteMap";
import { SafetyBadges } from "@/components/SafetyBadges";
import { LoadState } from "@/components/LoadState";
import { Pagination } from "@/components/Pagination";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useQueryState } from "@/components/useQueryState";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, formValues } from "@/lib/api";
import { day, duration, plural } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

/** Monday of the week containing `date`. */
function weekStart(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

export default function SchedulePage() {
  const editable = canEdit(useSession());
  const todayProbe = useLoad<{ today: string }>("/obligations/due?limit=1");
  const today = todayProbe.data?.today;
  const [picked, setPicked] = useQueryState("date", "");
  const [obligationId] = useQueryState("obligationId", "");
  const [siteId] = useQueryState("siteId", "");
  const [offsetText, setOffset] = useQueryState("offset", "0");
  const offset = Number.isSafeInteger(Number(offsetText)) && Number(offsetText) >= 0 ? Number(offsetText) : 0;
  const target = useLoad<{ items: DueObligation[] }>(obligationId ? `/obligations/due?obligationId=${encodeURIComponent(obligationId)}` : null);
  const validPicked = /^\d{4}-\d{2}-\d{2}$/.test(picked) && !Number.isNaN(Date.parse(`${picked}T00:00:00Z`)) ? picked : "";
  const selected = validPicked || target.data?.items[0]?.job?.scheduledDate || today || null;
  const monday = selected ? weekStart(selected) : null;

  const techs = useLoad<{ items: Technician[] }>("/technicians");
  const unscheduled = useLoad<{ items: DueObligation[]; total: number }>(
    today ? `/obligations/due?unscheduledOnly=true&limit=50&offset=${offset}&through=${addDays(today, 30)}` : null,
  );
  const week = useLoad<{ items: Stop[] }>(monday ? `/schedule?from=${monday}&to=${addDays(monday, 6)}` : null);
  const routes = useLoad<RouteDay>(selected ? `/routing/day?date=${selected}` : null);
  const [assignTo, setAssignTo] = useState<string>("");
  // The stop whose unscheduling reason is being asked, on its own card.
  const [unscheduling, setUnscheduling] = useState<string | null>(null);
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
    const page = unscheduled.data?.items ?? [];
    const chosen = target.data?.items[0];
    const items = chosen && !chosen.job && !page.some((o) => o.id === chosen.id) ? [chosen, ...page] : page;
    if (sort !== "nearby" || !nearby.data) return items;
    const rank = new Map(nearby.data.items.map((n, i) => [n.obligationId, i]));
    return [...items].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  }, [unscheduled.data, nearby.data, sort, target.data]);
  const nearbyOf = useMemo(() => new Map((nearby.data?.items ?? []).map((n) => [n.obligationId, n])), [nearby.data]);

  const refresh = async () => {
    setPreviews({});
    await Promise.all([unscheduled.reload(), week.reload(), routes.reload(), nearby.reload()]);
  };
  // One change to the schedule at a time: a second click on Assign waits instead of booking twice.
  const changing = useSubmit(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        setUnscheduling(null);
      } finally {
        await refresh();
      }
    },
    { fallback: "Could not update the schedule." },
  );
  const run = (action: () => Promise<unknown>) => changing.run(action);

  const dismiss = (techId: string) => setPreviews((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== techId)));

  const planning = useSubmit(
    async (techId: string, apply: boolean) => {
      const r = await api<OptimizeResult>("/routing/optimize", { method: "POST", body: { technicianId: techId, scheduledDate: selected, apply } });
      if (apply) await refresh();
      else setPreviews((p) => ({ ...p, [techId]: r }));
    },
    { fallback: "Could not plan the route." },
  );
  const optimize = (techId: string, apply: boolean) => planning.run(techId, apply);
  const error = changing.error ?? planning.error;
  const busy = changing.busy || planning.busy;

  const assign = (o: DueObligation) =>
    run(() => api("/jobs", { method: "POST", body: { obligationId: o.id, technicianId, scheduledDate: selected } }));
  const unschedule = (s: Stop, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { reason } = formValues(event.currentTarget);
    void run(() => api(`/jobs/${s.jobId}/cancel`, { method: "POST", body: { reason } }));
  };
  /** Another technician takes the stop; an inspection already started on a phone goes with it (the API holds the first phone's later work for the office). */
  const giveTo = (s: Stop, technicianId: string) => run(() => api(`/jobs/${s.jobId}`, { method: "PATCH", body: { technicianId } }));
  const move = (s: Stop, stops: Stop[], delta: number) => {
    const ids = stops.map((x) => x.jobId);
    const i = ids.indexOf(s.jobId);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void run(() => api("/schedule/reorder", { method: "POST", body: { technicianId: s.technicianId, scheduledDate: s.scheduledDate, jobIds: ids } }));
  };

  useEffect(() => {
    if (!obligationId || !target.data) return;
    window.requestAnimationFrame(() => document.getElementById(`obligation-${obligationId}`)?.scrollIntoView({ block: "center" }));
  }, [obligationId, target.data]);

  // Wait for the first answer of each list, so the unscheduled list arriving last doesn't push
  // the day's routes down under a thumb (a 0.3 layout shift on a phone, W11.3).
  const settled = [techs, unscheduled, week, routes].every((l) => l.data || l.error);
  if (!selected || !monday) return <LoadState load={todayProbe} label="company date" />;
  if (!settled) return <p className="muted" role="status">Loading schedule sections…</p>;

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
            <span className="muted small">{plural(countFor(d), "stop")}</span>
          </button>
        ))}
      </div>
      <FormError error={error} />
      <LoadState load={target} label="selected visit" />
      {obligationId && target.data?.items.length === 0 && <p className="card">This visit is no longer open. {siteId && <Link href={`/sites/${encodeURIComponent(siteId)}`}>Open its site to review the current record.</Link>}</p>}
      {target.data?.items[0]?.job && <p className="card">Selected visit at <Link href={`/sites/${target.data.items[0].site.id}`}>{target.data.items[0].site.addressLine1}</Link> is assigned to {target.data.items[0].job.technicianName} on {day(target.data.items[0].job.scheduledDate)}. Opening this link has not changed it.</p>}
      <LoadState load={week} label="week's stops" />
      <LoadState load={techs} label="technicians" />
      <LoadState load={routes} label="route estimates" />

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
          <LoadState load={unscheduled} label="unscheduled visits" />
          <LoadState load={nearby} label="nearby visits" />
          {unscheduled.data?.items.length === 0 && <p className="muted">Everything due is scheduled.</p>}
          {unscheduledItems.map((o) => (
            <div key={o.id} id={`obligation-${o.id}`} tabIndex={o.id === obligationId ? -1 : undefined} className={`card tight ${o.id === obligationId ? "selected-obligation" : ""} ${o.overdue ? "overdue-card" : ""}`}>
              <div className="row">
                <Link href={`/sites/${o.site.id}`}>
                  <strong>{o.site.addressLine1}</strong>, {o.site.city}
                </Link>
                <span className="spacer" />
                {editable && (
                  <SubmitButton type="button" className="secondary" busy={changing.busy} busyLabel="Assigning…" onClick={() => void assign(o)} disabled={!technicianId}>
                    Assign {day(selected, { month: "short", day: "numeric" })}
                  </SubmitButton>
                )}
              </div>
              <div className="muted small">
                {o.customer.displayName} · visit #{o.sequence} · due {day(o.dueOn, { month: "short", day: "numeric" })}
                {o.overdue && <Badge tone="danger">Overdue</Badge>}
              </div>
              {sort === "nearby" && nearby.data && (
                <div className="small">
                  {nearbyOf.get(o.id) ? (
                    <>
                      <Badge>
                        +{nearbyOf.get(o.id)!.detourMiles} mi · +{duration(nearbyOf.get(o.id)!.detourMinutes)}
                      </Badge>{" "}
                      {!nearbyOf.get(o.id)!.fits && <Badge tone="warning">Day would run long</Badge>}
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
          {unscheduled.data && <Pagination total={unscheduled.data.total} offset={offset} onChange={(n) => setOffset(String(n))} />}
        </section>

        <section className="stack">
          {routes.data && dayStops.length > 0 && (
            <RouteMap day={routes.data} technicianIds={techs.data?.items.map((t) => t.id) ?? []} numbers={numbers} stops={dayStops} />
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
                      {plural(stops.length, "stop")} · {day(selected, { weekday: "short", month: "short", day: "numeric" })}
                    </span>
                  </div>
                  {r && stops.length > 0 && (
                    <div className="route-summary small">
                      <span title="Estimated from straight-line distances and an average road factor; no traffic">
                        Est. {r.driveMiles} mi · {duration(r.driveMinutes)} driving
                      </span>
                      <span className="muted">{duration(r.totalMinutes)} with stops</span>
                      {r.overCapacity && <Badge tone="danger">Longer than a working day</Badge>}
                      {r.unlocatedJobIds.length > 0 && <Badge tone="warning">{r.unlocatedJobIds.length} not on the map</Badge>}
                    </div>
                  )}
                  {editable && stops.length > 1 && !preview && (
                    <SubmitButton type="button" className="secondary" busy={planning.busy} busyLabel="Planning…" onClick={() => void optimize(t.id, false)}>
                      Optimize route
                    </SubmitButton>
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
                            <SubmitButton type="button" busy={planning.busy} onClick={() => void optimize(t.id, true)}>
                              Use this order
                            </SubmitButton>
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
                          ↓ est. {legTo.get(s.jobId)!.miles} mi · {duration(legTo.get(s.jobId)!.minutes)}
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
                              <button className="link" aria-label="Move up" onClick={() => move(s, stops, -1)} disabled={i === 0 || busy}>
                                ↑
                              </button>
                              <button className="link" aria-label="Move down" onClick={() => move(s, stops, 1)} disabled={i === stops.length - 1 || busy}>
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
                        {editable && (s.status === "scheduled" || (s.status === "in_progress" && !s.workOrder)) && (techs.data?.items.length ?? 0) > 1 && (
                          <label className="small">
                            Technician{" "}
                            <select aria-label={`Technician for ${s.site.addressLine1}`} value={s.technicianId} disabled={busy} onChange={(e) => void giveTo(s, e.target.value)}>
                              {techs.data!.items.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                            {s.status === "in_progress" && <span className="muted"> · started on a phone; it continues on the new technician&apos;s</span>}
                          </label>
                        )}
                        {editable && unscheduling !== s.jobId && (
                          <button className="link small danger" onClick={() => (changing.clear(), setUnscheduling(s.jobId))}>
                            Unschedule
                          </button>
                        )}
                        {editable && unscheduling === s.jobId && (
                          <form className="stack" onSubmit={(e) => unschedule(s, e)}>
                            <label>
                              Why is this visit being unscheduled?
                              <input name="reason" required maxLength={2000} defaultValue="Rescheduling" autoFocus />
                            </label>
                            <div className="row">
                              <SubmitButton className="danger" busy={changing.busy}>
                                Unschedule
                              </SubmitButton>
                              <button type="button" className="link" onClick={() => setUnscheduling(null)}>
                                Keep it
                              </button>
                            </div>
                          </form>
                        )}
                      </div>
                    </Fragment>
                  ))}
                  {legTo.get("end") && (
                    <div className="leg muted small">
                      ↩ est. {legTo.get("end")!.miles} mi · {duration(legTo.get("end")!.minutes)} back to the start
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
