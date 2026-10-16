"use client";

import { addDays, SERVICE_TYPE_LABELS, type DueObligation, type ServiceType } from "@aerowise/domain";
import Link from "next/link";
import { useQueryState } from "@/components/useQueryState";
import { LoadState } from "@/components/LoadState";
import { Pagination } from "@/components/Pagination";
import { canEdit, useSession } from "@/lib/session";
import { useFeature } from "@/lib/features";
import { SafetyBadges } from "@/components/SafetyBadges";
import { Badge } from "@/components/StatusBadge";
import { useLoad } from "@/components/useLoad";
import { day, plural } from "@/lib/format";
import { EmptyState } from "@/components/EmptyState";

const RANGES = [
  { label: "Next 7 days", days: 7 },
  { label: "Next 30 days", days: 30 },
  { label: "Next 90 days", days: 90 },
];

export default function DuePage() {
  const editable = canEdit(useSession());
  const [rangeText, setRange] = useQueryState("range", "30");
  const range = [7, 30, 90].includes(Number(rangeText)) ? Number(rangeText) : 30;
  const [overdueText, setOverdueOnly] = useQueryState("overdueOnly", "false");
  const overdueOnly = overdueText === "true";
  const [upcomingText, setUpcomingOnly] = useQueryState("upcomingOnly", "false");
  const upcomingOnly = upcomingText === "true" && !overdueOnly;
  const [offsetText, setOffset] = useQueryState("offset", "0");
  const offset = Number.isSafeInteger(Number(offsetText)) && Number(offsetText) >= 0 ? Number(offsetText) : 0;
  // Pumping and maintenance visits (SW-9) are listed by type; inspections stay the default.
  const cyclesOn = useFeature("service_cycles");
  const [selectedType, setServiceType] = useQueryState("serviceType", "aerobic_inspection");
  const serviceType = Object.hasOwn(SERVICE_TYPE_LABELS, selectedType) ? selectedType : "aerobic_inspection";
  // The first load tells us the organization's "today"; ranges are relative to it.
  const first = useLoad<{ today: string }>("/obligations/due?limit=1");
  const today = first.data?.today;
  const query = today
    ? new URLSearchParams({ through: addDays(today, range), limit: "50", offset: String(offset), ...(overdueOnly ? { overdueOnly: "true" } : {}), ...(upcomingOnly ? { upcomingOnly: "true" } : {}), ...(cyclesOn ? { serviceType } : {}) })
    : null;
  const load = useLoad<{ items: DueObligation[]; total: number; overdueTotal: number; today: string }>(query ? `/obligations/due?${query}` : null);

  const { data } = load;
  const overdueCount = data?.overdueTotal ?? 0;

  return (
    <div className="stack">
      <div className="row">
        <h1>{!cyclesOn || serviceType === "aerobic_inspection" ? "Due inspections" : `Due ${SERVICE_TYPE_LABELS[serviceType as ServiceType].toLowerCase()} visits`}</h1>
        <span className="spacer" />
        {RANGES.map((r) => (
          <button key={r.days} className={range === r.days ? undefined : "secondary"} onClick={() => setRange(String(r.days))}>
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
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(String(e.target.checked))} />
          Overdue only
        </label>
        <label className="check"><input type="checkbox" checked={upcomingOnly} disabled={overdueOnly} onChange={(e) => setUpcomingOnly(String(e.target.checked))} />Upcoming only (excludes overdue)</label>
      </div>
      <LoadState load={first} label="company date" />
      <LoadState load={load} label="due visits" />
      {data && (
        <p className="muted">
          {plural(data.total, "open visit")} · {overdueCount} overdue · today is {day(data.today)}
        </p>
      )}
      <table className="stack">
        <thead>
          <tr>
            <th>Due</th>
            <th>Site</th>
            <th>Customer</th>
            <th>Visit</th>
            <th>Notes</th>
            {editable && <th />}
          </tr>
        </thead>
        <tbody>
          {data?.items.map((o) => (
            <tr key={o.id} className={o.overdue ? "overdue" : undefined}>
              <td data-label="Due">
                {day(o.dueOn)} {o.overdue && <Badge tone="danger">Overdue</Badge>}
                <div className="muted small">window from {day(o.windowStart, { month: "short", day: "numeric" })}</div>
              </td>
              <td data-label="Site">
                <Link href={`/sites/${o.site.id}`}>
                  {o.site.addressLine1}, {o.site.city}
                </Link>{" "}
                <SafetyBadges flags={o.site.safetyFlags} />
              </td>
              <td data-label="Customer">
                <Link href={`/customers/${o.customer.id}`}>{o.customer.displayName}</Link>
              </td>
              <td data-label="Visit">#{o.sequence}</td>
              <td data-label={o.site.schedulingNotes ? "Notes" : undefined} className="muted small">
                {o.site.schedulingNotes ?? ""}
              </td>
              {editable && (
                <td className="actions">
                  <Link className="button secondary" href={o.serviceType === "aerobic_inspection" ? `/schedule?obligationId=${o.id}&siteId=${o.site.id}` : `/sites/${o.site.id}?obligationId=${o.id}#obligation-${o.id}`}>
                    {o.job ? "View scheduled visit" : "Schedule"}
                  </Link>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {data?.items.length === 0 && (
        <EmptyState title="Nothing due in this range">
          Visits come from active contracts and the county&apos;s rules. Widen the range, or start a contract from a <Link href="/sites">site</Link>.
        </EmptyState>
      )}
      {data && <Pagination total={data.total} offset={offset} onChange={(n) => setOffset(String(n))} />}
    </div>
  );
}
