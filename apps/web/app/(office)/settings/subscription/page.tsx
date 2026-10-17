"use client";

import { SUBSCRIPTION_STATE_LABELS, type SubscriptionOverview } from "@aerowise/domain";
import { useEffect } from "react";
import { LoadState, NotForYourRole } from "@/components/LoadState";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { day, money, plural } from "@/lib/format";
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
    return `${label}: ${left > 0 ? `${plural(left, "day")} left` : left === 0 ? "ends today" : "ended"}, until ${day(plan.endsOn!)}`;
  }
  if (plan.state === "past_due") return `${label}: the last payment did not go through`;
  if (plan.state === "read_only") return `${label}: you can view and export everything; add a payment method to reactivate`;
  return label;
}

export default function SubscriptionPage() {
  const me = useSession();
  const subscription = useLoad<SubscriptionOverview>(me.role === "owner" ? "/subscription" : null);
  const { data, reload } = subscription;
  const managePayment = useSubmit(
    async () => {
      const { url } = await api<{ url: string }>("/subscription/payment-method", { method: "POST", body: {} });
      window.location.href = url;
    },
    { fallback: "Could not reach Stripe." },
  );

  // Back from Stripe with a new payment method: check the plan again, which reactivates a
  // lapsed company. A change of plan reloads the page so the read-only banner goes too.
  useEffect(() => {
    if (me.role !== "owner" || !new URLSearchParams(window.location.search).has("payment")) return;
    window.history.replaceState(null, "", window.location.pathname);
    void api<{ changed: boolean }>("/subscription/refresh", { method: "POST", body: {} })
      .then((r) => (r.changed ? window.location.reload() : reload()))
      .catch(() => undefined);
  }, [me.role, reload]);

  if (me.role !== "owner") return <NotForYourRole />;
  if (!data) return <LoadState load={subscription} label="subscription" />;

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
          {estimate.charged || free ? " estimated" : " (not charged while read-only)"} for {plural(estimate.activeContracts, "active contract")} as of {day(estimate.countedOn)}.
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
              <SubmitButton type="button" busy={managePayment.busy} busyLabel="Opening Stripe…" onClick={() => void managePayment.run()}>
                {paymentMethod ? "Change payment method" : "Add payment method"}
              </SubmitButton>
            </div>
          </>
        )}
        <FormError error={managePayment.error} />
      </section>

      <section className="stack">
        <h2>Invoices</h2>
        {data.invoices.length === 0 ? (
          <p className="muted">No invoices yet.</p>
        ) : (
          <table className="stack">
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Active contracts</th>
                <th className="num">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((i) => (
                <tr key={i.id}>
                  <td data-label="Month">{day(i.startsOn, { month: "long", year: "numeric" })}</td>
                  <td data-label="Active contracts" className="num">
                    {i.activeContracts}
                  </td>
                  <td data-label="Amount" className="num">
                    {money(i.amountCents)}
                  </td>
                  <td data-label="Status">
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
