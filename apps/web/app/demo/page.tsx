"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useDemoMode } from "@/lib/demo";

// "Try the demo" (W10.2): a demo company of the visitor's own, signed in as its owner.
export default function TryTheDemoPage() {
  const demo = useDemoMode();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await api("/demo/start", { method: "POST", body: {} });
      window.location.href = "/inbox";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the demo. Please try again.");
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <section className="card stack">
        <h1>Try Aerowise</h1>
        <p>
          You get a fictional aerobic maintenance company of your own, with customers, sites, contracts and a year of work already in it: inspections filed
          with LCRA and with a fictional county, their reports and proof on each site, a renewal sent and invoices paid and unpaid. You start as its owner
          and can look around as the office manager or the technician.
        </p>
        <p className="muted small">Nothing is emailed, texted, filed or charged. Your demo company is private to you and is deleted after a day.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {demo ? (
          <button onClick={() => void start()} disabled={busy}>
            {busy ? "Preparing your demo company…" : "Start my demo"}
          </button>
        ) : (
          <p className="muted">The demo runs on the demo site only.</p>
        )}
      </section>
    </main>
  );
}
