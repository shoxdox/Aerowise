"use client";

import { BILLING_FREQUENCY_LABELS, isSignable, type Plan, type RenewalDetail } from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { RenewalBadge } from "@/components/RenewalBadge";
import { LoadState } from "@/components/LoadState";
import { StatusBadge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, formValues } from "@/lib/api";
import { dateRange, day, invoiceLabel, money, plural, when } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";
import { usePageTitle } from "@/lib/title";

export default function RenewalPage() {
  const { id } = useParams<{ id: string }>();
  const editable = canEdit(useSession());
  const recordLoad = useLoad<RenewalDetail>(`/renewals/${id}`);
  const { data: r, reload } = recordLoad;
  const plans = useLoad<{ items: Plan[] }>(editable ? "/plans" : null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Declining asks its optional reason right here, not in a browser pop-up.
  const [declining, setDeclining] = useState(false);
  usePageTitle(r ? `Renewal · ${r.customer.displayName}` : null);

  const acting = useSubmit(
    async (action: () => Promise<unknown>, done?: string) => {
      setNotice(null);
      await action();
      setEditing(false);
      setDeclining(false);
      if (done) setNotice(done);
      await reload();
    },
    { fallback: "Could not save." },
  );
  const run = (action: () => Promise<unknown>, done?: string) => acting.run(action, done);
  const actionError = acting.error;

  if (!r) return <LoadState load={recordLoad} label="renewal" back={{ href: "/renewals", label: "Renewals" }} />;

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

  function decline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { reason } = formValues(event.currentTarget);
    void run(() => api(`/renewals/${id}/decline`, { method: "POST", body: { reason: reason ?? null } }));
  }

  const activateQuestion = r.signedDocument
    ? "Start the next term now, without waiting for payment?"
    : "This contract auto-renews. Start the next term without a new signature? Its first installment is billed as usual.";

  async function copyLink() {
    await navigator.clipboard?.writeText(r!.link).catch(() => undefined);
    setNotice("Link copied. Paste it into a text or email to the customer.");
  }

  return (
    <div className="stack">
      <LoadState load={recordLoad} label="renewal" back={{ href: "/renewals", label: "Renewals" }} />
      <div className="row">
        <Link href="/renewals">← Renewals</Link>
      </div>
      <div className="row">
        <h1>{r.customer.displayName}</h1>
        <RenewalBadge status={r.status} />
        <span className="spacer" />
        {editable && signable && (
          <SubmitButton type="button" busy={acting.busy} busyLabel="Sending…" onClick={() => void run(() => api(`/renewals/${id}/send`, { method: "POST", body: {} }), "Renewal emailed.")} disabled={!r.email}>
            {r.sendCount > 0 ? "Email again" : "Email link"}
          </SubmitButton>
        )}
        {signable && (
          <button className="secondary" onClick={() => void copyLink()}>
            Copy link
          </button>
        )}
        {canActivate && (
          <ConfirmButton className="secondary" danger={false} question={activateQuestion} busy={acting.busy} onConfirm={() => run(() => api(`/renewals/${id}/activate`, { method: "POST", body: {} }))}>
            {r.signedDocument ? "Activate now" : "Auto-renew now"}
          </ConfirmButton>
        )}
        {editable && (signable || r.status === "needs_review") && !declining && (
          <button className="link danger" onClick={() => setDeclining(true)}>
            Mark declined
          </button>
        )}
      </div>
      {declining && (
        <form className="card row" onSubmit={decline}>
          <label>
            Why is the customer not renewing? <span className="muted small">(optional)</span>
            <input name="reason" maxLength={2000} autoFocus />
          </label>
          <SubmitButton className="danger" busy={acting.busy}>
            Mark declined
          </SubmitButton>
          <button type="button" className="link" onClick={() => setDeclining(false)}>
            Keep the offer open
          </button>
        </form>
      )}
      {notice && <p>{notice}</p>}
      <FormError error={actionError} />
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
                        {p.name}: {plural(p.termMonths, "month")}, {money(p.priceCents)}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Price for the term ($)
                <input name="price" type="number" min={0} step="0.01" placeholder={(r.terms.priceCents / 100).toFixed(2)} />
              </label>
              <div>
                <SubmitButton busy={acting.busy}>Save offer</SubmitButton>
              </div>
            </form>
          ) : (
            <dl className="details">
              <dt>Plan</dt>
              <dd>{r.terms.planName}</dd>
              <dt>Term</dt>
              <dd>
                {dateRange(r.terms.startOn, r.terms.endOn)}
              </dd>
              <dt>Visits</dt>
              {/* A pumping or maintenance only offer (SW-9) has no single count: its cycles are on the plan version. */}
              <dd>{r.terms.serviceType === "aerobic_inspection" ? r.terms.visitsPerTerm : `${r.terms.serviceType === "pumping" ? "Pumping" : "Maintenance"} visits, as the plan version lists them`}</dd>
              <dt>Price</dt>
              <dd>
                {money(r.terms.priceCents)}, billed {BILLING_FREQUENCY_LABELS[r.terms.billingFrequency]}
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
              Invoice: <Link href={`/invoices/${r.invoice.id}`}>{invoiceLabel(r.invoice.number)}</Link> · {money(r.invoice.totalCents)}{" "}
              <StatusBadge of="payment" value={r.invoice.paymentStatus} />
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
            {r.intake && (
              <div data-testid="renewal-intake-answers">
                <p>
                  {r.intake.name} (version {r.intake.version}):
                </p>
                <dl>
                  {r.intake.answers.map((a) => (
                    <div key={a.key}>
                      <dt>{a.label}</dt>
                      <dd>{a.answer}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
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
