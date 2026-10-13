"use client";

import Link from "next/link";
import { useState } from "react";
import { LoadState } from "@/components/LoadState";
import { Pagination } from "@/components/Pagination";
import { useLoad } from "@/components/useLoad";
import { day } from "@/lib/format";

export function CustomerNextActions({ customerId }: { customerId: string }) {
  const [offset, setOffset] = useState(0);
  const load = useLoad<{ items: { id: string; addressLine1: string; city: string; active: boolean; nextVisit: string | null; dueOn: string | null; openIssues: number }[]; total: number }>(`/customers/${customerId}/overview?limit=50&offset=${offset}`);
  const data = load.data;
  return <section className="card stack"><h2>Next actions by service site</h2><LoadState load={load} label="customer next actions" />{data && data.items.length === 0 && <p>Add the first service site below, then its system, authority and contract.</p>}{data?.items.map((s) => <div key={s.id} className="row"><div><strong>{s.addressLine1}, {s.city}</strong><p className="muted small">{s.nextVisit ? `Next visit ${day(s.nextVisit)}` : s.dueOn ? `Unscheduled visit due ${day(s.dueOn)}` : "No open visit recorded"} · {s.openIssues} open issue{s.openIssues === 1 ? "" : "s"}{!s.active && " · inactive site"}</p></div><span className="spacer" /><Link className="button secondary" href={`/sites/${s.id}`}>Review site and next action</Link></div>)}{data && data.total > 50 && <Pagination total={data.total} offset={offset} onChange={setOffset} />}</section>;
}
