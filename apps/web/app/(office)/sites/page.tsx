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
      <LoadState load={recordLoad} label="record" />
      <h1>{expiring === "true" ? "Sites with contracts expiring in 30 days" : "Sites"}</h1>
      {expiring === "true" && <Link href="/sites">View all sites</Link>}
      <input
        type="search"
        placeholder="Search by address, city or permit number"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOffset(0);
        }}
      />
      <table>
        <thead>
          <tr>
            <th>Address</th>
            <th>Customer</th>
            <th>Permit</th>
            <th>Access</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((s) => (
            <tr key={s.id}>
              <td>
                <Link href={`/sites/${s.id}`}>
                  {s.addressLine1}, {s.city}
                </Link>
              </td>
              <td>
                <Link href={`/customers/${s.customerId}`}>{s.customerName}</Link>
              </td>
              <td>{s.permitNumber ?? "—"}</td>
              <td>
                <SafetyBadges flags={s.safetyFlags} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && data.total === 0 && !search && (
        <EmptyState title="No sites yet">
          A site is a property with an aerobic system. Its address, permit and county decide which visits are due and where reports are filed. Add one from its{" "}
          <Link href="/customers">customer</Link>, or <Link href="/import">import</Link> them.
        </EmptyState>
      )}
      {data && (
        <div className="row muted">
          {data.total === 0 ? "No sites found" : `${offset + 1}–${Math.min(offset + PAGE, data.total)} of ${data.total}`}
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
