"use client";

import { WORK_ORDER_STATUS_LABELS, type WorkOrderSummary } from "@aerowise/domain";
import Link from "next/link";
import { day } from "@/lib/format";

const STATUS_CLASS: Partial<Record<WorkOrderSummary["status"], string>> = { completed: "completed", cancelled: "cancelled", scheduled: "upcoming", in_progress: "upcoming", draft: "inactive" };

/** Work orders as a table: number, kind, place, status and the open visit. */
export function WorkOrderTable({ items, showSite = true }: { items: WorkOrderSummary[]; showSite?: boolean }) {
  return (
    <div className="table-scroll">
    <table data-testid="work-orders">
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
            <td>
              <Link href={`/work/${w.id}`}>
                <strong>{w.label}</strong> {w.title}
              </Link>
              {w.priority === "urgent" && <span className="badge danger">urgent</span>}
            </td>
            <td>{w.workType.name}</td>
            {showSite && (
              <td>
                <Link href={`/sites/${w.site.id}`}>
                  {w.site.addressLine1}, {w.site.city}
                </Link>
                <div className="muted small">{w.customer.displayName}</div>
              </td>
            )}
            <td>
              <span className={`badge ${STATUS_CLASS[w.status] ?? ""}`}>{WORK_ORDER_STATUS_LABELS[w.status]}</span>
            </td>
            <td className="small">{w.nextVisit ? `${day(w.nextVisit.scheduledDate, { weekday: "short", month: "short", day: "numeric" })} · ${w.nextVisit.technicianName}` : <span className="muted">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
