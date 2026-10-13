"use client";

import type { WorkOrderSummary } from "@aerowise/domain";
import Link from "next/link";
import { useQueryState } from "@/components/useQueryState";
import { LoadState } from "@/components/LoadState";
import { Pagination } from "@/components/Pagination";
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
  const [selectedView, setView] = useQueryState("view", "active");
  const view = VIEWS.find((v) => v.key === selectedView)?.key ?? "active";
  const query = VIEWS.find((v) => v.key === view)!.query;
  const [offsetText, setOffset] = useQueryState("offset", "0");
  const offset = Number.isSafeInteger(Number(offsetText)) && Number(offsetText) >= 0 ? Number(offsetText) : 0;
  const load = useLoad<{ items: WorkOrderSummary[]; total: number }>(`/work-orders?limit=50&offset=${offset}${query ? `&${query}` : ""}`);
  const { data } = load;

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
      <LoadState load={load} label="work" />
      {data && data.items.length > 0 && <WorkOrderTable items={data.items} />}
      {data?.items.length === 0 && (
        <EmptyState title="No work orders here">
          Create one from a site, or turn an inspection issue or a customer&apos;s request in the inbox into one.
        </EmptyState>
      )}
      {data && <Pagination total={data.total} offset={offset} onChange={(n) => setOffset(String(n))} />}
    </div>
  );
}
