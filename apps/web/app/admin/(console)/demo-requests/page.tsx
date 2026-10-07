"use client";

import type { DemoRequest } from "@aerowise/domain";
import { useState } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Chicago" });

function EmailStatus({ r }: { r: DemoRequest }) {
  // The local outbox (staging, demo, development) keeps the message in file storage: nobody got it.
  if (r.notifiedAt && r.notifyDelivery === "outbox")
    return (
      <span className="badge inactive" title="Kept in this deployment's local test outbox. No email was delivered.">
        Recorded in test outbox
      </span>
    );
  if (r.notifiedAt && r.notifyDelivery === "provider") return <span className="badge ok">Emailed</span>;
  // Sent before Aerowise recorded where alerts go: it may have stayed in the outbox.
  if (r.notifiedAt)
    return (
      <span className="badge inactive" title="Sent before Aerowise recorded whether alerts go to a mail provider or the test outbox.">
        Sent (delivery not recorded)
      </span>
    );
  if (r.notifyError) return <span className="badge danger" title={r.notifyError}>Email failed</span>;
  return <span className="badge inactive">Not emailed</span>;
}

/** Requests from the public marketing page, newest first. */
export default function DemoRequestsPage() {
  const { data, error, reload } = useLoad<{ items: DemoRequest[] }>("/admin/demo-requests");
  const [actionError, setActionError] = useState<string | null>(null);

  async function setStatus(r: DemoRequest, status: DemoRequest["status"]) {
    setActionError(null);
    try {
      await api(`/admin/demo-requests/${r.id}/status`, { method: "PUT", body: { status } });
      await reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not update the request");
    }
  }

  return (
    <div className="stack">
      <h1>Demo requests</h1>
      {(error || actionError) && <p className="error">{error ?? actionError}</p>}
      {data && data.items.length === 0 && <p className="muted">No demo requests yet.</p>}
      {data &&
        data.items.map((r) => (
          <article key={r.id} className={`card stack${r.status === "handled" ? " muted" : ""}`} aria-label={`Demo request from ${r.company}`}>
            <div className="row">
              <strong>{r.company}</strong>
              <span className="badges">
                {r.status === "new" ? <span className="badge upcoming">New</span> : <span className="badge completed">Handled</span>}
                <EmailStatus r={r} />
              </span>
              <span className="spacer" />
              <span className="muted small">{when(r.createdAt)}</span>
            </div>
            <dl className="details">
              <dt>Name</dt>
              <dd>{r.name}</dd>
              <dt>Email</dt>
              <dd>
                <a href={`mailto:${r.email}`}>{r.email}</a>
              </dd>
              <dt>Phone</dt>
              <dd>{r.phone ?? "—"}</dd>
              <dt>Counties</dt>
              <dd>{r.counties ?? "—"}</dd>
            </dl>
            {r.message && <p className="message">{r.message}</p>}
            {r.notifyError && <p className="error small">Email failed: {r.notifyError}</p>}
            <div className="row">
              {r.status === "new" ? (
                <button className="secondary" onClick={() => setStatus(r, "handled")}>
                  Mark handled
                </button>
              ) : (
                <button className="link" onClick={() => setStatus(r, "new")}>
                  Mark as new
                </button>
              )}
            </div>
          </article>
        ))}
    </div>
  );
}
