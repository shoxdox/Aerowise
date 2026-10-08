"use client";

import { SERVICE_TYPE_LABELS, type DueObligation, type ServiceType } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { useFeature } from "@/lib/features";
import { SafetyBadges } from "@/components/SafetyBadges";
import { useLoad } from "@/components/useLoad";
import { day } from "@/lib/format";
import { EmptyState } from "@/components/EmptyState";

const RANGES = [
  { label: "Next 7 days", days: 7 },
  { label: "Next 30 days", days: 30 },
  { label: "Next 90 days", days: 90 },
];

function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function DuePage() {
  const [range, setRange] = useState(30);
  const [overdueOnly, setOverdueOnly] = useState(false);
  // Pumping and maintenance visits (SW-9) are listed by type; inspections stay the default.
  const cyclesOn = useFeature("service_cycles");
  const [serviceType, setServiceType] = useState("aerobic_inspection");
  // The first load tells us the organization's "today"; ranges are relative to it.
  const first = useLoad<{ today: string }>("/obligations/due?limit=1");
  const today = first.data?.today;
  const query = today
    ? new URLSearchParams({ through: addDays(today, range), limit: "500", ...(overdueOnly ? { overdueOnly: "true" } : {}), ...(cyclesOn ? { serviceType } : {}) })
    : null;
  const { data } = useLoad<{ items: DueObligation[]; total: number; today: string }>(query ? `/obligations/due?${query}` : null);

  const overdueCount = data?.items.filter((o) => o.overdue).length ?? 0;

  return (
    <div className="stack">
      <div className="row">
        <h1>{!cyclesOn || serviceType === "aerobic_inspection" ? "Due inspections" : `Due ${SERVICE_TYPE_LABELS[serviceType as ServiceType].toLowerCase()} visits`}</h1>
        <span className="spacer" />
        {RANGES.map((r) => (
          <button key={r.days} className={range === r.days ? undefined : "secondary"} onClick={() => setRange(r.days)}>
            {r.label}
          </button>
        ))}
        {cyclesOn && (
          <select aria-label="Type of visit" value={serviceType} onChange={(e) => setServiceType(e.target.value)}>
            {(Object.keys(SERVICE_TYPE_LABELS) as ServiceType[]).map((t) => (
              <option key={t} value={t}>
                {SERVICE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        )}
        <label className="check">
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
          Overdue only
        </label>
      </div>
      {data && (
        <p className="muted">
          {data.total} open visit{data.total === 1 ? "" : "s"} · {overdueCount} overdue · today is {day(data.today)}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Due</th>
            <th>Site</th>
            <th>Customer</th>
            <th>Visit</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((o) => (
            <tr key={o.id} className={o.overdue ? "overdue" : undefined}>
              <td>
                {day(o.dueOn)}
                {o.overdue && <span className="badge danger">overdue</span>}
                <div className="muted small">window from {day(o.windowStart, { month: "short", day: "numeric" })}</div>
              </td>
              <td>
                <Link href={`/sites/${o.site.id}`}>
                  {o.site.addressLine1}, {o.site.city}
                </Link>{" "}
                <SafetyBadges flags={o.site.safetyFlags} />
              </td>
              <td>
                <Link href={`/customers/${o.customer.id}`}>{o.customer.displayName}</Link>
              </td>
              <td>#{o.sequence}</td>
              <td className="muted small">{o.site.schedulingNotes ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.items.length === 0 && (
        <EmptyState title="Nothing due in this range">
          Visits come from active contracts and the county&apos;s rules. Widen the range, or start a contract from a <Link href="/sites">site</Link>.
        </EmptyState>
      )}
    </div>
  );
}
