"use client";

import type { ComplianceEvent } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";
import { when } from "@/lib/format";


/** The site's compliance ledger, newest first. Report links are signed and short-lived, so they are fetched fresh with the list. */
export function ComplianceTimeline({ siteId, editable = false }: { siteId: string; editable?: boolean }) {
  const { data, error, reload } = useLoad<{ items: ComplianceEvent[] }>(`/sites/${siteId}/compliance-events`);
  const [message, setMessage] = useState<string | null>(null);

  /** Emails the customer copy. This is a delivery to the customer, never a filing. */
  async function emailCustomer(reportId: string) {
    const to = window.prompt("Email the customer's copy to (leave blank for the customer's billing contact):", "");
    if (to === null) return;
    setMessage(null);
    try {
      const res = await api<{ to: string }>(`/reports/${reportId}/send-to-customer`, { method: "POST", body: { to: to.trim() || null } });
      setMessage(`Queued to ${res.to}. The delivery record shows what the mail provider said.`);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Could not send");
    }
  }
  return (
    <section className="stack">
      <div className="row">
        <h2>Compliance history</h2>
        <span className="spacer" />
        <button className="link" onClick={() => void reload()}>
          Refresh
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {message && <p className="muted">{message}</p>}
      {data && data.items.length === 0 && <p className="muted">Nothing recorded yet. Completed inspections, reports and filings appear here.</p>}
      {data && data.items.length > 0 && (
        <ol className="timeline">
          {data.items.map((e) => (
            <li key={e.id}>
              <span className="muted small">{when(e.occurredAt)}</span>
              <span>
                {e.summary}
                {e.actorName && <span className="muted"> · {e.actorName}</span>}
                {e.filingId && (
                  <>
                    {" · "}
                    <Link href={`/filings/${e.filingId}`}>Filing</Link>
                  </>
                )}
                {e.report && (
                  <>
                    {" · "}
                    <a href={`/api${e.report.url}`} target="_blank" rel="noreferrer">
                      Open PDF
                    </a>
                    {editable && e.report.audience === "customer" && (
                      <>
                        {" · "}
                        <button className="link" onClick={() => void emailCustomer(e.report!.id)}>
                          Email to customer
                        </button>
                      </>
                    )}
                  </>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
