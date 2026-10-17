"use client";

import type { BillingSettings } from "@aerowise/domain";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

function Billing() {
  const owner = useSession().role === "owner";
  const returned = useSearchParams().get("stripe");
  const settings = useLoad<BillingSettings>("/billing/settings");
  const { data, reload } = settings;
  const [message, setMessage] = useState<string | null>(null);

  // Coming back from Stripe's setup pages: ask Stripe where the account stands.
  useEffect(() => {
    if (returned && owner) void api("/billing/stripe/refresh", { method: "POST", body: {} }).then(reload, () => {});
  }, [returned, owner, reload]);

  const save = useSubmit(
    async (v: Record<string, string | undefined>) => {
      setMessage(null);
      await api("/billing/settings", { method: "PATCH", body: { invoiceTermsDays: Number(v.terms), defaultTaxRateBps: Math.round(Number(v.tax ?? 0) * 100) } });
      await reload();
      setMessage("Saved");
    },
    { fallback: "Could not save the invoice defaults." },
  );
  const connect = useSubmit(
    async () => {
      const { url } = await api<{ url: string }>("/billing/stripe/connect", { method: "POST", body: {} });
      window.location.href = url;
    },
    { fallback: "Could not reach Stripe." },
  );

  if (!data) return <LoadState load={settings} label="billing settings" />;

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
              <Badge tone="success">Ready</Badge>{" "}
              {data.provider === "test"
                ? "Try a simulated card or bank payment. No payment goes to Stripe or a bank."
                : "Customers can pay invoices by card or bank transfer. Payments go to your Stripe account."}
            </p>
          ) : s.accountId ? (
            <p>
              <Badge tone="warning">Setup not finished</Badge> Stripe needs a few more details before customers can pay online.
            </p>
          ) : (
            <p className="muted">Connect a Stripe account so customers can pay invoices online. Payments settle directly to your bank through Stripe.</p>
          ))}
        {owner && data.provider !== "none" && !s.chargesEnabled && (
          <div>
            <SubmitButton type="button" busy={connect.busy} busyLabel="Opening Stripe…" onClick={() => void connect.run()}>
              {s.accountId ? "Finish Stripe setup" : "Connect Stripe"}
            </SubmitButton>
          </div>
        )}
        <FormError error={connect.error} />
      </section>

      <section className="card row">
        <h2>Accounting</h2>
        <span className="muted">Send invoices, payments and customers to QuickBooks Online.</span>
        <span className="spacer" />
        <Link href="/quickbooks">QuickBooks settings</Link>
      </section>

      <form className="card grid" onSubmit={save.form}>
        <h2 className="wide">Invoice defaults</h2>
        <label>
          Payment terms (days until due)
          <input name="terms" type="number" min={0} max={120} defaultValue={data.invoiceTermsDays} disabled={!owner} required />
        </label>
        <label>
          Sales tax rate (%)
          <input name="tax" type="number" min={0} max={20} step="0.01" defaultValue={(data.defaultTaxRateBps / 100).toFixed(2)} disabled={!owner} />
        </label>
        <p className="muted small wide">
          Used for new invoices. Tax is charged only on lines marked taxable.{!owner && " Only an owner can change these."}
        </p>
        <FormError error={save.error} className="wide" />
        {owner && (
          <div className="wide row">
            <SubmitButton busy={save.busy}>Save</SubmitButton>
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
