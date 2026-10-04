"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, ApiError } from "@/lib/api";

const OUTCOMES = [
  { key: "card", label: "Pay by card" },
  { key: "ach_clears", label: "Pay by bank (clears)" },
  { key: "ach_pending", label: "Pay by bank (still clearing)" },
  { key: "ach_fails", label: "Pay by bank (fails)" },
  { key: "declined", label: "Card declined" },
] as const;

/**
 * Stands in for Stripe's checkout page when the server runs the built-in test provider.
 * Each button plays the webhooks Stripe would send for that outcome.
 */
function TestCheckout() {
  const { token } = useParams<{ token: string }>();
  const search = useSearchParams();
  const sessionId = search.get("session") ?? "";
  // Where Stripe would send the customer after paying: this site only.
  const done = search.get("done");
  const returnTo = done?.startsWith("/") && !done.startsWith("//") ? done : `/pay/${token}?paid=1`;
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function finish(outcome: (typeof OUTCOMES)[number]["key"]) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api<{ ok: boolean; message: string }>(`/pay/${token}/test-checkout`, { method: "POST", body: { sessionId, outcome } });
      if (res.ok) router.push(returnTo);
      else setMessage(res.message);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="pay">
      <div className="pay-card">
        <p className="test-mode">Test checkout. This page stands in for Stripe; no money moves.</p>
        <div className="card stack">
          <h1>Choose what happens</h1>
          {OUTCOMES.map((o) => (
            <button key={o.key} className={o.key === "card" ? undefined : "secondary"} disabled={busy} onClick={() => void finish(o.key)}>
              {o.label}
            </button>
          ))}
          {message && <p className="error">{message}</p>}
          <Link href={`/pay/${token}`}>Back to the invoice</Link>
        </div>
      </div>
    </main>
  );
}

export default function TestCheckoutPage() {
  return (
    <Suspense>
      <TestCheckout />
    </Suspense>
  );
}
