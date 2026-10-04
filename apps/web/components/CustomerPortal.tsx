"use client";

import { SERVICE_REQUEST_LABELS, type PortalAccess, type ServiceRequest } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { when } from "@/lib/format";

/** The customer's portal access and what they have asked for from it. */
export function CustomerPortal({ customerId, editable }: { customerId: string; editable: boolean }) {
  const { data: access, reload } = useLoad<PortalAccess>(`/customers/${customerId}/portal`);
  const { data: requests, reload: reloadRequests } = useLoad<{ items: ServiceRequest[] }>(`/service-requests?customerId=${customerId}`);
  const [url, setUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

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
      if (!window.confirm("Turn off every portal link this customer has? They can ask for a new one by email.")) return;
      const { revoked } = await api<{ revoked: number }>(`/customers/${customerId}/portal-links/revoke`, { method: "POST", body: {} });
      setUrl(null);
      setMessage(revoked === 1 ? "1 link turned off." : `${revoked} links turned off.`);
    });

  async function resolve(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const { resolution } = formValues(event.currentTarget);
    try {
      await api(`/service-requests/${id}/resolve`, { method: "POST", body: { resolution } });
      setResolving(null);
      await reloadRequests();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not close it");
    }
  }

  return (
    <section className="stack">
      <h2>Customer portal</h2>
      <div className="card stack">
        {access && (
          <p className="muted small">
            {access.activeLinks === 0 ? "No working portal link." : access.activeLinks === 1 ? "1 working portal link." : `${access.activeLinks} working portal links.`}{" "}
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
        {error && <p className="error">{error}</p>}
        {editable && (
          <div className="row">
            <button className="secondary" disabled={busy || !access?.email} onClick={() => void email()} title={access?.email ? undefined : "No email on file"}>
              Email portal link
            </button>
            <button className="secondary" disabled={busy} onClick={() => void copy()}>
              Copy portal link
            </button>
            {access && access.activeLinks > 0 && (
              <button className="link" disabled={busy} onClick={() => void revoke()}>
                Turn off links
              </button>
            )}
          </div>
        )}
      </div>

      {requests && requests.items.length > 0 && (
        <div className="card stack">
          <h3>Service requests</h3>
          {requests.items.map((r) => (
            <div key={r.id} className="stack">
              <div className="row">
                <strong>{SERVICE_REQUEST_LABELS[r.kind]}</strong>
                <span className={`badge ${r.status === "open" ? "warn" : "ok"}`}>{r.status}</span>
                <span className="muted small">
                  {r.site.addressLine1} · {when(r.createdAt)}
                </span>
              </div>
              <div>{r.description}</div>
              {r.contactPhone && <div className="small">Call {r.contactPhone}</div>}
              {r.resolution && <div className="muted small">Done: {r.resolution}</div>}
              {editable && r.status === "open" && (resolving === r.id ? (
                <form className="row" onSubmit={(e) => void resolve(e, r.id)}>
                  <input name="resolution" aria-label="What was done" placeholder="What was done" required />
                  <button type="submit">Close</button>
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
