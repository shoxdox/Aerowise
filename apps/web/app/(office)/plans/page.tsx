"use client";

import { BILLING_FREQUENCY_LABELS, CUSTOMER_TYPE_LABELS, type Plan } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LoadState } from "@/components/LoadState";
import { StatusBadge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { money, plural } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";
import { EmptyState } from "@/components/EmptyState";

export default function PlansPage() {
  const editable = canEdit(useSession());
  const recordLoad = useLoad<{ items: Plan[] }>("/plans");
  const { data, reload } = recordLoad;
  const [creating, setCreating] = useState(false);

  const create = useSubmit(
    async (v: Record<string, string | undefined>) => {
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
    },
    { fallback: "Could not create the plan.", labels: { termMonths: "Term", visitsPerTerm: "Visits per term", priceCents: "Price" } },
  );
  const toggling = useSubmit(
    async (p: Plan) => {
      await api(`/plans/${p.id}`, { method: "PATCH", body: { active: !p.active } });
      await reload();
    },
    { fallback: "Could not change the plan." },
  );

  return (
    <div className="stack">
      <div className="row">
        <h1>Maintenance plans</h1>
        <span className="spacer" />
        {editable && <button onClick={() => setCreating((c) => !c)}>{creating ? "Cancel" : "New plan"}</button>}
      </div>
      <p className="muted">Contracts copy a plan&apos;s term, visits and price when they start, so editing a plan never changes existing contracts.</p>

      {creating && (
        <form className="card grid" onSubmit={create.form}>
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
          <FormError error={create.error} className="wide" />
          <div className="wide">
            <SubmitButton busy={create.busy}>Create plan</SubmitButton>
          </div>
        </form>
      )}

      <LoadState load={recordLoad} label="plans" />
      <FormError error={toggling.error} />
      {data && data.items.length > 0 && (
        <table className="stack">
          <thead>
            <tr>
              <th>Plan</th>
              <th>Term</th>
              <th>Visits</th>
              <th className="num">Price</th>
              <th>Status</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {data.items.map((p) => (
              <tr key={p.id}>
                <td data-label="Plan">
                  <Link href={`/plans/${p.id}`}>{p.name}</Link>{" "}
                  <span className="muted">
                    · {CUSTOMER_TYPE_LABELS[p.customerType]} · version {p.version}
                  </span>
                </td>
                <td data-label="Term">{plural(p.termMonths, "month")}</td>
                <td data-label="Visits">
                  {p.visitsPerTerm} (every {plural(p.termMonths / p.visitsPerTerm, "month")})
                </td>
                <td data-label="Price" className="num">
                  {money(p.priceCents)} <span className="muted">billed {BILLING_FREQUENCY_LABELS[p.billingFrequency]}</span>
                </td>
                <td data-label="Status">
                  <StatusBadge of="plan" value={p.active ? "offered" : "retired"} />
                </td>
                {editable && (
                  <td className="actions">
                    {p.active ? (
                      <ConfirmButton
                        className="link danger"
                        question="Stop offering this plan? Its contracts keep their terms."
                        confirmLabel="Retire"
                        busy={toggling.busy}
                        onConfirm={() => toggling.run(p)}
                      >
                        Retire
                      </ConfirmButton>
                    ) : (
                      <SubmitButton type="button" className="link" busy={toggling.busy} onClick={() => void toggling.run(p)}>
                        Offer again
                      </SubmitButton>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data?.items.length === 0 && (
        <EmptyState title="No plans yet">
          A plan is what you sell: how many visits a year, what they include and the price. Create one here, then start contracts on it from each site.
        </EmptyState>
      )}
    </div>
  );
}
