"use client";

import type { SiteListItem } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { SafetyBadges } from "@/components/SafetyBadges";
import { useLoad } from "@/components/useLoad";

const PAGE = 50;

export default function SitesPage() {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(search ? { search } : {}) });
  const { data } = useLoad<{ items: SiteListItem[]; total: number }>(`/sites?${query}`);

  return (
    <div className="stack">
      <h1>Sites</h1>
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
