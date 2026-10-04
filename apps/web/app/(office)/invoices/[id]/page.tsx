"use client";

import { formatPhone, invoiceNumberLabel, PAYMENT_METHOD_LABELS, SMS_SKIP_LABELS, type InvoiceDetail, type Payment, type SmsQueueResult } from "@aerowise/domain";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { InvoiceStatusBadge } from "@/components/InvoiceBadges";
import { InvoiceEditor } from "@/components/InvoiceEditor";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day, money, when } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

const PAYMENT_STATE: Record<Payment["status"], string> = { pending: "clearing", succeeded: "received", failed: "failed" };

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const me = useSession();
  const editable = canEdit(me);
  const owner = me.role === "owner";
  const { data: inv, error, reload } = useLoad<InvoiceDetail>(`/invoices/${id}`);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"payment" | "void" | null>(null);
  const [copied, setCopied] = useState(false);
  const [texted, setTexted] = useState<string | null>(null);

  if (error) return <p className="error">{error}</p>;
  if (!inv) return <p className="muted">Loading…</p>;

  async function run(path: string, body: object = {}, after?: () => void) {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/invoices/${id}/${path}`, { method: "POST", body });
      setPanel(null);
      if (after) after();
      else await reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  function recordPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    void run("payments", { amountCents: Math.round(Number(v.amount) * 100), method: v.method, receivedOn: v.receivedOn, reference: v.reference ?? null, note: v.note ?? null });
  }

  async function refund(p: Payment) {
    const left = (p.amountCents - p.refundedCents) / 100;
    const amount = window.prompt(`Refund how much? Up to ${money(p.amountCents - p.refundedCents)}.`, left.toFixed(2));
    if (!amount) return;
    const reason = window.prompt("Reason for the refund (kept on the invoice)");
    if (!reason) return;
    setBusy(true);
    setActionError(null);
    try {
      await api(`/payments/${p.id}/refund`, { method: "POST", body: { amountCents: Math.round(Number(amount) * 100), reason } });
      await reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not refund");
    } finally {
      setBusy(false);
    }
  }

  async function textReminder() {
    setBusy(true);
    setActionError(null);
    setTexted(null);
    try {
      const r = await api<SmsQueueResult>(`/invoices/${id}/text-reminder`, { method: "POST", body: {} });
      setTexted(r.outcome === "queued" ? `Reminder texted to ${r.to ? formatPhone(r.to) : "the customer"}.` : `No text sent: ${r.outcome === "off" ? "texting is off" : SMS_SKIP_LABELS[r.outcome].toLowerCase()}.`);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not text");
    } finally {
      setBusy(false);
    }
  }

  const label = invoiceNumberLabel(inv.number);

  return (
    <div className="stack">
      <p>
        <Link href="/invoices">← Invoices</Link>
      </p>
      <div className="row">
        <h1>{label}</h1>
        <InvoiceStatusBadge invoice={inv} />
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
              {day(inv.dueOn!)}
              {inv.overdue && <span className="badge danger">overdue</span>}
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

      {actionError && <p className="error">{actionError}</p>}

      {inv.status === "draft" && editable && (
        <>
          <InvoiceEditor invoice={inv} onSaved={() => void reload()} />
          <div className="row">
            <button disabled={busy || !inv.billToEmail} onClick={() => void run("issue", { send: true })}>
              Issue and email
            </button>
            <button className="secondary" disabled={busy} onClick={() => void run("issue", { send: false })}>
              Issue without emailing
            </button>
            <span className="spacer" />
            <button className="link" disabled={busy} onClick={() => window.confirm("Delete this draft?") && void run("discard", {}, () => router.push("/invoices"))}>
              Delete draft
            </button>
          </div>
          <p className="muted small">Issuing gives the invoice its number and freezes it. To change it afterwards, void it and issue a new one.</p>
        </>
      )}

      {inv.status !== "draft" && (
        <>
          <table>
            <thead>
              <tr>
                <th>Description</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.description}
                    {l.taxable && inv.taxRateBps > 0 && <span className="muted small"> · taxable</span>}
                  </td>
                  <td>{l.quantity}</td>
                  <td>{money(l.unitPriceCents)}</td>
                  <td>{money(l.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="details totals">
            <dt>Subtotal</dt>
            <dd>{money(inv.subtotalCents)}</dd>
            {inv.discountCents > 0 && (
              <>
                <dt>Discount</dt>
                <dd>−{money(inv.discountCents)}</dd>
              </>
            )}
            {inv.taxRateBps > 0 && (
              <>
                <dt>Sales tax ({(inv.taxRateBps / 100).toFixed(2)}%)</dt>
                <dd>{money(inv.taxCents)}</dd>
              </>
            )}
            <dt>
              <strong>Total</strong>
            </dt>
            <dd>
              <strong>{money(inv.totalCents)}</strong>
            </dd>
          </dl>
          {inv.memo && <p className="card">{inv.memo}</p>}
        </>
      )}

      {inv.status === "open" && editable && (
        <section className="stack">
          <div className="row">
            {inv.payUrl && (
              <button
                className="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(inv.payUrl!).then(() => setCopied(true));
                }}
              >
                {copied ? "Pay link copied" : "Copy pay link"}
              </button>
            )}
            {inv.billToEmail && (
              <button className="secondary" disabled={busy} onClick={() => void run("send")}>
                Email again
              </button>
            )}
            {inv.amountDueCents > 0 && (
              <button className="secondary" disabled={busy} onClick={() => void textReminder()}>
                Text a reminder
              </button>
            )}
            {inv.amountDueCents > 0 && (
              <button className="secondary" onClick={() => setPanel(panel === "payment" ? null : "payment")}>
                Record a payment
              </button>
            )}
            <span className="spacer" />
            {inv.paidCents === 0 && inv.pendingCents === 0 && (
              <button className="link" onClick={() => setPanel(panel === "void" ? null : "void")}>
                Void invoice
              </button>
            )}
          </div>

          {texted && <p className="muted">{texted}</p>}
          {panel === "payment" && (
            <form className="card grid" onSubmit={recordPayment}>
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
                <input name="receivedOn" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
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
                <button type="submit" disabled={busy}>
                  Record payment
                </button>
              </div>
            </form>
          )}

          {panel === "void" && (
            <form className="card stack" onSubmit={(e) => (e.preventDefault(), void run("void", { reason: formValues(e.currentTarget).reason }))}>
              <label>
                Why is this invoice being voided?
                <input name="reason" required />
              </label>
              <p className="muted small">The invoice keeps its number but is no longer owed, and its pay link stops working.</p>
              <div>
                <button type="submit" disabled={busy}>
                  Void invoice
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      {inv.payments.length > 0 && (
        <section className="stack">
          <h2>Payments</h2>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Method</th>
                <th>Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {inv.payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.receivedOn ? day(p.receivedOn) : when(p.createdAt)}</td>
                  <td>
                    {PAYMENT_METHOD_LABELS[p.method]}
                    {p.source === "stripe" && <span className="muted small"> · online</span>}
                    {p.reference && <div className="muted small">{p.reference}</div>}
                  </td>
                  <td>
                    {money(p.amountCents)}
                    {p.refunds.map((r) => (
                      <div key={r.id} className="muted small">
                        {r.status === "failed" ? "Refund failed" : r.status === "pending" ? "Refund pending" : "Refunded"} {money(r.amountCents)}
                        {r.reason && `: ${r.reason}`}
                      </div>
                    ))}
                  </td>
                  <td>
                    <span className={`badge ${p.status === "succeeded" ? "ok" : p.status === "failed" ? "danger" : "upcoming"}`}>{PAYMENT_STATE[p.status]}</span>
                    {p.failureReason && <div className="error small">{p.failureReason}</div>}
                  </td>
                  <td>
                    {owner && p.status === "succeeded" && p.refundedCents < p.amountCents && (
                      <button className="link" disabled={busy} onClick={() => void refund(p)}>
                        Refund
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
