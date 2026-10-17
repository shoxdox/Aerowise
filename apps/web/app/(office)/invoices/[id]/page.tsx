"use client";

import { formatPhone, PAYMENT_METHOD_LABELS, SMS_SKIP_LABELS, type InvoiceDetail, type Payment, type SmsQueueResult } from "@aerowise/domain";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { InvoiceStatusBadge } from "@/components/InvoiceBadges";
import { InvoiceEditor } from "@/components/InvoiceEditor";
import { LoadState } from "@/components/LoadState";
import { Badge, StatusBadge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, formValues } from "@/lib/api";
import { day, invoiceLabel, money, quantity, today, when } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";
import { usePageTitle } from "@/lib/title";

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const me = useSession();
  const editable = canEdit(me);
  const owner = me.role === "owner";
  const recordLoad = useLoad<InvoiceDetail>(`/invoices/${id}`);
  const { data: inv, reload } = recordLoad;
  const [panel, setPanel] = useState<"payment" | "void" | "refundJob" | null>(null);
  const [refunding, setRefunding] = useState<Payment | null>(null);
  const [copied, setCopied] = useState(false);
  const [texted, setTexted] = useState<string | null>(null);
  // One id per opened "Refund the job": a retry or a second click sends the same one, so the money moves once.
  const [refundJobRequestId, setRefundJobRequestId] = useState("");
  usePageTitle(inv ? invoiceLabel(inv.number) : null);

  const action = useSubmit(
    async (path: string, body: object = {}, after?: () => void) => {
      await api(`/invoices/${id}/${path}`, { method: "POST", body });
      setPanel(null);
      if (after) after();
      else await reload();
    },
    { fallback: "Could not save." },
  );
  const refund = useSubmit(
    async (v: Record<string, string | undefined>) => {
      if (!refunding) return;
      await api(`/payments/${refunding.id}/refund`, { method: "POST", body: { amountCents: Math.round(Number(v.amount) * 100), reason: v.reason, intent: v.intent } });
      setRefunding(null);
      await reload();
    },
    { fallback: "Could not refund." },
  );
  const reminder = useSubmit(
    async () => {
      setTexted(null);
      const r = await api<SmsQueueResult>(`/invoices/${id}/text-reminder`, { method: "POST", body: {} });
      setTexted(r.outcome === "queued" ? `Reminder texted to ${r.to ? formatPhone(r.to) : "the customer"}.` : `No text sent: ${r.outcome === "off" ? "texting is off" : SMS_SKIP_LABELS[r.outcome].toLowerCase()}.`);
    },
    { fallback: "Could not text." },
  );
  const busy = action.busy || refund.busy || reminder.busy;

  if (!inv) return <LoadState load={recordLoad} label="invoice" back={{ href: "/invoices", label: "Invoices" }} />;

  const label = invoiceLabel(inv.number);
  // A paid invoice is done: nothing to email again or pay through its link.
  const owing = inv.amountDueCents > 0;

  return (
    <div className="stack">
      <LoadState load={recordLoad} label="invoice" back={{ href: "/invoices", label: "Invoices" }} />
      <p>
        <Link href="/invoices">← Invoices</Link>
      </p>
      <div className="row">
        <h1>{label}</h1>
        <InvoiceStatusBadge invoice={inv} />
        {inv.estimate && (
          <span className="muted small">
            {inv.estimate.role === "deposit" ? "Deposit for" : "Final invoice for"} <Link href={`/estimates/${inv.estimate.id}`}>{inv.estimate.label}</Link>
            {inv.estimate.role === "deposit" && ": refund or keep it from the estimate"}
          </span>
        )}
        <span className="spacer" />
        {inv.pdfReady && (
          <a className="button secondary" href={`/api/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">
            PDF
          </a>
        )}
      </div>

      <dl className="card details">
        <dt>Customer</dt>
        <dd>
          <Link href={`/customers/${inv.customer.id}`}>{inv.customer.displayName}</Link>
          {inv.site && (
            <>
              {" · "}
              <Link href={`/sites/${inv.site.id}`}>
                {inv.site.addressLine1}, {inv.site.city}
              </Link>
            </>
          )}
        </dd>
        <dt>Email</dt>
        <dd>{inv.billToEmail ?? <span className="restriction">No email on file. Add a billing contact on the customer to email invoices.</span>}</dd>
        {inv.issuedOn && (
          <>
            <dt>Issued</dt>
            <dd>{day(inv.issuedOn)}</dd>
            <dt>Due</dt>
            <dd>
              {day(inv.dueOn!)} {inv.overdue && <Badge tone="danger">Overdue</Badge>}
            </dd>
            <dt>Emailed</dt>
            <dd>{inv.sentAt ? when(inv.sentAt) : "Not yet"}</dd>
          </>
        )}
        {inv.status === "open" && (
          <>
            <dt>Still due</dt>
            <dd>
              <strong>{money(inv.amountDueCents)}</strong>
              {inv.pendingCents > 0 && <span className="muted"> · {money(inv.pendingCents)} bank payment clearing</span>}
              {inv.creditedCents > 0 && <span className="muted"> · {money(inv.creditedCents)} refunded, no longer owed</span>}
            </dd>
          </>
        )}
        {inv.status === "void" && (
          <>
            <dt>Voided</dt>
            <dd>
              {when(inv.voidedAt)}: {inv.voidReason}
            </dd>
          </>
        )}
      </dl>

      <FormError error={action.error ?? reminder.error} />

      {inv.status === "draft" && editable && (
        <>
          <InvoiceEditor
            invoice={inv}
            onSaved={() => void reload()}
            actions={[
              { label: "Issue and email", busyLabel: "Issuing…", disabled: !inv.billToEmail, run: () => api(`/invoices/${id}/issue`, { method: "POST", body: { send: true } }).then(reload) },
              { label: "Issue without emailing", busyLabel: "Issuing…", className: "secondary", run: () => api(`/invoices/${id}/issue`, { method: "POST", body: { send: false } }).then(reload) },
            ]}
          />
          <div className="row">
            <p className="muted small">Issuing gives the invoice its number and freezes it. To change it afterwards, void it and issue a new one.</p>
            <span className="spacer" />
            <ConfirmButton className="link danger" question="Delete this draft?" confirmLabel="Delete draft" busy={action.busy} onConfirm={() => action.run("discard", {}, () => router.push("/invoices"))}>
              Delete draft
            </ConfirmButton>
          </div>
        </>
      )}

      {inv.status !== "draft" && (
        <>
          <table className="stack">
            <thead>
              <tr>
                <th>Description</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.id}>
                  <td data-label="Description">
                    {l.description}
                    {l.taxable && inv.taxRateBps > 0 && <span className="muted small"> · taxable</span>}
                  </td>
                  <td data-label="Qty" className="num">
                    {quantity(l.quantity)}
                  </td>
                  <td data-label="Price" className="num">
                    {money(l.unitPriceCents)}
                  </td>
                  <td data-label="Amount" className="num">
                    {money(l.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="details totals">
            <dt>Subtotal</dt>
            <dd className="num">{money(inv.subtotalCents)}</dd>
            {inv.discountCents > 0 && (
              <>
                <dt>Discount</dt>
                <dd className="num">−{money(inv.discountCents)}</dd>
              </>
            )}
            {inv.taxRateBps > 0 && (
              <>
                <dt>Sales tax ({(inv.taxRateBps / 100).toFixed(2)}%)</dt>
                <dd className="num">{money(inv.taxCents)}</dd>
              </>
            )}
            {inv.depositAppliedCents > 0 && (
              <>
                <dt>Deposit applied</dt>
                <dd className="num">−{money(inv.depositAppliedCents)}</dd>
              </>
            )}
            <dt>
              <strong>Total</strong>
            </dt>
            <dd className="num">
              <strong>{money(inv.totalCents)}</strong>
            </dd>
          </dl>
          {inv.memo && <p className="card">{inv.memo}</p>}
        </>
      )}

      {inv.status === "open" && editable && (
        <section className="stack">
          <div className="row">
            {owing && inv.payUrl && (
              <button
                className="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(inv.payUrl!).then(() => setCopied(true));
                }}
              >
                {copied ? "Pay link copied" : "Copy pay link"}
              </button>
            )}
            {owing && inv.billToEmail && (
              <SubmitButton type="button" className="secondary" busy={action.busy} busyLabel="Sending…" disabled={busy} onClick={() => void action.run("send")}>
                Email again
              </SubmitButton>
            )}
            {owing && (
              <SubmitButton type="button" className="secondary" busy={reminder.busy} busyLabel="Texting…" disabled={busy} onClick={() => void reminder.run()}>
                Text a reminder
              </SubmitButton>
            )}
            {owing && (
              <button className="secondary" onClick={() => setPanel(panel === "payment" ? null : "payment")}>
                Record a payment
              </button>
            )}
            {owner && inv.estimate?.role === "final" && inv.depositAppliedCents > 0 && (
              <button
                className="secondary danger"
                onClick={() => {
                  setRefundJobRequestId(crypto.randomUUID());
                  setPanel(panel === "refundJob" ? null : "refundJob");
                }}
              >
                Refund the job
              </button>
            )}
            <span className="spacer" />
            {inv.paidCents === 0 && inv.pendingCents === 0 && (
              <button className="link danger" onClick={() => setPanel(panel === "void" ? null : "void")}>
                Void invoice
              </button>
            )}
          </div>

          {texted && <p className="muted">{texted}</p>}
          {panel === "refundJob" && (
            <form
              className="card stack"
              aria-label="Refund the job"
              onSubmit={(ev) => {
                ev.preventDefault();
                const v = formValues(ev.currentTarget);
                void action.run("refund-job", { requestId: refundJobRequestId, amountCents: Math.round(Number(v.amount) * 100), reason: v.reason });
              }}
            >
              <p className="muted small">
                Gives the customer money back for this job: this invoice&apos;s own payments first, then the deposit money applied to it. The deposit part stays pending until Stripe says it went through,
                and this invoice is never owed again for it.
              </p>
              <label>
                Amount ($)
                <input name="amount" type="number" min="0.01" step="0.01" required />
              </label>
              <label>
                Reason
                <input name="reason" required maxLength={2000} />
              </label>
              <div>
                <SubmitButton className="danger" busy={action.busy} busyLabel="Refunding…">
                  Refund
                </SubmitButton>
              </div>
            </form>
          )}
          {panel === "payment" && (
            <form
              className="card grid"
              onSubmit={(ev) => {
                ev.preventDefault();
                const v = formValues(ev.currentTarget);
                void action.run("payments", { amountCents: Math.round(Number(v.amount) * 100), method: v.method, receivedOn: v.receivedOn, reference: v.reference ?? null, note: v.note ?? null });
              }}
            >
              <label>
                Amount ($)
                <input name="amount" type="number" min="0.01" step="0.01" max={inv.amountDueCents / 100} defaultValue={(inv.amountDueCents / 100).toFixed(2)} required />
              </label>
              <label>
                Method
                <select name="method" defaultValue="check">
                  <option value="check">Check</option>
                  <option value="cash">Cash</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>
                Received
                <input name="receivedOn" type="date" required defaultValue={today()} />
              </label>
              <label>
                Check number or receipt
                <input name="reference" placeholder="Optional" />
              </label>
              <label className="wide">
                Note
                <input name="note" placeholder="Optional" />
              </label>
              <div className="wide">
                <SubmitButton busy={action.busy}>Record payment</SubmitButton>
              </div>
            </form>
          )}

          {panel === "void" && (
            <form className="card stack" onSubmit={(e) => (e.preventDefault(), void action.run("void", { reason: formValues(e.currentTarget).reason }))}>
              <label>
                Why is this invoice being voided?
                <input name="reason" required />
              </label>
              <p className="muted small">The invoice keeps its number but is no longer owed, and its pay link stops working.</p>
              <div>
                <SubmitButton className="danger" busy={action.busy} busyLabel="Voiding…">
                  Void invoice
                </SubmitButton>
              </div>
            </form>
          )}
        </section>
      )}

      {inv.payments.length > 0 && (
        <section className="stack">
          <h2>Payments</h2>
          <table className="stack">
            <thead>
              <tr>
                <th>Date</th>
                <th>Method</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {inv.payments.map((p) => (
                <tr key={p.id}>
                  <td data-label="Date">{p.receivedOn ? day(p.receivedOn) : when(p.createdAt)}</td>
                  <td data-label="Method">
                    {PAYMENT_METHOD_LABELS[p.method]}
                    {p.source === "stripe" && <span className="muted small"> · online</span>}
                    {p.reference && <div className="muted small">{p.reference}</div>}
                  </td>
                  <td data-label="Amount" className="num">
                    {money(p.amountCents)}
                    {p.refunds.map((r) => (
                      <div key={r.id} className="muted small">
                        {r.status === "failed" ? "Refund failed" : r.status === "pending" ? "Refund pending" : "Refunded"} {money(r.amountCents)}
                        {r.intent === "reverse" && " (payment reversed, owed again)"}
                        {r.reason && `: ${r.reason}`}
                      </div>
                    ))}
                  </td>
                  <td data-label="Status">
                    {p.awaitingBankVerification ? <Badge tone="info">Waiting on the customer to verify their bank</Badge> : <StatusBadge of="paymentRecord" value={p.status} />}
                    {p.failureReason && <div className="error small">{p.failureReason}</div>}
                  </td>
                  <td className={owner ? "actions" : undefined}>
                    {owner && p.status === "succeeded" && p.refundedCents < p.amountCents && inv.estimate?.role !== "deposit" && (
                      <button className="link danger" disabled={busy} onClick={() => setRefunding(p)}>
                        Refund
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {refunding && (
            // Usually the customer no longer owes what is refunded. Reversing a payment taken by mistake is the exception.
            <form
              className="card stack"
              onSubmit={refund.form}
              aria-label="Refund payment"
            >
              <label>
                Amount ($), up to {money(refunding.amountCents - refunding.refundedCents)}
                <input name="amount" type="number" min="0.01" step="0.01" max={(refunding.amountCents - refunding.refundedCents) / 100} defaultValue={((refunding.amountCents - refunding.refundedCents) / 100).toFixed(2)} required />
              </label>
              <label>
                Reason (kept on the invoice)
                <input name="reason" required />
              </label>
              <fieldset className="stack">
                <legend>Does the customer still owe this amount?</legend>
                <label>
                  <input type="radio" name="intent" value="credit" defaultChecked /> Ordinary refund: they no longer owe it
                </label>
                <label>
                  <input type="radio" name="intent" value="reverse" /> Reverse payment: it was taken by mistake, so the balance is owed again
                </label>
              </fieldset>
              <FormError error={refund.error} />
              <div className="row">
                <SubmitButton className="danger" busy={refund.busy} busyLabel="Refunding…">
                  Refund
                </SubmitButton>
                <button type="button" className="secondary" disabled={refund.busy} onClick={() => setRefunding(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      <section className="stack">
        <h2>History</h2>
        <ul className="timeline">
          {inv.events.map((e) => (
            <li key={e.id}>
              <span className="muted small">
                {when(e.occurredAt)}
                {e.actorName && ` · ${e.actorName}`}
              </span>
              <span>{e.summary}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
