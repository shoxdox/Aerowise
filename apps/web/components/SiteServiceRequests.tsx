"use client";

import { REPORT_CLASSIFICATION_LABELS, REPORT_CLASSIFICATIONS, SERVICE_REQUEST_KINDS, SERVICE_REQUEST_LABELS, type ServiceRequestDetail } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, formValues } from "@/lib/api";
import { when } from "@/lib/format";

/**
 * Calls, portal requests and monitoring alerts at the site, each reviewed by a person:
 * an owner complaint or monitoring notice goes on the next authority report with the
 * response and whether it is resolved, everything else is marked not reportable. Nothing
 * is classified automatically. An inspection filing waits only for requests in its own
 * reporting period to be reviewed; an unanswered or unresolved complaint is reported as
 * outstanding rather than holding the filing.
 */
export function SiteServiceRequests({ siteId, editable }: { siteId: string; editable: boolean }) {
  const recordLoad = useLoad<{ items: ServiceRequestDetail[] }>(`/sites/${siteId}/service-requests`);
  const { data, reload } = recordLoad;
  const [logging, setLogging] = useState(false);
  const sending = useSubmit(
    async (path: string, body: object) => {
      await api(path, { method: "POST", body });
      await reload();
      return true;
    },
    { fallback: "Could not save." },
  );
  const send = async (path: string, body: object) => (await sending.run(path, body)) === true;

  function log(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    void send("/service-requests", { siteId, kind: v.kind, description: v.description, contactPhone: v.contactPhone ?? null, receivedAt: v.receivedAt ? new Date(v.receivedAt).toISOString() : undefined }).then(
      (ok) => ok && setLogging(false),
    );
  }

  if (!data) return <LoadState load={recordLoad} label="site service requests" />;
  const unreviewed = data.items.filter((r) => !r.classification).length;
  return (
    <section className="stack">
      <LoadState load={recordLoad} label="site service requests" />
      <div className="row">
        <h2>Complaints and requests</h2>
        {unreviewed > 0 && <Badge tone="warning">{unreviewed} to review for reporting</Badge>}
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
                  {SERVICE_REQUEST_LABELS[k]}
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
            <SubmitButton busy={sending.busy}>Log it</SubmitButton>
            <button type="button" className="link" onClick={() => setLogging(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <FormError error={sending.error} />
      {data.items.length === 0 && <p className="muted">None.</p>}
      {data.items.map((r) => (
        <RequestCard key={r.id} r={r} editable={editable} send={send} busy={sending.busy} />
      ))}
    </section>
  );
}

function RequestCard({ r, editable, send, busy }: { r: ServiceRequestDetail; editable: boolean; send: (path: string, body: object) => Promise<boolean>; busy: boolean }) {
  const [responding, setResponding] = useState(false);
  const reportable = r.classification === "owner_complaint" || r.classification === "monitoring_notice";
  return (
    <div className="card tight">
      <div className="row">
        <strong>{SERVICE_REQUEST_LABELS[r.kind]}</strong>
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
            disabled={busy}
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
              {r.responseAction} ({when(r.respondedAt)}){" "}
              {r.responseOutcome === "resolved" ? <Badge tone="success">Resolved</Badge> : <Badge tone="warning">Still outstanding</Badge>}
            </>
          ) : (
            <span className="restriction">None recorded. Reports to the authority say it is outstanding until a response is recorded.</span>
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
            void send(`/service-requests/${r.id}/response`, { action: v.action, respondedAt: new Date(v.respondedAt!).toISOString(), outcome: v.outcome }).then((ok) => ok && setResponding(false));
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
          <label>
            Is the problem resolved?
            <select name="outcome" defaultValue={r.responseOutcome ?? "resolved"}>
              <option value="resolved">Resolved</option>
              <option value="outstanding">Still outstanding (part on order, repair scheduled)</option>
            </select>
          </label>
          <div className="row">
            <SubmitButton busy={busy}>Save</SubmitButton>
            <button type="button" className="link" onClick={() => setResponding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
