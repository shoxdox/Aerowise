"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

// A prospect's demo link (W10.6): the token is in the fragment, so it never reaches a log.
export default function EnterDemoPage() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const token = window.location.hash.slice(1);
    if (!token) {
      setError("This link is missing its code. Use the full link you were sent.");
      return;
    }
    api("/demo/enter", { method: "POST", body: { token } }).then(
      () => window.location.replace("/inbox"),
      (err) => setError(err instanceof ApiError ? err.message : "Could not open the demo. Please try again."),
    );
  }, []);
  return (
    <main className="login">
      <section className="card stack">
        <h1>Your Aerowise demo</h1>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted">Opening your demo company…</p>
        )}
      </section>
    </main>
  );
}
