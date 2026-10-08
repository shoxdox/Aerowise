"use client";

import { DEPOSIT_LEDGER_LABELS, roleHasPermission, type DepositView } from "@aerowise/domain";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { api, ApiError, formValues } from "@/lib/api";
import { money, when } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

type Action = "refund" | "retain" | "retain-reverse" | "shortfall";

const cents = (dollars: string | undefined) => Math.round(Number(dollars || "0") * 100);

/**
 * An estimate's deposit for the office: its invoice, what is free, applied, kept and being
 * refunded, and the actions on it. Refunds stay pending until the provider says they went
 * through; nothing here moves money that is not free.
 */
export function DepositPanel({ deposit, onChange }: { deposit: DepositView; onChange: () => Promise<void> }) {
  const me = useSession();
  const manage = canEdit(me) && roleHasPermission(me.role, "billing:manage");
  const [panel, setPanelState] = useState<Action | null>(null);
  // One id per opened action: a retry or a second click sends the same one, so the server moves the money once.
  const [requestId, setRequestId] = useState<string>("");
  const setPanel = (next: Action | null) => {
    setPanelState(next);
    setRequestId(next ? crypto.randomUUID() : "");
  };
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const b = deposit.balances;
  const d = deposit.invoice;

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const v = formValues(ev.currentTarget);
    const body = panel === "shortfall" ? { requestId, kind: "write_off", amountCents: cents(v.amount), reason: v.reason } : { requestId, amountCents: cents(v.amount), reason: v.reason };
    setBusy(true);
    setProblem(null);
    try {
      await api(`/invoices/${d.id}/deposit/${panel}`, { method: "POST", body });
      setPanel(null);
      await onChange();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const max = panel === "refund" ? Math.min(b.free, deposit.refundableCents) : panel === "retain" ? b.free : panel === "retain-reverse" ? b.retained : b.shortfallOutstanding;
  return (
    <div className="card stack" data-testid="deposit-panel">
      <div className="row">
        <h2>Deposit</h2>
        <Link href={`/invoices/${d.id}`}>{d.number ?? "Deposit invoice"}</Link>
        <span className="muted small">
          {money(d.totalCents)} · {d.voided ? "void" : d.paymentStatus}
        </span>
      </div>
      <dl className="details">
        <dt>Received</dt>
        <dd data-testid="deposit-received">{money(b.received)}</dd>
        <dt>Applied to the final invoice</dt>
        <dd>{money(b.applied)}</dd>
        {b.retained > 0 && (
          <>
            <dt>Kept</dt>
            <dd>{money(b.retained)}</dd>
          </>
        )}
        {b.returned > 0 && (
          <>
            <dt>Refunded</dt>
            <dd>{money(b.returned)}</dd>
          </>
        )}
        {b.reserved > 0 && (
          <>
            <dt>Refund pending</dt>
            <dd>{money(b.reserved)}</dd>
          </>
        )}
        <dt>Free</dt>
        <dd data-testid="deposit-free">{money(b.free)}</dd>
        {b.shortfall > 0 && (
          <>
            <dt>Shortfall</dt>
            <dd className="error">
              {money(b.shortfall)}
              {b.shortfallOutstanding < b.shortfall && <span className="muted small"> · {money(b.shortfall - b.shortfallOutstanding)} dealt with</span>}
            </dd>
          </>
        )}
      </dl>
      {b.overResolved > 0 && <p className="error small">Shortfall resolved more than is now owed: {money(b.overResolved)}. Credit the customer.</p>}
      {deposit.finals.length > 0 && (
        <ul className="small">
          {deposit.finals.map((f) => (
            <li key={f.id}>
              Final invoice <Link href={`/invoices/${f.id}`}>{f.number ?? "draft"}</Link>: {money(f.appliedCents)} of the deposit applied
              {f.reversedCents > 0 && `, ${money(f.reversedCents)} returned with the job refund`}
              {!f.active && <span className="muted"> · voided</span>}
            </li>
          ))}
        </ul>
      )}
      {manage && (
        <div className="row">
          <button className="secondary" disabled={b.free <= 0 || deposit.refundableCents <= 0} onClick={() => setPanel(panel === "refund" ? null : "refund")}>
            Refund the deposit
          </button>
          <button className="secondary" disabled={b.free <= 0} onClick={() => setPanel(panel === "retain" ? null : "retain")}>
            Keep it
          </button>
          {b.retained > 0 && (
            <button className="secondary" onClick={() => setPanel(panel === "retain-reverse" ? null : "retain-reverse")}>
              Put kept money back
            </button>
          )}
          {b.shortfallOutstanding > 0 && (
            <button className="secondary" onClick={() => setPanel(panel === "shortfall" ? null : "shortfall")}>
              Write off the shortfall
            </button>
          )}
        </div>
      )}
      {panel && (
        <form className="stack" onSubmit={submit}>
          <p className="muted small">
            {panel === "refund"
              ? "Card and bank refunds stay pending until Stripe says they went through; the money is held for them meanwhile."
              : panel === "retain"
                ? "Kept under the estimate's terms. Kept money cannot be refunded or applied unless you put it back."
                : panel === "retain-reverse"
                  ? "Makes kept money free again."
                  : "Records that the shortfall will not be collected. It does not change the deposit's balances."}
          </p>
          <label>
            Amount ($), up to {money(max)}
            <input name="amount" type="number" min="0.01" step="0.01" max={(max / 100).toFixed(2)} defaultValue={(max / 100).toFixed(2)} required />
          </label>
          <label>
            Reason
            <input name="reason" required maxLength={2000} />
          </label>
          <div>
            <button type="submit" disabled={busy}>
              Save
            </button>
          </div>
        </form>
      )}
      {problem && <p className="error">{problem}</p>}
      {deposit.refunds.some((f) => f.status !== "succeeded") && (
        <ul className="small">
          {deposit.refunds
            .filter((f) => f.status !== "succeeded")
            .map((f) => (
              <li key={f.id} className={f.status === "failed" ? "error" : undefined}>
                Refund of {money(f.amountCents)} {f.status === "pending" ? "pending" : `failed${f.failureReason ? `: ${f.failureReason}` : ""}`} · {when(f.createdAt)}
              </li>
            ))}
        </ul>
      )}
      {deposit.ledger.length > 0 && (
        <details>
          <summary className="small">Deposit ledger</summary>
          <ul className="timeline">
            {deposit.ledger.map((l) => (
              <li key={l.id}>
                <span className="muted small">{when(l.createdAt)}</span> {DEPOSIT_LEDGER_LABELS[l.kind]}: {money(l.amountCents)}
                {l.reason && <span className="muted small"> · {l.reason}</span>}
                {l.actorName && <span className="muted small"> · {l.actorName}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
