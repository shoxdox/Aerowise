"use client";

import type { ComplianceEvent } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { Pagination } from "@/components/Pagination";
import { LoadState } from "@/components/LoadState";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { plural, when } from "@/lib/format";

/** The site's compliance ledger, newest first. Report links are signed and short-lived, so they are fetched fresh with the list. */
export function ComplianceTimeline({ siteId, editable = false }: { siteId: string; editable?: boolean }) {
  const [offset, setOffset] = useState(0);
  const recordLoad = useLoad<{ items: ComplianceEvent[]; total: number }>(`/sites/${siteId}/compliance-events?limit=50&offset=${offset}`);
  const { data, reload } = recordLoad;
  const [message, setMessage] = useState<string | null>(null);
  // The report whose customer copy is being emailed: asked right on its line, not in a pop-up.
  const [emailing, setEmailing] = useState<string | null>(null);

  /** Emails the customer copy. This is a delivery to the customer, never a filing. */
  const sending = useSubmit(
    async (v: Record<string, string | undefined>) => {
      if (!emailing) return;
      setMessage(null);
      const res = await api<{ to: string }>(`/reports/${emailing}/send-to-customer`, { method: "POST", body: { to: v.to ?? null } });
      setEmailing(null);
      setMessage(`Queued to ${res.to}. The delivery record shows what the mail provider said.`);
    },
    { fallback: "Could not send the report." },
  );
  return (
    <details className="card"><summary>Report and filing history{data ? ` (${plural(data.total, "record")})` : ""}</summary><section className="stack">
      <LoadState load={recordLoad} label="compliance history" />
      <div className="row">
        <h2>Compliance history{data ? ` (${data.total})` : ""}</h2>
        <span className="spacer" />
        <button className="link" onClick={() => void reload()}>
          Refresh
        </button>
      </div>
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
                    {editable && e.report.audience === "customer" && emailing !== e.report.id && (
                      <>
                        {" · "}
                        <button className="link" onClick={() => (sending.clear(), setEmailing(e.report!.id))}>
                          Email to customer
                        </button>
                      </>
                    )}
                  </>
                )}
                {e.report && emailing === e.report.id && (
                  <form className="row" onSubmit={sending.form}>
                    <label>
                      Email the customer&apos;s copy to
                      <input name="to" type="email" placeholder="The customer's billing contact" autoFocus />
                    </label>
                    <SubmitButton busy={sending.busy} busyLabel="Sending…">
                      Send
                    </SubmitButton>
                    <button type="button" className="link" onClick={() => setEmailing(null)}>
                      Cancel
                    </button>
                    <FormError error={sending.error} />
                  </form>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {data && <Pagination total={data.total} offset={offset} onChange={setOffset} />}
    </section></details>
  );
}
