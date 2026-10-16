"use client";

import type { WorkOrderSummary } from "@aerowise/domain";
import Link from "next/link";
import { Badge, StatusBadge } from "@/components/StatusBadge";
import { day } from "@/lib/format";

/** Work orders as a table: number, kind, place, status and the open visit. */
export function WorkOrderTable({ items, showSite = true }: { items: WorkOrderSummary[]; showSite?: boolean }) {
  return (
    <div className="table-scroll">
      <table className="stack" data-testid="work-orders">
        <thead>
          <tr>
            <th>Work order</th>
            <th>Kind</th>
            {showSite && <th>Site</th>}
            <th>Status</th>
            <th>Visit</th>
          </tr>
        </thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.id}>
              <td data-label="Work order">
                <Link href={`/work/${w.id}`}>
                  <strong>{w.label}</strong> {w.title}
                </Link>{" "}
                {w.priority === "urgent" && <Badge tone="danger">Urgent</Badge>}
              </td>
              <td data-label="Kind">{w.workType.name}</td>
              {showSite && (
                <td data-label="Site">
                  <Link href={`/sites/${w.site.id}`}>
                    {w.site.addressLine1}, {w.site.city}
                  </Link>
                  <div className="muted small">{w.customer.displayName}</div>
                </td>
              )}
              <td data-label="Status">
                <StatusBadge of="workOrder" value={w.status} />
              </td>
              <td data-label="Visit" className="small">
                {w.nextVisit ? `${day(w.nextVisit.scheduledDate, { weekday: "short", month: "short", day: "numeric" })} · ${w.nextVisit.technicianName}` : <span className="muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
