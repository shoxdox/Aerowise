"use client";

import type { EstimateSummary } from "@aerowise/domain";
import Link from "next/link";
import { useQueryState } from "@/components/useQueryState";
import { LoadState } from "@/components/LoadState";
import { Pagination } from "@/components/Pagination";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import { useLoad } from "@/components/useLoad";
import { useFeature } from "@/lib/features";
import { day, money } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

const VIEWS = [
  { key: "active", label: "Open", query: "active=true" },
  { key: "accepted", label: "Accepted", query: "status=accepted" },
  { key: "declined", label: "Declined", query: "status=declined" },
  { key: "expired", label: "Expired", query: "status=expired" },
  { key: "all", label: "All", query: "" },
] as const;

export default function EstimatesPage() {
  const editable = canEdit(useSession());
  const on = useFeature("estimates");
  const [selectedView, setView] = useQueryState("view", "active");
  const view = VIEWS.find((v) => v.key === selectedView)?.key ?? "active";
  const query = VIEWS.find((v) => v.key === view)!.query;
  const [offsetText, setOffset] = useQueryState("offset", "0");
  const offset = Number.isSafeInteger(Number(offsetText)) && Number(offsetText) >= 0 ? Number(offsetText) : 0;
  const load = useLoad<{ items: EstimateSummary[]; total: number }>(`/estimates?limit=50&offset=${offset}${query ? `&${query}` : ""}`);
  const { data } = load;

  return (
    <div className="stack">
      <div className="row">
        <h1>Estimates</h1>
        <span className="spacer" />
        {VIEWS.map((v) => (
          <button key={v.key} className={view === v.key ? undefined : "secondary"} onClick={() => setView(v.key)}>
            {v.label}
          </button>
        ))}
        {on && editable && (
          <Link href="/estimates/new" className="button">
            New estimate
          </Link>
        )}
      </div>
      <p className="muted small">Quotes for repairs, pumping and other work. When the customer accepts one, it becomes a work order.</p>
      <LoadState load={load} label="estimates" />
      {data && data.items.length > 0 && (
        <div className="table-scroll">
          <table className="stack">
            <thead>
              <tr>
                <th>Estimate</th>
                <th>Customer</th>
                <th>Site</th>
                <th className="num">Total</th>
                <th>Good until</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id}>
                  <td data-label="Estimate">
                    <Link href={`/estimates/${e.id}`}>
                      {e.label} · {e.title}
                    </Link>
                  </td>
                  <td data-label="Customer">{e.customer.displayName}</td>
                  <td data-label="Site">
                    {e.site.addressLine1}, {e.site.city}
                  </td>
                  <td data-label="Total" className="num">
                    {money(e.totalCents)}
                  </td>
                  <td data-label="Good until">{e.expiresOn ? day(e.expiresOn) : "—"}</td>
                  <td data-label="Status">
                    <StatusBadge of="estimate" value={e.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.items.length === 0 && (
        <EmptyState title="No estimates here">Draft one from a site, or turn an inspection issue or a customer&apos;s request in the inbox into one.</EmptyState>
      )}
      {data && <Pagination total={data.total} offset={offset} onChange={(n) => setOffset(String(n))} />}
    </div>
  );
}
