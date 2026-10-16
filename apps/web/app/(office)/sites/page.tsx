"use client";

import type { SiteListItem } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { SafetyBadges } from "@/components/SafetyBadges";
import { useQueryState } from "@/components/useQueryState";
import { LoadState } from "@/components/LoadState";
import { useLoad } from "@/components/useLoad";
import { EmptyState } from "@/components/EmptyState";

const PAGE = 50;

export default function SitesPage() {
  const [expiring] = useQueryState("contractsExpiring", "false");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(search ? { search } : {}), ...(expiring === "true" ? { contractsExpiring: "true" } : {}) });
  const recordLoad = useLoad<{ items: SiteListItem[]; total: number }>(`/sites?${query}`);
  const { data } = recordLoad;

  return (
    <div className="stack">
      <h1>{expiring === "true" ? "Sites with contracts expiring in 30 days" : "Sites"}</h1>
      {expiring === "true" && <Link href="/sites">View all sites</Link>}
      <input
        type="search"
        aria-label="Search sites"
        placeholder="Search by address, city or permit number"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOffset(0);
        }}
      />
      <LoadState load={recordLoad} label="sites" />
      {data && data.items.length > 0 && (
        <table className="stack">
          <thead>
            <tr>
              <th>Address</th>
              <th>Customer</th>
              <th>Permit</th>
              <th>Access</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((s) => (
              <tr key={s.id}>
                <td data-label="Address">
                  <Link href={`/sites/${s.id}`}>
                    {s.addressLine1}, {s.city}
                  </Link>
                </td>
                <td data-label="Customer">
                  <Link href={`/customers/${s.customerId}`}>{s.customerName}</Link>
                </td>
                <td data-label="Permit">{s.permitNumber ?? "—"}</td>
                <td data-label="Access">
                  <SafetyBadges flags={s.safetyFlags} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.total === 0 && !search && (
        <EmptyState title={expiring === "true" ? "No contracts expire in the next 30 days" : "No sites yet"}>
          {expiring === "true" ? (
            "Sites show here when one of their contracts ends within 30 days, so you can renew it in time."
          ) : (
            <>
              A site is a property with an aerobic system. Its address, permit and county decide which visits are due and where reports are filed. Add one from its{" "}
              <Link href="/customers">customer</Link>, or <Link href="/import">import</Link> them.
            </>
          )}
        </EmptyState>
      )}
      {data && data.total === 0 && search && <p className="muted">No sites match “{search}”.</p>}
      {data && data.total > 0 && (
        <div className="row muted">
          {`${offset + 1}–${Math.min(offset + PAGE, data.total)} of ${data.total}`}
          <span className="spacer" />
          <button className="secondary" disabled={offset === 0} onClick={() => setOffset(offset - PAGE)}>
            Previous
          </button>
          <button className="secondary" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
