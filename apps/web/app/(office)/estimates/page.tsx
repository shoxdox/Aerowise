"use client";

import { ESTIMATE_STATUS_LABELS, type EstimateSummary } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { estimateBadge } from "@/components/EstimateLineEditor";
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
  const [view, setView] = useState<(typeof VIEWS)[number]["key"]>("active");
  const query = VIEWS.find((v) => v.key === view)!.query;
  const { data, error } = useLoad<{ items: EstimateSummary[]; total: number }>(`/estimates?limit=200${query ? `&${query}` : ""}`);

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
      {error && <p className="error">{error}</p>}
      {data && data.items.length > 0 && (
        <div className="table-scroll">
          <table>
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
                  <td>
                    <Link href={`/estimates/${e.id}`}>
                      {e.label} · {e.title}
                    </Link>
                  </td>
                  <td>{e.customer.displayName}</td>
                  <td>
                    {e.site.addressLine1}, {e.site.city}
                  </td>
                  <td className="num">{money(e.totalCents)}</td>
                  <td>{e.expiresOn ? day(e.expiresOn) : "—"}</td>
                  <td>
                    <span className={`badge ${estimateBadge(e.status)}`}>{ESTIMATE_STATUS_LABELS[e.status]}</span>
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
    </div>
  );
}
