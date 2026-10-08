"use client";

import type { WorkOrderSummary } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { useLoad } from "@/components/useLoad";
import { WorkOrderTable } from "@/components/WorkOrderTable";
import { useFeature } from "@/lib/features";
import { canEdit, useSession } from "@/lib/session";

const VIEWS = [
  { key: "active", label: "Open", query: "active=true" },
  { key: "open", label: "To schedule", query: "status=open" },
  { key: "scheduled", label: "Scheduled", query: "status=scheduled" },
  { key: "completed", label: "Completed", query: "status=completed" },
  { key: "cancelled", label: "Cancelled", query: "status=cancelled" },
  { key: "all", label: "All", query: "" },
] as const;

export default function WorkPage() {
  const editable = canEdit(useSession());
  const on = useFeature("work_orders");
  const [view, setView] = useState<(typeof VIEWS)[number]["key"]>("active");
  const query = VIEWS.find((v) => v.key === view)!.query;
  const { data, error } = useLoad<{ items: WorkOrderSummary[]; total: number }>(`/work-orders?limit=200${query ? `&${query}` : ""}`);

  return (
    <div className="stack">
      <div className="row">
        <h1>Work orders</h1>
        <span className="spacer" />
        {VIEWS.map((v) => (
          <button key={v.key} className={view === v.key ? undefined : "secondary"} onClick={() => setView(v.key)}>
            {v.label}
          </button>
        ))}
        {on && editable && (
          <Link href="/work/new" className="button">
            New work order
          </Link>
        )}
      </div>
      <p className="muted small">Pumping, repairs, installations and service calls. They never count as an inspection visit and never go to an authority.</p>
      {error && <p className="error">{error}</p>}
      {data && data.items.length > 0 && <WorkOrderTable items={data.items} />}
      {data?.items.length === 0 && (
        <EmptyState title="No work orders here">
          Create one from a site, or turn an inspection issue or a customer&apos;s request in the inbox into one.
        </EmptyState>
      )}
    </div>
  );
}
