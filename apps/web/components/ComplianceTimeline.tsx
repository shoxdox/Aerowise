"use client";

import type { ComplianceEvent } from "@aerowise/domain";
import Link from "next/link";
import { useLoad } from "@/components/useLoad";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** The site's compliance ledger, newest first. Report links are signed and short-lived, so they are fetched fresh with the list. */
export function ComplianceTimeline({ siteId }: { siteId: string }) {
  const { data, error, reload } = useLoad<{ items: ComplianceEvent[] }>(`/sites/${siteId}/compliance-events`);
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
