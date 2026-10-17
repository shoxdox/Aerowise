"use client";

import { roleHasPermission, SERVICE_ITEM_UNIT_LABELS, SERVICE_ITEM_UNITS, WORK_CATEGORY_LABELS, WORK_CATEGORIES, type ServiceItem } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, formValues } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { money } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

/** The service item catalog: what the company charges for, picked when writing work order and invoice lines. */
export default function ServiceItemsPage() {
  const me = useSession();
  const on = useFeature("service_items");
  const editable = canEdit(me) && roleHasPermission(me.role, "invoices:write");
  const items = useLoad<{ items: ServiceItem[] }>("/service-items?active=all");
  const { data, reload } = items;
  // The item whose price is being changed, right on its row.
  const [repricing, setRepricing] = useState<string | null>(null);
  const saving = useSubmit(
    async (path: string, method: "POST" | "PATCH", body: object) => {
      await api(path, { method, body });
      setRepricing(null);
      await reload();
      return true;
    },
    { fallback: "Could not save.", labels: { unitPriceCents: "Price" } },
  );
  const save = async (path: string, method: "POST" | "PATCH", body: object) => (await saving.run(path, method, body)) === true;
  const problem = saving.error;

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

  function reprice(item: ServiceItem, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { price } = formValues(event.currentTarget);
    void save(`/service-items/${item.id}`, "PATCH", { unitPriceCents: Math.round(Number(price) * 100) });
  }

  return (
    <div className="stack">
      <h1>Service items</h1>
      <p className="muted">
        What the company charges for. Work order and invoice lines start from an item and keep their own copy of its description and price, so changing or switching off an item never
        changes a line already written.
      </p>
      <FormError error={problem} />
      {!data ? (
        <LoadState load={items} label="service items" />
      ) : data.items.length === 0 ? (
        <p className="muted">No service items yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="compact stack" data-testid="service-items">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Price</th>
                <th>Kind</th>
                <th>Taxable</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id} className={i.active ? undefined : "muted"}>
                  <td data-label="Name">
                    {i.name} {!i.active && <Badge tone="struck">Off</Badge>}
                    {i.description && <div className="muted small">{i.description}</div>}
                  </td>
                  <td data-label="Price" className="num">
                    {repricing === i.id ? (
                      <form className="row" onSubmit={(e) => reprice(i, e)}>
                        <input name="price" type="number" min={0} step="0.01" required defaultValue={(i.unitPriceCents / 100).toFixed(2)} aria-label={`New price for ${i.name} ($)`} autoFocus style={{ width: "7em" }} />
                        <SubmitButton busy={saving.busy}>Save</SubmitButton>
                        <button type="button" className="link" onClick={() => setRepricing(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        {money(i.unitPriceCents)} {SERVICE_ITEM_UNIT_LABELS[i.unit]}
                      </>
                    )}
                  </td>
                  <td data-label="Kind">{i.category ? WORK_CATEGORY_LABELS[i.category] : ""}</td>
                  <td data-label="Taxable">{i.taxable ? "Yes" : "No"}</td>
                  <td className={editable ? "actions" : undefined}>
                    {editable && (
                      <div className="row">
                        <button type="button" className="link" onClick={() => (saving.clear(), setRepricing(i.id))}>
                          Change price
                        </button>
                        <button type="button" className={i.active ? "link danger" : "link"} disabled={saving.busy} onClick={() => void save(`/service-items/${i.id}`, "PATCH", { active: !i.active })}>
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
          <label className="check">
            <input name="taxable" type="checkbox" /> Taxable
          </label>
          <div className="row">
            <SubmitButton busy={saving.busy}>Add item</SubmitButton>
          </div>
        </form>
      )}
      {!on && <p className="muted small">Service items are not switched on for this deployment; existing items stay readable.</p>}
    </div>
  );
}
