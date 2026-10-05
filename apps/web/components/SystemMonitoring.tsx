"use client";

import { MONITORING_METHOD_LABELS, MONITORING_METHODS, type SystemMonitoring as Monitoring, type WastewaterSystem } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day } from "@/lib/format";

/**
 * Electronic monitoring on the site's systems. Where the site's authority allows a longer
 * time between inspections for monitored systems, contracts starting while monitoring is
 * on record (and checked) get that schedule; otherwise it is only kept for reference.
 */
export function SystemMonitoring({ siteId, systems, editable }: { siteId: string; systems: WastewaterSystem[]; editable: boolean }) {
  const { data, reload } = useLoad<{ items: Monitoring[] }>(`/sites/${siteId}/monitoring`);
  const [form, setForm] = useState<{ kind: "record"; systemId: string } | { kind: "end"; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const active = systems.filter((s) => s.active);
  if (active.length === 0 && data.items.length === 0) return null;
  const open = (systemId: string) => data.items.find((m) => m.systemId === systemId && !m.endedOn);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;
    const v = formValues(event.currentTarget);
    setError(null);
    try {
      if (form.kind === "record") {
        await api(`/systems/${form.systemId}/monitoring`, {
          method: "POST",
          body: { method: v.method, description: v.description, notifies: v.notifies, startedOn: v.startedOn, checkedOn: v.checkedOn },
        });
      } else {
        await api(`/monitoring/${form.id}/end`, { method: "POST", body: { endedOn: v.endedOn, reason: v.reason } });
      }
      setForm(null);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <section className="stack">
      <h2>Electronic monitoring</h2>
      {active.map((s) => {
        const m = open(s.id);
        const unit = [s.manufacturer, s.model].filter(Boolean).join(" ") || "System";
        return (
          <div key={s.id} className="card tight">
            <div className="row">
              <strong>{unit}</strong>
              {m ? <span className="badge completed">Monitored</span> : <span className="badge">Not monitored</span>}
              <span className="spacer" />
              {editable && !form && (
                <button className="link" onClick={() => setForm(m ? { kind: "end", id: m.id } : { kind: "record", systemId: s.id })}>
                  {m ? "Record that it ended" : "Record monitoring"}
                </button>
              )}
            </div>
            {m && (
              <p className="small">
                {MONITORING_METHOD_LABELS[m.method]}: {m.description}. Notifies {m.notifies}. Since {day(m.startedOn)}, checked {day(m.checkedOn)}.
              </p>
            )}
            {form?.kind === "record" && form.systemId === s.id && (
              <form className="grid" onSubmit={send}>
                <label>
                  Kind
                  <select name="method" defaultValue="autodialer">
                    {MONITORING_METHODS.map((k) => (
                      <option key={k} value={k}>
                        {MONITORING_METHOD_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Device or service
                  <input name="description" required placeholder="Make and model, or monitoring company" />
                </label>
                <label className="wide">
                  Who it notifies automatically, and how
                  <input name="notifies" required placeholder="Our office, by phone call" />
                </label>
                <label>
                  In place since
                  <input name="startedOn" type="date" required />
                </label>
                <label>
                  Checked working on
                  <input name="checkedOn" type="date" required />
                </label>
                {error && <p className="error wide">{error}</p>}
                <div className="wide row">
                  <button type="submit">Save</button>
                  <button type="button" className="link" onClick={() => setForm(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {form?.kind === "end" && m && form.id === m.id && (
              <form className="grid" onSubmit={send}>
                <label>
                  Ended on
                  <input name="endedOn" type="date" required />
                </label>
                <label>
                  Why
                  <input name="reason" required />
                </label>
                {error && <p className="error wide">{error}</p>}
                <div className="wide row">
                  <button type="submit">Save</button>
                  <button type="button" className="link" onClick={() => setForm(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        );
      })}
      {data.items.some((m) => m.endedOn) && (
        <p className="small muted">
          Ended:{" "}
          {data.items
            .filter((m) => m.endedOn)
            .map((m) => `${MONITORING_METHOD_LABELS[m.method]} ${day(m.startedOn)} to ${day(m.endedOn!)} (${m.endReason})`)
            .join("; ")}
        </p>
      )}
    </section>
  );
}
