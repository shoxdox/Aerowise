"use client";

import { roleHasPermission, SERVICE_ITEM_UNIT_LABELS, SERVICE_ITEM_UNITS, WORK_CATEGORY_LABELS, WORK_CATEGORIES, type ServiceItem } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { money } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

/** The service item catalog: what the company charges for, picked when writing work order and invoice lines. */
export default function ServiceItemsPage() {
  const me = useSession();
  const on = useFeature("service_items");
  const editable = canEdit(me) && roleHasPermission(me.role, "invoices:write");
  const { data, error, reload } = useLoad<{ items: ServiceItem[] }>("/service-items?active=all");
  const [problem, setProblem] = useState<string | null>(null);

  async function save(path: string, method: "POST" | "PATCH", body: object) {
    setProblem(null);
    try {
      await api(path, { method, body });
      await reload();
      return true;
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save");
      return false;
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const v = formValues(form);
    const ok = await save("/service-items", "POST", {
      name: v.name,
      description: v.description ?? null,
      unit: v.unit ?? "each",
      unitPriceCents: Math.round(Number(v.price ?? "0") * 100),
      taxable: v.taxable === "on",
      category: v.category ?? null,
    });
    if (ok) form.reset();
  }

  async function reprice(item: ServiceItem) {
    const answer = window.prompt(`New price for ${item.name} ($)`, (item.unitPriceCents / 100).toFixed(2));
    if (answer === null) return;
    const cents = Math.round(Number(answer) * 100);
    if (!Number.isFinite(cents) || cents < 0) return setProblem("Enter a price of zero or more");
    await save(`/service-items/${item.id}`, "PATCH", { unitPriceCents: cents });
  }

  if (error) return <p className="error">{error}</p>;
  return (
    <div className="stack">
      <h1>Service items</h1>
      <p className="muted">
        What the company charges for. Work order and invoice lines start from an item and keep their own copy of its description and price, so changing or switching off an item never
        changes a line already written.
      </p>
      {problem && <p className="error">{problem}</p>}
      {!data ? (
        <p className="muted">Loading…</p>
      ) : data.items.length === 0 ? (
        <p className="muted">No service items yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="compact" data-testid="service-items">
            <thead>
              <tr>
                <th>Name</th>
                <th>Price</th>
                <th>Kind</th>
                <th>Taxable</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id} className={i.active ? undefined : "muted"}>
                  <td>
                    {i.name}
                    {!i.active && <span className="badge cancelled">off</span>}
                    {i.description && <div className="muted small">{i.description}</div>}
                  </td>
                  <td>
                    {money(i.unitPriceCents)} {SERVICE_ITEM_UNIT_LABELS[i.unit]}
                  </td>
                  <td>{i.category ? WORK_CATEGORY_LABELS[i.category] : ""}</td>
                  <td>{i.taxable ? "yes" : "no"}</td>
                  <td>
                    {editable && (
                      <div className="row">
                        <button type="button" className="link" onClick={() => void reprice(i)}>
                          Change price
                        </button>
                        <button type="button" className="link" onClick={() => void save(`/service-items/${i.id}`, "PATCH", { active: !i.active })}>
                          {i.active ? "Switch off" : "Switch on"}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editable && on && (
        <form className="card stack" onSubmit={add}>
          <h2>Add an item</h2>
          <div className="grid">
            <label>
              Name
              <input name="name" required maxLength={200} />
            </label>
            <label>
              Price ($)
              <input name="price" type="number" min={0} step="0.01" required />
            </label>
            <label>
              Charged
              <select name="unit" defaultValue="each">
                {SERVICE_ITEM_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {SERVICE_ITEM_UNIT_LABELS[u]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Kind of work
              <select name="category" defaultValue="">
                <option value="">Any</option>
                {WORK_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {WORK_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Description on lines
            <input name="description" maxLength={2000} placeholder="Optional; the name is used otherwise" />
          </label>
          <label className="row">
            <input name="taxable" type="checkbox" /> Taxable
          </label>
          <div className="row">
            <button type="submit">Add item</button>
          </div>
        </form>
      )}
      {!on && <p className="muted small">Service items are not switched on for this deployment; existing items stay readable.</p>}
    </div>
  );
}
