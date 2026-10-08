"use client";

import { SERVICE_ITEM_UNIT_LABELS, type ServiceItem, type WorkType } from "@aerowise/domain";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { money } from "@/lib/format";

interface SiteOption {
  id: string;
  addressLine1: string;
  city: string;
  customerName: string;
}

function NewWorkOrder() {
  const router = useRouter();
  const params = useSearchParams();
  const fixedSite = params.get("siteId");
  const [search, setSearch] = useState("");
  const types = useLoad<{ items: WorkType[] }>("/work-types");
  const catalogOn = useFeature("service_items");
  const catalog = useLoad<{ items: ServiceItem[] }>(catalogOn ? "/service-items" : null);
  const list = useLoad<{ items: SiteOption[] }>(fixedSite ? null : `/sites?limit=50${search ? `&search=${encodeURIComponent(search)}` : ""}`);
  const one = useLoad<{ id: string; addressLine1: string; city: string; customer: { displayName: string } }>(fixedSite ? `/sites/${fixedSite}` : null);
  const [error, setError] = useState<string | null>(null);
  const siteOptions: SiteOption[] = fixedSite
    ? one.data
      ? [{ id: one.data.id, addressLine1: one.data.addressLine1, city: one.data.city, customerName: one.data.customer.displayName }]
      : []
    : (list.data?.items ?? []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    setError(null);
    try {
      // A catalog item fills in what was left blank.
      const item = catalog.data?.items.find((i) => i.id === v.lineServiceItemId);
      const description = v.lineDescription ?? (item ? item.description || item.name : undefined);
      const priceCents = v.linePrice !== undefined ? Math.round(Number(v.linePrice) * 100) : item?.unitPriceCents;
      const lines =
        description && priceCents !== undefined
          ? [{ description, quantity: Number(v.lineQuantity ?? "1"), unitPriceCents: priceCents, taxable: item?.taxable ?? false, serviceItemId: item?.id ?? null }]
          : [];
      const wo = await api<{ id: string }>("/work-orders", {
        method: "POST",
        body: { siteId: v.siteId, workTypeId: v.workTypeId, title: v.title, description: v.description ?? "", priority: v.priority ?? "normal", requestedOn: v.requestedOn, draft: v.draft === "on", lines },
      });
      router.push(`/work/${wo.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the work order");
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <p>
        <Link href="/work">← Work orders</Link>
      </p>
      <h1>New work order</h1>
      {!fixedSite && (
        <label>
          Find a site
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Address, city or permit number" />
        </label>
      )}
      <label>
        Site
        <select name="siteId" required>
          {siteOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.addressLine1}, {s.city}
              {s.customerName ? ` (${s.customerName})` : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        Kind of work
        <select name="workTypeId" required>
          {types.data?.items
            .filter((t) => t.active)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        Title <span className="muted small">(the kind of work if left blank)</span>
        <input name="title" maxLength={200} />
      </label>
      <label>
        What needs doing
        <textarea name="description" rows={3} maxLength={5000} />
      </label>
      <div className="row">
        <label>
          Priority
          <select name="priority" defaultValue="normal">
            <option value="normal">Normal</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
        <label>
          Requested on
          <input name="requestedOn" type="date" />
        </label>
      </div>
      <fieldset className="stack">
        <legend>Planned charge (optional)</legend>
        {catalog.data && catalog.data.items.length > 0 && (
          <select name="lineServiceItemId" defaultValue="" aria-label="Service item">
            <option value="">Not from the catalog</option>
            {catalog.data.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({money(i.unitPriceCents)} {SERVICE_ITEM_UNIT_LABELS[i.unit]})
              </option>
            ))}
          </select>
        )}
        <div className="row">
          <input name="lineDescription" placeholder="Description" aria-label="Line description" maxLength={500} />
          <input name="lineQuantity" type="number" min="0.001" step="0.001" defaultValue="1" aria-label="Quantity" />
          <input name="linePrice" type="number" min="0" step="0.01" placeholder="Unit price ($)" aria-label="Unit price in dollars" />
        </div>
      </fieldset>
      <label className="row">
        <input name="draft" type="checkbox" /> Save as a draft (not ready to schedule yet)
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="submit">Create work order</button>
        <button type="button" className="secondary" onClick={() => router.back()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function NewWorkOrderPage() {
  return (
    <Suspense>
      <NewWorkOrder />
    </Suspense>
  );
}
