"use client";

import type { BillingSettings } from "@aerowise/domain";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { useSession } from "@/lib/session";

function Billing() {
  const owner = useSession().role === "owner";
  const returned = useSearchParams().get("stripe");
  const { data, error, reload } = useLoad<BillingSettings>("/billing/settings");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Coming back from Stripe's setup pages: ask Stripe where the account stands.
  useEffect(() => {
    if (returned && owner) void api("/billing/stripe/refresh", { method: "POST", body: {} }).then(reload, () => {});
  }, [returned, owner, reload]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    setMessage(null);
    try {
      await api("/billing/settings", { method: "PATCH", body: { invoiceTermsDays: Number(v.terms), defaultTaxRateBps: Math.round(Number(v.tax ?? 0) * 100) } });
      await reload();
      setMessage("Saved");
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function connect() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>("/billing/stripe/connect", { method: "POST", body: {} });
      window.location.href = url;
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Could not reach Stripe");
      setBusy(false);
    }
  }

  const s = data.stripe;
  return (
    <div className="stack">
      <h1>Billing</h1>

      <section className="card stack">
        <h2>Online payments</h2>
        {data.provider === "none" && <p className="muted">Online payments are not configured on this server. Customers can still be invoiced and pay by check.</p>}
        {data.provider === "test" && <p className="restriction small">This server uses the built-in test provider: checkout is simulated and no money moves.</p>}
        {data.provider !== "none" &&
          (s.chargesEnabled ? (
            <p>
              <span className="badge ok">Ready</span>{" "}
              {data.provider === "test"
                ? "Try a simulated card or bank payment. No payment goes to Stripe or a bank."
                : "Customers can pay invoices by card or bank transfer. Payments go to your Stripe account."}
            </p>
          ) : s.accountId ? (
            <p>
              <span className="badge warn">Setup not finished</span> Stripe needs a few more details before customers can pay online.
            </p>
          ) : (
            <p className="muted">Connect a Stripe account so customers can pay invoices online. Payments settle directly to your bank through Stripe.</p>
          ))}
        {owner && data.provider !== "none" && !s.chargesEnabled && (
          <div>
            <button disabled={busy} onClick={() => void connect()}>
              {s.accountId ? "Finish Stripe setup" : "Connect Stripe"}
            </button>
          </div>
        )}
      </section>

      <section className="card row">
        <h2>Accounting</h2>
        <span className="muted">Send invoices, payments and customers to QuickBooks Online.</span>
        <span className="spacer" />
        <Link href="/quickbooks">QuickBooks settings</Link>
      </section>

      <form className="card grid" onSubmit={save}>
        <h2 className="wide">Invoice defaults</h2>
        <label>
          Payment terms (days until due)
          <input name="terms" type="number" min={0} max={120} defaultValue={data.invoiceTermsDays} disabled={!owner} required />
        </label>
        <label>
          Sales tax rate (%)
          <input name="tax" type="number" min={0} max={20} step="0.01" defaultValue={(data.defaultTaxRateBps / 100).toFixed(2)} disabled={!owner} />
        </label>
        <p className="muted small wide">Used for new invoices. Tax is charged only on lines marked taxable.</p>
        {owner && (
          <div className="wide row">
            <button type="submit">Save</button>
            {message && <span className="muted">{message}</span>}
          </div>
        )}
      </form>
    </div>
  );
}

export default function BillingSettingsPage() {
  return (
    <Suspense>
      <Billing />
    </Suspense>
  );
}
