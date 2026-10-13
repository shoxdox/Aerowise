"use client";

import type { PublicInvoice } from "@aerowise/domain";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { usePublicRead, useConfirmationPolling } from "@/components/public/usePublicRead";
import { PublicLinkRecovery } from "@/components/public/PublicLinkRecovery";
import { api, ApiError } from "@/lib/api";
import { day, money } from "@/lib/format";

/** What a homeowner sees from the link in their invoice email. No sign-in: the link is the key. */
function PayPage() {
  const { token } = useParams<{ token: string }>();
  const justPaid = useSearchParams().get("paid") === "1";
  const { data: inv, error, reload } = usePublicRead<PublicInvoice>(`/pay/${token}`);
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const settled = inv?.paymentStatus === "paid" || inv?.paymentStatus === "overpaid";
  const awaiting = Boolean(inv && !settled && !inv.closedReason && !inv.bankVerificationUrl && !inv.latestPaymentFailed && (justPaid || inv.pendingCents > 0));
  const confirmation = useConfirmationPolling(awaiting, reload);
  if (error) return <PublicLinkRecovery error={error} retry={reload} kind="invoice" provider={inv?.provider} />;
  if (!inv) return <p className="muted pad">Loading…</p>;

  async function pay() {
    if (busy || (justPaid && !inv!.latestPaymentFailed) || inv!.pendingCents > 0) return;
    setBusy(true);
    setPayError(null);
    try {
      const { url } = await api<{ url: string }>(`/pay/${token}/checkout`, { method: "POST", body: {} });
      window.location.href = url;
    } catch (err) {
      setPayError(err instanceof ApiError ? err.message : "Could not start the payment. Try again.");
      setBusy(false);
    }
  }

  const contact = [inv.provider.phone, inv.provider.email].filter(Boolean).join(" or ");

  return (
    <main className="pay">
      <div className="pay-card">
        {inv.testMode && <p className="test-mode">Test mode: no real money moves.</p>}
        <div className="card stack">
          <div className="row">
            <div>
              <strong>{inv.provider.name}</strong>
              <div className="muted small">
                Invoice {inv.number} · issued {day(inv.issuedOn)}
              </div>
            </div>
          </div>
          {settled ? (
            <>
              <div className="amount">Paid</div>
              <p>Thank you, {inv.customerName}. This invoice is paid in full.</p>
            </>
          ) : inv.latestPaymentFailed ? (
            <>
              <h1>Payment did not clear</h1>
              <p>The latest payment attempt failed, and no payment is pending. Contact your provider with questions. You can start a new attempt if payment is still due.</p>
              {inv.canPayOnline && <button onClick={() => void pay()} disabled={busy}>Retry payment of {money(inv.amountDueCents)}</button>}
              {payError && <p className="error">{payError}</p>}
            </>
          ) : inv.bankVerificationUrl ? (
            <>
              <div className="amount">Verify your bank account</div>
              <p>
                Your bank payment of {money(inv.pendingCents)} is waiting for you to confirm your bank account. In a day or two, two small deposits (or one with a
                code) arrive in it; enter them on the verification page and the payment goes ahead.
              </p>
              <a className="button" href={inv.bankVerificationUrl} target="_blank" rel="noopener noreferrer">
                Verify bank account
              </a>
            </>
          ) : inv.paymentStatus === "processing" || inv.pendingCents > 0 ? (
            <>
              <div className="amount">{money(inv.pendingCents)} clearing</div>
              <p>Your bank payment is on its way. Bank transfers take a few business days to clear. If you are asked to verify your bank account, this page shows how.</p>
            </>
          ) : (
            <>
              {!inv.closedReason && (
                <>
                  <div className="muted">Amount due</div>
                  <div className="amount">{money(inv.amountDueCents)}</div>
                  <div className="muted">Due {day(inv.dueOn)}</div>
                </>
              )}
              {justPaid && <div role="status"><h2>Confirming your payment</h2><p>Your payment may still be confirming. Do not pay again while it is pending. We are checking for the provider&apos;s confirmation.</p></div>}
              {inv.closedReason ? (
                <p className="muted" data-testid="pay-closed">
                  {inv.closedReason}
                  {contact && ` Contact ${inv.provider.name} at ${contact}.`}
                </p>
              ) : justPaid ? null : inv.canPayOnline ? (
                <button onClick={() => void pay()} disabled={busy}>
                  Pay {money(inv.amountDueCents)} by card or bank
                </button>
              ) : (
                <p className="muted">Online payment is not available for this invoice.{contact && ` To pay, contact ${inv.provider.name} at ${contact}.`}</p>
              )}
              {payError && <p className="error">{payError}</p>}
            </>
          )}
        </div>

        {(justPaid || inv.pendingCents > 0 || inv.bankVerificationUrl) && !settled && !inv.closedReason && !inv.latestPaymentFailed && <div className="card stack" role="status">
          <p>{confirmation.exhausted ? "Automatic checks have paused. Confirmation has not arrived. Bank payments can take several business days; refresh or contact your provider before making another payment." : inv.bankVerificationUrl ? "Complete bank verification, then refresh here to check the payment." : "This page checks briefly for confirmation. You can also refresh the status."}</p>
          <button className="secondary" onClick={() => void confirmation.refresh()}>Refresh payment status</button>
        </div>}
        <div className="card stack">
          <div className="muted small">
            Billed to {inv.customerName}
            {inv.serviceAddress && ` · service at ${inv.serviceAddress}`}
          </div>
          <table className="compact">
            <tbody>
              {inv.lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    {l.description}
                    {l.quantity > 1 && (
                      <span className="muted small">
                        {" "}
                        · {l.quantity} × {money(l.unitPriceCents)}
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>{money(l.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="details totals">
            {inv.discountCents > 0 && (
              <>
                <dt>Discount</dt>
                <dd>−{money(inv.discountCents)}</dd>
              </>
            )}
            {inv.taxCents > 0 && (
              <>
                <dt>Sales tax</dt>
                <dd>{money(inv.taxCents)}</dd>
              </>
            )}
            <dt>Total</dt>
            <dd>{money(inv.totalCents)}</dd>
            {inv.creditedCents > 0 && (
              <>
                <dt>Refunded</dt>
                <dd>−{money(inv.creditedCents)}</dd>
              </>
            )}
            {inv.paidCents > 0 && (
              <>
                <dt>Paid</dt>
                <dd>−{money(inv.paidCents)}</dd>
              </>
            )}
          </dl>
          {inv.memo && <p className="muted">{inv.memo}</p>}
          {inv.pdfReady && (
            <a href={`/api/pay/${token}/pdf`} target="_blank" rel="noreferrer">
              Download PDF
            </a>
          )}
        </div>
        {contact && (
          <p className="muted small">
            Questions about this invoice? Contact {inv.provider.name} at {contact}.
          </p>
        )}
      </div>
    </main>
  );
}

export default function PublicPayPage() {
  return (
    <Suspense>
      <PayPage />
    </Suspense>
  );
}
