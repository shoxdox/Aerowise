"use client";

import type { FilingListItem } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { DeadlineCell, FilingStatusBadge } from "@/components/FilingBadges";
import { useLoad } from "@/components/useLoad";
import { day, dayOf } from "@/lib/format";
import { EmptyState } from "@/components/EmptyState";

const VIEWS = [
  { key: "attention", label: "Needs attention" },
  { key: "open", label: "Not sent yet" },
  { key: "sent", label: "Waiting for acknowledgment" },
  { key: "confirmed", label: "Acknowledged" },
  { key: "all", label: "All" },
] as const;

const FILINGS_EMPTY: Record<(typeof VIEWS)[number]["key"], string> = {
  attention: "Nothing is late, failed or waiting on you. Today is {today}.",
  open: "Nothing is waiting to be sent. A filing starts here when a technician finishes an inspection at a site whose authority takes reports.",
  sent: "Nothing is waiting on an authority. Sent filings wait here until you record the authority's acknowledgment.",
  confirmed: "Nothing acknowledged yet. Record the authority's reply on a sent filing to finish it.",
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
  const [view, setView] = useState<(typeof VIEWS)[number]["key"]>("attention");
  const { data, error } = useLoad<{ items: FilingListItem[]; today: string }>(`/filings?view=${view}`);

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
        Completed inspections, and maintenance contracts where the authority asks for them, are filed with the site&apos;s reporting authority. Sent is not done: a filing counts as done only once the authority&apos;s acknowledgment is recorded.
      </p>
      {error && <p className="error">{error}</p>}
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
    </div>
  );
}
