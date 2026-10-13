"use client";

import type { FilingListItem } from "@aerowise/domain";
import Link from "next/link";
import { useQueryState } from "@/components/useQueryState";
import { Pagination } from "@/components/Pagination";
import { LoadState } from "@/components/LoadState";
import { DeadlineCell, FilingStatusBadge } from "@/components/FilingBadges";
import { useLoad } from "@/components/useLoad";
import { day, dayOf } from "@/lib/format";
import { EmptyState } from "@/components/EmptyState";

const VIEWS = [
  { key: "attention", label: "Needs attention" },
  { key: "open", label: "Not sent yet" },
  { key: "sent", label: "Submitted" },
  { key: "confirmed", label: "Acknowledgment recorded" },
  { key: "all", label: "All" },
] as const;

const FILINGS_EMPTY: Record<(typeof VIEWS)[number]["key"], string> = {
  attention: "Nothing is late, failed or waiting on you. Today is {today}.",
  open: "Nothing is waiting to be sent. A filing starts here when a technician finishes an inspection at a site whose authority takes reports.",
  sent: "No submitted filings here. Submission evidence is retained; record acknowledgment only when there is evidence.",
  confirmed: "Nothing acknowledged yet. Record an authority's reply on a submitted filing when acknowledgment is available.",
  all: "No filings yet. They start when a technician finishes an inspection at a site whose authority takes reports.",
};

const when = dayOf;

/** What the office should know about a filing, in a few words. */
function note(f: FilingListItem) {
  if (f.status === "needs_review") return f.reviewReason;
  if (f.status === "failed") return `${f.lastError ?? "Sending failed"} · ${f.attemptCount} tr${f.attemptCount === 1 ? "y" : "ies"}`;
  if (f.status === "confirmed") return f.confirmationReference ? `Reference ${f.confirmationReference}` : null;
  if (f.status === "sent" && f.sentAt) return `Sent ${when(f.sentAt)}`;
  return null;
}

export default function FilingsPage() {
  const [selectedView, setView] = useQueryState("view", "attention");
  const view = VIEWS.find((v) => v.key === selectedView)?.key ?? "attention";
  const [offsetText, setOffset] = useQueryState("offset", "0");
  const offset = Number.isSafeInteger(Number(offsetText)) && Number(offsetText) >= 0 ? Number(offsetText) : 0;
  const load = useLoad<{ items: FilingListItem[]; today: string; total: number }>(`/filings?view=${view}&limit=50&offset=${offset}`);
  const { data } = load;

  return (
    <div className="stack">
      <div className="row">
        <h1>Filings</h1>
        <Link href="/settings/credentials" className="small">
          Licenses and registrations
        </Link>
        <span className="spacer" />
        {VIEWS.map((v) => (
          <button key={v.key} className={view === v.key ? undefined : "secondary"} onClick={() => setView(v.key)}>
            {v.label}
          </button>
        ))}
      </div>
      <p className="muted">
        Completed inspections await office review and the provider&apos;s signature, then follow the authority&apos;s actual email, manual or CSV submission method. Submitted means submission evidence is recorded. Some authorities publish no acknowledgment process; acceptance is only claimed when supported by evidence.
      </p>
      <LoadState load={load} label="filings" />
      <table>
        <thead>
          <tr>
            <th>Deadline</th>
            <th>Site</th>
            <th>Authority</th>
            <th>For</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((f) => (
            <tr key={f.id} className={f.deadlineState === "overdue" ? "overdue" : undefined}>
              <td>
                <DeadlineCell deadlineOn={f.deadlineOn} state={f.deadlineState} />
              </td>
              <td>
                <Link href={`/filings/${f.id}`}>
                  {f.site.addressLine1}, {f.site.city}
                </Link>
                <div className="muted small">{f.customer.displayName}</div>
              </td>
              <td>{f.jurisdiction?.authorityName ?? <span className="muted">None matched</span>}</td>
              <td>{f.contract ? `Contract from ${day(f.contract.startOn)}` : `Inspection ${when(f.inspection?.completedAt ?? null)}`}</td>
              <td>
                <FilingStatusBadge status={f.status} />
                {note(f) && <div className="muted small">{note(f)}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.items.length === 0 && (
        <EmptyState title={view === "attention" ? "Nothing needs attention" : "No filings here"}>{FILINGS_EMPTY[view].replace("{today}", day(data.today))}</EmptyState>
      )}
      {data && <Pagination total={data.total} offset={offset} onChange={(n) => setOffset(String(n))} />}
    </div>
  );
}
