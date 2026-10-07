"use client";

import type { WorkOrderSummary } from "@aerowise/domain";
import Link from "next/link";
import { useLoad } from "@/components/useLoad";
import { WorkOrderTable } from "@/components/WorkOrderTable";
import { useFeature } from "@/lib/features";

/** The site's work orders (pumping, repairs, installations), apart from its inspection visits. */
export function SiteWorkOrders({ siteId, editable }: { siteId: string; editable: boolean }) {
  const on = useFeature("work_orders");
  const { data } = useLoad<{ items: WorkOrderSummary[]; total: number }>(`/work-orders?siteId=${siteId}&limit=20`);
  if (!on && !data?.items.length) return null;
  return (
    <section className="stack" data-testid="site-work-orders">
      <div className="row">
        <h2>Work orders</h2>
        <span className="spacer" />
        {on && editable && (
          <Link href={`/work/new?siteId=${siteId}`} className="button secondary">
            Create work order
          </Link>
        )}
      </div>
      {data && data.items.length > 0 ? <WorkOrderTable items={data.items} showSite={false} /> : <p className="muted">No work orders at this site. Inspections are listed with the contract above.</p>}
    </section>
  );
}
