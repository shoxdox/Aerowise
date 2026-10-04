"use client";

import { REPORT_CLASSIFICATION_LABELS, REPORT_CLASSIFICATIONS, SERVICE_REQUEST_KINDS, type ServiceRequestDetail } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { when } from "@/lib/format";

/**
 * Calls, portal requests and monitoring alerts at the site, each reviewed by a person:
 * an owner complaint or monitoring notice goes on the next authority report with the
 * response, everything else is marked not reportable. Nothing is classified automatically,
 * and an inspection filing waits until every request since the last report is reviewed.
 */
export function SiteServiceRequests({ siteId, editable }: { siteId: string; editable: boolean }) {
  const { data, reload } = useLoad<{ items: ServiceRequestDetail[] }>(`/sites/${siteId}/service-requests`);
  const [error, setError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);

  async function send(path: string, body: object) {
    setError(null);
    try {
      await api(path, { method: "POST", body });
      await reload();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
      return false;
    }
  }

  function log(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    void send("/service-requests", { siteId, kind: v.kind, description: v.description, contactPhone: v.contactPhone ?? null, receivedAt: v.receivedAt ? new Date(v.receivedAt).toISOString() : undefined }).then(
      (ok) => ok && setLogging(false),
    );
  }

  if (!data) return null;
  const unreviewed = data.items.filter((r) => !r.classification).length;
  return (
    <section className="stack">
      <div className="row">
        <h2>Complaints and requests</h2>
        {unreviewed > 0 && <span className="badge warn">{unreviewed} to review for reporting</span>}
        <span className="spacer" />
        {editable && !logging && (
          <button className="secondary" onClick={() => setLogging(true)}>
            Log a call or alert
          </button>
        )}
      </div>
      {logging && (
        <form className="card stack" onSubmit={log}>
          <label>
            Kind
            <select name="kind" defaultValue="odor">
              {SERVICE_REQUEST_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label>
            What they said, or what the alert was
            <textarea name="description" required rows={2} />
          </label>
          <label>
            Received
            <input name="receivedAt" type="datetime-local" />
          </label>
          <label>
            Phone
            <input name="contactPhone" />
          </label>
          <div className="row">
            <button type="submit">Log it</button>
            <button type="button" className="link" onClick={() => setLogging(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      {data.items.length === 0 && <p className="muted">None.</p>}
      {data.items.map((r) => (
        <RequestCard key={r.id} r={r} editable={editable} send={send} />
      ))}
    </section>
  );
}

function RequestCard({ r, editable, send }: { r: ServiceRequestDetail; editable: boolean; send: (path: string, body: object) => Promise<boolean> }) {
  const [responding, setResponding] = useState(false);
  const reportable = r.classification === "owner_complaint" || r.classification === "monitoring_notice";
  return (
    <div className="card tight">
      <div className="row">
        <strong>{r.kind}</strong>
        <span className="muted small">
          {when(r.receivedAt)} · {r.source === "portal" ? "customer portal" : "logged by the office"}
        </span>
      </div>
      <p>{r.description}</p>
      <div className="small">
        Reporting:{" "}
        {editable ? (
          <select
            aria-label="Reporting classification"
            value={r.classification ?? ""}
            onChange={(e) => e.target.value && void send(`/service-requests/${r.id}/classify`, { classification: e.target.value })}
          >
            <option value="" disabled>
              Not reviewed yet
            </option>
            {REPORT_CLASSIFICATIONS.map((c) => (
              <option key={c} value={c}>
                {REPORT_CLASSIFICATION_LABELS[c]}
              </option>
            ))}
          </select>
        ) : r.classification ? (
          REPORT_CLASSIFICATION_LABELS[r.classification]
        ) : (
          <span className="restriction">Not reviewed yet</span>
        )}
      </div>
      {reportable && (
        <div className="small">
          Response:{" "}
          {r.responseAction ? (
            <>
              {r.responseAction} ({when(r.respondedAt)})
            </>
          ) : (
            <span className="restriction">None recorded; the next authority report waits for it</span>
          )}
          {editable && !responding && (
            <>
              {" "}
              <button className="link" onClick={() => setResponding(true)}>
                {r.responseAction ? "Change" : "Record response"}
              </button>
            </>
          )}
        </div>
      )}
      {responding && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const v = formValues(event.currentTarget);
            void send(`/service-requests/${r.id}/response`, { action: v.action, respondedAt: new Date(v.respondedAt!).toISOString() }).then((ok) => ok && setResponding(false));
          }}
        >
          <label>
            What was done
            <input name="action" required defaultValue={r.responseAction ?? ""} />
          </label>
          <label>
            When
            <input name="respondedAt" type="datetime-local" required />
          </label>
          <div className="row">
            <button type="submit">Save</button>
            <button type="button" className="link" onClick={() => setResponding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
