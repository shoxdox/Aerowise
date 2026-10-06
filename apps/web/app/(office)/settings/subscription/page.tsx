"use client";

import { SUBSCRIPTION_STATE_LABELS, type SubscriptionOverview } from "@aerowise/domain";
import { useEffect, useState } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";
import { day, money } from "@/lib/format";
import { useSession } from "@/lib/session";

const INVOICE_STATUS: Record<SubscriptionOverview["invoices"][number]["status"], string> = {
  free: "Free",
  pending: "Not billed yet",
  open: "Due",
  paid: "Paid",
  failed: "Payment failed",
  void: "Void",
};

function planLine(plan: SubscriptionOverview["plan"]) {
  const label = SUBSCRIPTION_STATE_LABELS[plan.state];
  if (plan.state === "trial" || plan.state === "design_partner") {
    const left = plan.daysLeft ?? 0;
    return `${label}: ${left > 0 ? `${left} days left` : left === 0 ? "ends today" : "ended"}, until ${day(plan.endsOn!)}`;
  }
  if (plan.state === "past_due") return `${label}: the last payment did not go through`;
  if (plan.state === "read_only") return `${label}: you can view and export everything; add a payment method to reactivate`;
  return label;
}

export default function SubscriptionPage() {
  const me = useSession();
  const { data, error, reload } = useLoad<SubscriptionOverview>(me.role === "owner" ? "/subscription" : null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Back from Stripe with a new payment method: check the plan again, which reactivates a
  // lapsed company. A change of plan reloads the page so the read-only banner goes too.
  useEffect(() => {
    if (me.role !== "owner" || !new URLSearchParams(window.location.search).has("payment")) return;
    window.history.replaceState(null, "", window.location.pathname);
    void api<{ changed: boolean }>("/subscription/refresh", { method: "POST", body: {} })
      .then((r) => (r.changed ? window.location.reload() : reload()))
      .catch(() => undefined);
  }, [me.role, reload]);

  if (me.role !== "owner") return <p className="muted">Only the owner can see the company's Aerowise subscription.</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  async function managePayment() {
    setBusy(true);
    setMessage(null);
    try {
      const { url } = await api<{ url: string }>("/subscription/payment-method", { method: "POST", body: {} });
      window.location.href = url;
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Could not reach Stripe");
      setBusy(false);
    }
  }

  const { plan, price, estimate, paymentMethod } = data;
  const free = plan.state === "trial" || plan.state === "design_partner";
  return (
    <div className="stack">
      <h1>Aerowise subscription</h1>
      <p className="muted small">What your company pays Aerowise. Payments from your customers are under Billing.</p>

      <section className="card stack">
        <h2>Plan</h2>
        <p data-testid="plan-line">{planLine(plan)}</p>
        <p className="muted">
          {money(price.pricePerContractCents)} per active contract per month, {money(price.monthlyMinimumCents)} minimum
          {price.founder ? " (your founder price)" : ""}.
        </p>
      </section>

      <section className="card stack">
        <h2>{free ? "After your free period" : "This month"}</h2>
        <p data-testid="estimate">
          <strong>{money(estimate.amountCents)}</strong>
          {estimate.charged || free ? " estimated" : " (not charged while read-only)"} for {estimate.activeContracts} active{" "}
          {estimate.activeContracts === 1 ? "contract" : "contracts"} as of {day(estimate.countedOn)}.
        </p>
        <p className="muted small">
          {free
            ? `Nothing is charged until ${day(plan.endsOn!)}.`
            : "Each month is counted on the 1st: contracts in force that day, including ones that are ending."}
        </p>
      </section>

      <section className="card stack">
        <h2>Payment method</h2>
        {data.provider === "none" && <p className="muted">Paying for Aerowise online is not set up yet. Aerowise will contact you about your first invoice.</p>}
        {data.provider === "test" && <p className="restriction small">This server uses the built-in test provider: no card is charged.</p>}
        {data.provider !== "none" && (
          <>
            <p data-testid="payment-method">
              {paymentMethod
                ? `${paymentMethod.label} ending ${paymentMethod.last4}${paymentMethod.expires ? `, expires ${paymentMethod.expires}` : ""}`
                : data.provider === "test"
                  ? "No test payment method saved yet. Adding one only simulates monthly billing."
                  : "No payment method saved yet. Invoices are charged to it automatically each month."}
            </p>
            <div>
              <button disabled={busy} onClick={() => void managePayment()}>
                {paymentMethod ? "Change payment method" : "Add payment method"}
              </button>
            </div>
          </>
        )}
        {message && <p className="error">{message}</p>}
      </section>

      <section className="stack">
        <h2>Invoices</h2>
        {data.invoices.length === 0 ? (
          <p className="muted">No invoices yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Active contracts</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((i) => (
                <tr key={i.id}>
                  <td>{day(i.startsOn, { month: "long", year: "numeric" })}</td>
                  <td>{i.activeContracts}</td>
                  <td>{money(i.amountCents)}</td>
                  <td>
                    {i.hostedInvoiceUrl ? (
                      <a href={i.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                        {INVOICE_STATUS[i.status]}
                      </a>
                    ) : (
                      INVOICE_STATUS[i.status]
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
