"use client";

import type { ContractDetail, Plan } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day, money } from "@/lib/format";

const STATE_LABEL: Record<ContractDetail["state"], string> = {
  upcoming: "starts soon",
  active: "active",
  expired: "expired",
  cancelled: "cancelled",
};

export function SiteContracts({ siteId, editable }: { siteId: string; editable: boolean }) {
  const { data, reload } = useLoad<{ items: ContractDetail[] }>(`/sites/${siteId}/contracts`);
  const plans = useLoad<{ items: Plan[] }>(editable ? "/plans" : null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      setCreating(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    void run(() =>
      api(`/sites/${siteId}/contracts`, {
        method: "POST",
        body: {
          planId: v.planId,
          startOn: v.startOn,
          priceCents: v.price ? Math.round(Number(v.price) * 100) : undefined,
          autoRenew: v.autoRenew === "on",
        },
      }),
    );
  }

  function cancel(c: ContractDetail) {
    const reason = window.prompt("Why is this contract being cancelled?");
    if (reason) void run(() => api(`/contracts/${c.id}/cancel`, { method: "POST", body: { reason } }));
  }

  const offered = plans.data?.items.filter((p) => p.active) ?? [];

  return (
    <section className="stack">
      <div className="row">
        <h2>Contracts</h2>
        <span className="spacer" />
        {editable && (
          <button className="secondary" onClick={() => setCreating((c) => !c)}>
            {creating ? "Cancel" : "New contract"}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      {creating && (
        <form className="card grid" onSubmit={onCreate}>
          {offered.length === 0 ? (
            <p className="muted wide">Create a maintenance plan first, under Plans.</p>
          ) : (
            <>
              <label className="wide">
                Plan
                <select name="planId" required>
                  {offered.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}: {p.termMonths} months, {p.visitsPerTerm} visits, {money(p.priceCents)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Start date
                <input name="startOn" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
              </label>
              <label>
                Price override ($)
                <input name="price" type="number" min={0} step="0.01" placeholder="Plan price" />
              </label>
              <label className="check">
                <input type="checkbox" name="autoRenew" />
                Auto-renew
              </label>
              <div className="wide">
                <button type="submit">Start contract</button>
              </div>
            </>
          )}
        </form>
      )}

      {data?.items.length === 0 && <p className="muted">No contracts on this site.</p>}
      {data?.items.map((c) => (
        <div key={c.id} className="card stack">
          <div className="row">
            <strong>{c.planName}</strong>
            <span className={`badge ${c.state}`}>{STATE_LABEL[c.state]}</span>
            <span className="muted">
              {day(c.startOn)} to {day(c.endOn)} · {money(c.priceCents)}
              {c.autoRenew ? " · auto-renews" : ""}
            </span>
            <span className="spacer" />
            {editable && c.status === "active" && !c.renewedById && (
              <button className="secondary" onClick={() => run(() => api(`/contracts/${c.id}/renew`, { method: "POST", body: {} }))}>
                Renew
              </button>
            )}
            {editable && c.status === "active" && (
              <button className="link" onClick={() => cancel(c)}>
                Cancel contract
              </button>
            )}
          </div>
          {c.cancelReason && <p className="muted">Cancelled: {c.cancelReason}</p>}
          <table className="compact">
            <thead>
              <tr>
                <th>Visit</th>
                <th>Window</th>
                <th>Due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {c.obligations.map((o) => (
                <tr key={o.id}>
                  <td>#{o.sequence}</td>
                  <td>
                    {day(o.windowStart, { month: "short", day: "numeric" })} to {day(o.windowEnd)}
                  </td>
                  <td>{day(o.dueOn)}</td>
                  <td>
                    <span className={`badge ${o.status}`}>{o.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
