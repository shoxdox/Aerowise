"use client";

import type { OnboardingSummary as Summary } from "@aerowise/domain";
import Link from "next/link";
import { useLoad } from "@/components/useLoad";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function Tile({ n, label, href, alert = false }: { n: number; label: string; href?: string; alert?: boolean }) {
  const body = (
    <>
      <strong>{n}</strong>
      <span>{label}</span>
    </>
  );
  const className = `card tile${alert && n > 0 ? " alert" : ""}`;
  return href ? (
    <Link className={className} href={href}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

function SiteList({ title, total, sites }: { title: string; total: number; sites: Summary["examples"]["withoutPermit"] }) {
  if (total === 0) return null;
  return (
    <div className="card">
      <strong>{title}</strong>
      <ul>
        {sites.map((s) => (
          <li key={s.id}>
            <Link href={`/sites/${s.id}`}>
              {s.addressLine1}, {s.city}
            </Link>{" "}
            <span className="muted">{s.customerName}</span>
          </li>
        ))}
      </ul>
      {total > sites.length && <p className="muted">and {total - sites.length} more</p>}
    </div>
  );
}

/** The book at a glance: what is active, what renews soon, what is late, what is missing. */
export function OnboardingSummary({ importId }: { importId?: string }) {
  const { data: s, error } = useLoad<Summary>(`/onboarding/summary${importId ? `?importId=${importId}` : ""}`);
  if (error) return <p className="error">{error}</p>;
  if (!s) return <p className="muted">Loading the summary…</p>;
  return (
    <div className="stack">
      <p className="muted">
        {plural(s.customers, "customer")} with {plural(s.sites, "service site")}
        {importId ? " from this import" : ""}, as of {s.today}.
      </p>
      <div className="tiles">
        <Tile n={s.activeContracts} label="Active contracts" href="/renewals" />
        <Tile n={s.expiring.within30} label="Expiring in 30 days" href="/renewals" />
        <Tile n={s.expiring.within60} label="Expiring in 60 days" href="/renewals" />
        <Tile n={s.expiring.within90} label="Expiring in 90 days" href="/renewals" />
        <Tile n={s.overdueVisits} label="Inspections overdue" href="/due" alert />
        <Tile n={s.dueThisMonth} label="Inspections due this month" href="/due" />
        <Tile n={s.sitesWithoutAuthority} label="Sites with no authority" alert />
        <Tile n={s.sitesWithoutPermit} label="Missing permit numbers" alert />
      </div>
      <SiteList title="Sites with no authority" total={s.sitesWithoutAuthority} sites={s.examples.withoutAuthority} />
      <SiteList title="Sites missing a permit number" total={s.sitesWithoutPermit} sites={s.examples.withoutPermit} />
    </div>
  );
}
