"use client";

import type { Plan } from "@aerowise/domain";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { money } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";
import { EmptyState } from "@/components/EmptyState";

export default function PlansPage() {
  const editable = canEdit(useSession());
  const { data, reload } = useLoad<{ items: Plan[] }>("/plans");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const v = formValues(event.currentTarget);
    try {
      await api("/plans", {
        method: "POST",
        body: {
          name: v.name,
          customerType: v.customerType,
          termMonths: Number(v.termMonths),
          visitsPerTerm: Number(v.visitsPerTerm),
          priceCents: Math.round(Number(v.price) * 100),
          billingFrequency: v.billingFrequency,
        },
      });
      setCreating(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create plan");
    }
  }

  async function toggle(p: Plan) {
    await api(`/plans/${p.id}`, { method: "PATCH", body: { active: !p.active } });
    await reload();
  }

  return (
    <div className="stack">
      <div className="row">
        <h1>Maintenance plans</h1>
        <span className="spacer" />
        {editable && <button onClick={() => setCreating((c) => !c)}>{creating ? "Cancel" : "New plan"}</button>}
      </div>
      <p className="muted">Contracts copy a plan&apos;s term, visits and price when they start, so editing a plan never changes existing contracts.</p>

      {creating && (
        <form className="card grid" onSubmit={onCreate}>
          <label className="wide">
            Name
            <input name="name" required placeholder="Residential annual" />
          </label>
          <label title="A label for the plan. The county's schedule follows the site's own residential or commercial setting.">
            Customer type
            <select name="customerType" defaultValue="residential">
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
            </select>
          </label>
          <label>
            Term (months)
            <input name="termMonths" type="number" min={1} max={60} defaultValue={12} required />
          </label>
          <label>
            Visits per term
            <input name="visitsPerTerm" type="number" min={1} max={24} defaultValue={3} required />
          </label>
          <label>
            Price per term ($)
            <input name="price" type="number" min={0} step="0.01" required />
          </label>
          <label>
            Billing
            <select name="billingFrequency" defaultValue="annual">
              <option value="annual">Annual</option>
              <option value="semiannual">Semiannual</option>
              <option value="quarterly">Quarterly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          {error && <p className="error wide">{error}</p>}
          <div className="wide">
            <button type="submit">Create plan</button>
          </div>
        </form>
      )}

      <table>
        <thead>
          <tr>
            <th>Plan</th>
            <th>Term</th>
            <th>Visits</th>
            <th>Price</th>
            <th>Status</th>
            {editable && <th />}
          </tr>
        </thead>
        <tbody>
          {data?.items.map((p) => (
            <tr key={p.id}>
              <td>
                <Link href={`/plans/${p.id}`}>{p.name}</Link> <span className="muted">· {p.customerType} · version {p.version}</span>
              </td>
              <td>{p.termMonths} months</td>
              <td>
                {p.visitsPerTerm} (every {p.termMonths / p.visitsPerTerm} months)
              </td>
              <td>
                {money(p.priceCents)} <span className="muted">billed {p.billingFrequency}</span>
              </td>
              <td>
                <span className={`badge ${p.active ? "active" : "inactive"}`}>{p.active ? "offered" : "retired"}</span>
              </td>
              {editable && (
                <td>
                  <button className="link" onClick={() => toggle(p)}>
                    {p.active ? "Retire" : "Offer again"}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {data?.items.length === 0 && (
        <EmptyState title="No plans yet">
          A plan is what you sell: how many visits a year, what they include and the price. Create one here, then start contracts on it from each site.
        </EmptyState>
      )}
    </div>
  );
}
