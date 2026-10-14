"use client";

import { useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useLoad } from "@/components/useLoad";
import { LoadState } from "@/components/LoadState";
import Link from "next/link";

// "Try the demo" (W10.2): a demo company of the visitor's own, signed in as its owner.
export default function TryTheDemoPage() {
  const availability = useLoad<{ demo: boolean; demoVisitor: boolean }>("/app-info");
  const demo = availability.data?.demo;
  const starting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (starting.current) return;
    starting.current = true;
    setBusy(true);
    setError(null);
    try {
      await api("/demo/start", { method: "POST", body: {} });
      window.location.href = "/inbox";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the demo. Please try again.");
      starting.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <section className="card stack">
        <h1>Try Aerowise</h1>
        <p>
          You&apos;ll get a sample maintenance company of your own, with customers, contracts and a year of inspections, reports and invoices already in it. Look
          around as the owner, the office manager or the technician; a short guided tour is there if you want it.
        </p>
        <p className="muted small">Nothing is emailed, texted, filed or charged. Your sample company is private to you and lasts 24 hours.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <LoadState load={availability} label="demo availability" />
        {availability.data?.demoVisitor && <Link href="/inbox" className="button secondary">Return to my existing private demo</Link>}
        {demo ? (
          <button onClick={() => void start()} disabled={busy}>
            {busy ? "Preparing your demo company…" : "Start my demo"}
          </button>
        ) : (
          availability.data && <p className="muted">The private demo runs on the <a href="https://staging.deshain.com/demo">staging demo site</a>. Contact Justin from the homepage for a guided pilot.</p>
        )}
      </section>
    </main>
  );
}
