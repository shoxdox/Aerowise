"use client";

import type { DueObligation, Stop, Technician } from "@aerowise/domain";
import Link from "next/link";
import { useMemo, useState } from "react";
import { SafetyBadges } from "@/components/SafetyBadges";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";
import { day } from "@/lib/format";
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
  const [assignTo, setAssignTo] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const technicianId = assignTo || techs.data?.items[0]?.id || "";
  const dayStops = useMemo(() => (week.data?.items ?? []).filter((s) => s.scheduledDate === selected), [week.data, selected]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the schedule");
    }
    await Promise.all([unscheduled.reload(), week.reload()]);
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

  if (!selected || !monday) return <p className="muted">Loading…</p>;

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
        <input type="date" value={selected} onChange={(e) => e.target.value && setPicked(e.target.value)} />
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
          {unscheduled.data?.items.length === 0 && <p className="muted">Everything due is scheduled.</p>}
          {unscheduled.data?.items.map((o) => (
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
              <SafetyBadges flags={o.site.safetyFlags} />
              {o.site.schedulingNotes && <div className="small restriction">⚠ {o.site.schedulingNotes}</div>}
            </div>
          ))}
        </section>

        <section className="columns">
          {techs.data?.items.map((t) => {
            const stops = dayStops.filter((s) => s.technicianId === t.id);
            return (
              <div key={t.id} className="stack column">
                <div className="row">
                  <h2>{t.name}</h2>
                  <span className="muted small">
                    {stops.length} stop{stops.length === 1 ? "" : "s"} · {day(selected, { weekday: "short", month: "short", day: "numeric" })}
                  </span>
                </div>
                {stops.length === 0 && <p className="muted small">No stops.</p>}
                {stops.map((s, i) => (
                  <div key={s.jobId} className="card tight">
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
                      {s.customer.displayName}
                      {s.obligation && <> · visit #{s.obligation.sequence} · due {day(s.obligation.dueOn, { month: "short", day: "numeric" })}</>}
                    </div>
                    <SafetyBadges flags={s.site.safetyFlags} />
                    {s.site.schedulingNotes && <div className="small restriction">⚠ {s.site.schedulingNotes}</div>}
                    {editable && (
                      <button className="link small" onClick={() => unschedule(s)}>
                        Unschedule
                      </button>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
