"use client";

import type { WorkOrderSummary } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { Pagination } from "@/components/Pagination";
import { LoadState } from "@/components/LoadState";
import { useLoad } from "@/components/useLoad";
import { WorkOrderTable } from "@/components/WorkOrderTable";
import { useFeature } from "@/lib/features";

/** The site's work orders (pumping, repairs, installations), apart from its inspection visits. */
export function SiteWorkOrders({ siteId, editable }: { siteId: string; editable: boolean }) {
  const on = useFeature("work_orders");
  const estimates = useFeature("estimates");
  const [offset, setOffset] = useState(0);
  const recordLoad = useLoad<{ items: WorkOrderSummary[]; total: number }>(`/work-orders?siteId=${siteId}&limit=50&offset=${offset}`);
  const { data } = recordLoad;
  if (!data) return <LoadState load={recordLoad} label="site work orders" />;
  if (!on && !data.items.length) return null;
  return (
    <section className="stack" data-testid="site-work-orders"><LoadState load={recordLoad} label="site work orders" />
      <div className="row">
        <h2>Work orders</h2>
        <span className="spacer" />
        {on && estimates && editable && (
          <Link href={`/estimates/new?siteId=${siteId}`} className="button secondary">
            Create estimate
          </Link>
        )}
        {on && editable && (
          <Link href={`/work/new?siteId=${siteId}`} className="button secondary">
            Create work order
          </Link>
        )}
      </div>
      {data && data.items.length > 0 ? <WorkOrderTable items={data.items} showSite={false} /> : <p className="muted">No work orders at this site. Inspections are listed with the contract above.</p>}
      {data && <Pagination total={data.total} offset={offset} onChange={setOffset} />}
    </section>
  );
}
