"use client";

import { SERVICE_REQUEST_LABELS, type PortalAccess, type ServiceRequest } from "@aerowise/domain";
import { useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Pagination } from "@/components/Pagination";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { phone, plural, when } from "@/lib/format";

/** The customer's portal access and what they have asked for from it. */
export function CustomerPortal({ customerId, editable }: { customerId: string; editable: boolean }) {
  const recordLoad = useLoad<PortalAccess>(`/customers/${customerId}/portal`);
  const { data: access, reload } = recordLoad;
  const [requestOffset, setRequestOffset] = useState(0);
  const requestLoad = useLoad<{ items: ServiceRequest[]; total: number }>(`/service-requests?customerId=${customerId}&limit=50&offset=${requestOffset}`);
  const { data: requests, reload: reloadRequests } = requestLoad;
  const [url, setUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const acting = useSubmit(
    async (fn: () => Promise<void>) => {
      setMessage(null);
      await fn();
      await reload();
    },
    { fallback: "Could not reach Aerowise. Try again." },
  );
  const run = (fn: () => Promise<void>) => acting.run(fn);
  const busy = acting.busy;

  const copy = () =>
    run(async () => {
      const link = await api<{ url: string }>(`/customers/${customerId}/portal-link`, { method: "POST", body: { send: false } });
      setUrl(link.url);
      await navigator.clipboard?.writeText(link.url).catch(() => undefined);
    });
  const email = () =>
    run(async () => {
      const link = await api<{ sentTo: string }>(`/customers/${customerId}/portal-link`, { method: "POST", body: { send: true } });
      setUrl(null);
      setMessage(`Portal link emailed to ${link.sentTo}.`);
    });
  const revoke = () =>
    run(async () => {
      const { revoked } = await api<{ revoked: number }>(`/customers/${customerId}/portal-links/revoke`, { method: "POST", body: {} });
      setUrl(null);
      setMessage(`${plural(revoked, "link")} turned off.`);
    });

  const closing = useSubmit(
    async ({ resolution }: Record<string, string | undefined>) => {
      await api(`/service-requests/${resolving}/resolve`, { method: "POST", body: { resolution } });
      setResolving(null);
      await reloadRequests();
    },
    { fallback: "Could not close it." },
  );
  const error = acting.error ?? closing.error;

  return (
    <section className="stack">
      <LoadState load={recordLoad} label="customer portal access" />
      <h2>Customer portal</h2>
      <LoadState load={requestLoad} label="customer service requests" />
      <div className="card stack">
        {access && (
          <p className="muted small">
            {access.activeLinks === 0 ? "No working portal link." : `${plural(access.activeLinks, "working portal link")}.`}{" "}
            {access.lastUsedAt ? `Last opened ${when(access.lastUsedAt)}.` : "Never opened."}
          </p>
        )}
        {url && (
          <div className="stack">
            <span className="small">Copied. This link is shown only once:</span>
            <code className="portal-url">{url}</code>
          </div>
        )}
        {message && <p className="ok-text">{message}</p>}
        <FormError error={error} />
        {editable && (
          <div className="row">
            <SubmitButton type="button" className="secondary" busy={busy} busyLabel="Working…" disabled={!access?.email} onClick={() => void email()} title={access?.email ? undefined : "No email on file"}>
              Email portal link
            </SubmitButton>
            <SubmitButton type="button" className="secondary" busy={busy} busyLabel="Working…" onClick={() => void copy()}>
              Copy portal link
            </SubmitButton>
            {access && access.activeLinks > 0 && (
              <ConfirmButton className="link danger" question="Turn off every portal link this customer has? They can ask for a new one by email." confirmLabel="Turn off links" busy={busy} onConfirm={() => revoke()}>
                Turn off links
              </ConfirmButton>
            )}
          </div>
        )}
      </div>

      {requests && (requests.total > 0 || requestOffset > 0) && (
        <div className="card stack">
          <h3>Service requests</h3>
          <Pagination total={requests.total} offset={requestOffset} onChange={setRequestOffset} />
          {requests.items.map((r) => (
            <div key={r.id} className="stack">
              <div className="row">
                <strong>{SERVICE_REQUEST_LABELS[r.kind]}</strong>
                <Badge tone={r.status === "open" ? "warning" : "success"}>{r.status === "open" ? "Open" : "Closed"}</Badge>
                <span className="muted small">
                  {r.site.addressLine1} · {when(r.createdAt)}
                </span>
              </div>
              <div>{r.description}</div>
              {r.contactPhone && <div className="small">Call <a href={`tel:${r.contactPhone}`}>{phone(r.contactPhone)}</a></div>}
              {r.resolution && <div className="muted small">Done: {r.resolution}</div>}
              {editable && r.status === "open" && (resolving === r.id ? (
                <form className="row" onSubmit={closing.form}>
                  <input name="resolution" aria-label="What was done" placeholder="What was done" required />
                  <SubmitButton busy={closing.busy}>Close</SubmitButton>
                </form>
              ) : (
                <button className="link" onClick={() => setResolving(r.id)}>
                  Close request
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
