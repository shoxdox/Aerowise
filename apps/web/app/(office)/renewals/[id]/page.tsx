"use client";

import { isSignable, type Plan, type RenewalDetail } from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { RenewalBadge } from "@/components/RenewalBadge";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day, money, when } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

const FREQUENCY: Record<RenewalDetail["terms"]["billingFrequency"], string> = { annual: "yearly", semiannual: "twice a year", quarterly: "quarterly", monthly: "monthly" };

export default function RenewalPage() {
  const { id } = useParams<{ id: string }>();
  const editable = canEdit(useSession());
  const { data: r, error, reload } = useLoad<RenewalDetail>(`/renewals/${id}`);
  const plans = useLoad<{ items: Plan[] }>(editable ? "/plans" : null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function run(action: () => Promise<unknown>, done?: string) {
    setActionError(null);
    setNotice(null);
    try {
      await action();
      setEditing(false);
      if (done) setNotice(done);
      await reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!r) return <p className="muted">Loading…</p>;

  const signable = isSignable(r.status);
  const canActivate =
    editable && ((!!r.signedDocument && ["signed", "payment_pending", "paid", "needs_review"].includes(r.status)) || (r.autoRenewContract && (signable || r.status === "needs_review")));

  function onEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    const planId = v.planId !== r!.terms.planId ? v.planId : undefined;
    const priceCents = v.price ? Math.round(Number(v.price) * 100) : undefined;
    void run(() => api(`/renewals/${id}`, { method: "PATCH", body: { planId, priceCents } }), "Offer updated. A customer with the page open is asked to review it again.");
  }

  function decline() {
    const reason = window.prompt("Why is the customer not renewing? (optional)");
    if (reason !== null) void run(() => api(`/renewals/${id}/decline`, { method: "POST", body: { reason: reason || null } }));
  }

  function activate() {
    const message = r!.signedDocument
      ? "Start the next term now, without waiting for payment?"
      : "This contract auto-renews. Start the next term without a new signature? Its first installment is billed as usual.";
    if (window.confirm(message)) void run(() => api(`/renewals/${id}/activate`, { method: "POST", body: {} }));
  }

  async function copyLink() {
    await navigator.clipboard?.writeText(r!.link).catch(() => undefined);
    setNotice("Link copied. Paste it into a text or email to the customer.");
  }

  return (
    <div className="stack">
      <div className="row">
        <Link href="/renewals">Renewals</Link>
      </div>
      <div className="row">
        <h1>{r.customer.displayName}</h1>
        <RenewalBadge status={r.status} />
        <span className="spacer" />
        {editable && signable && (
          <button onClick={() => void run(() => api(`/renewals/${id}/send`, { method: "POST", body: {} }), "Renewal emailed.")} disabled={!r.email}>
            {r.sendCount > 0 ? "Email again" : "Email link"}
          </button>
        )}
        {signable && (
          <button className="secondary" onClick={() => void copyLink()}>
            Copy link
          </button>
        )}
        {canActivate && (
          <button className="secondary" onClick={activate}>
            {r.signedDocument ? "Activate now" : "Auto-renew now"}
          </button>
        )}
        {editable && (signable || r.status === "needs_review") && (
          <button className="link" onClick={decline}>
            Mark declined
          </button>
        )}
      </div>
      {notice && <p>{notice}</p>}
      {actionError && <p className="error">{actionError}</p>}
      {r.reviewReason && <p className="error">Needs review: {r.reviewReason}</p>}
      {signable && !r.email && <p className="muted">The customer has no email on file. Copy the link and send it another way, or add an email to a contact.</p>}

      <div className="columns">
        <div className="card stack">
          <div className="row">
            <h2>Offer</h2>
            <span className="spacer" />
            {editable && signable && (
              <button className="link" onClick={() => setEditing((e) => !e)}>
                {editing ? "Cancel" : "Change offer"}
              </button>
            )}
          </div>
          {editing ? (
            <form className="stack" onSubmit={onEdit}>
              <label>
                Plan
                <select name="planId" defaultValue={r.terms.planId ?? ""}>
                  {!r.terms.planId && <option value="">{r.terms.planName} (current terms)</option>}
                  {plans.data?.items
                    .filter((p) => p.active || p.id === r.terms.planId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}: {p.termMonths} months, {money(p.priceCents)}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Price for the term ($)
                <input name="price" type="number" min={0} step="0.01" placeholder={(r.terms.priceCents / 100).toFixed(2)} />
              </label>
              <button type="submit">Save offer</button>
            </form>
          ) : (
            <dl className="details">
              <dt>Plan</dt>
              <dd>{r.terms.planName}</dd>
              <dt>Term</dt>
              <dd>
                {day(r.terms.startOn)} to {day(r.terms.endOn)}
              </dd>
              <dt>Visits</dt>
              <dd>{r.terms.visitsPerTerm}</dd>
              <dt>Price</dt>
              <dd>
                {money(r.terms.priceCents)}, billed {FREQUENCY[r.terms.billingFrequency]}
              </dd>
              <dt>Renews</dt>
              <dd>
                Contract ending {day(r.contractEndOn)}
                {r.autoRenewContract ? " (auto-renews)" : ""}
              </dd>
              <dt>Service at</dt>
              <dd>
                <Link href={`/sites/${r.site.id}`}>
                  {r.site.addressLine1}, {r.site.city}
                </Link>
              </dd>
              <dt>Offer version</dt>
              <dd>{r.version}</dd>
            </dl>
          )}
          {signable && (
            <p className="small muted" style={{ wordBreak: "break-all" }}>
              Customer link: {r.link}
            </p>
          )}
        </div>

        <div className="card stack">
          <h2>Progress</h2>
          <ul className="timeline">
            <li>
              <span>Started</span>
            </li>
            {r.sentAt && (
              <li>
                <span>
                  Emailed to {r.email ?? "the customer"} {r.sendCount > 1 ? `(${r.sendCount} times)` : ""}
                </span>
                <span className="muted small">last {when(r.sentAt)}</span>
              </li>
            )}
            {r.viewedAt && (
              <li>
                <span>Opened by the customer</span>
                <span className="muted small">{when(r.viewedAt)}</span>
              </li>
            )}
            {r.signedAt && (
              <li>
                <span>Signed by {r.signedDocument?.signerName}</span>
                <span className="muted small">{when(r.signedAt)}</span>
              </li>
            )}
            {r.paidAt && (
              <li>
                <span>Paid</span>
                <span className="muted small">{when(r.paidAt)}</span>
              </li>
            )}
            {r.activatedAt && (
              <li>
                <span>Next term active</span>
                <span className="muted small">{when(r.activatedAt)}</span>
              </li>
            )}
            {r.declinedAt && (
              <li>
                <span>Declined{r.declineReason ? `: ${r.declineReason}` : ""}</span>
                <span className="muted small">{when(r.declinedAt)}</span>
              </li>
            )}
            {r.expiredAt && (
              <li>
                <span>Expired unsigned</span>
                <span className="muted small">{when(r.expiredAt)}</span>
              </li>
            )}
          </ul>
          {r.invoice && (
            <p>
              Invoice: <Link href={`/invoices/${r.invoice.id}`}>{r.invoice.number ? `INV-${r.invoice.number}` : "draft"}</Link> · {money(r.invoice.totalCents)} ·{" "}
              {r.invoice.paymentStatus}
            </p>
          )}
          {r.newContractId && (
            <p>
              New contract: <Link href={`/sites/${r.site.id}`}>view on the site</Link>
            </p>
          )}
        </div>

        {r.signedDocument && (
          <div className="card stack">
            <h2>Signature</h2>
            <dl className="details">
              <dt>Signed by</dt>
              <dd>
                {r.signedDocument.signerName} ({r.signedDocument.signatureKind === "drawn" ? "drawn" : "typed"})
              </dd>
              <dt>When</dt>
              <dd>{when(r.signedDocument.signedAt)}</dd>
              <dt>IP address</dt>
              <dd className="small">{r.signedDocument.ipAddress ?? "—"}</dd>
              <dt>Device</dt>
              <dd className="small">{r.signedDocument.userAgent ?? "—"}</dd>
              <dt>Fingerprint</dt>
              <dd className="small" style={{ wordBreak: "break-all" }}>
                SHA-256 {r.signedDocument.contentSha256}
              </dd>
            </dl>
            {r.selectedAddons.length > 0 && <p>Add-ons: {r.selectedAddons.map((a) => `${a.name} (${money(a.priceCents)})`).join(", ")}</p>}
            {"contact" in r.customerUpdates && <p className="muted small">The customer updated their contact details when signing.</p>}
            {r.signedDocument.pdfReady ? (
              <a href={`/api/renewals/${id}/agreement.pdf`} target="_blank" rel="noreferrer">
                Signed agreement (PDF)
              </a>
            ) : (
              <p className="muted small">The signed PDF is being prepared.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
