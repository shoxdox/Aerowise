"use client";

import { useState, type FormEvent } from "react";
import { api, ApiError, formValues } from "@/lib/api";

/** Where a homeowner asks for a link to their account. The answer never says whether the address is on file. */
export default function PortalRequestPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { email } = formValues(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api("/portal/request", { method: "POST", body: { email } });
      setSentTo(email ?? "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="pay">
      <div className="pay-card">
        <div className="card stack">
          <h1>Your septic service account</h1>
          {sentTo !== null ? (
            <p>If {sentTo} is on file with your service provider, a link to your account is on its way. It can take a few minutes to arrive.</p>
          ) : (
            <form className="stack" onSubmit={(e) => void submit(e)}>
              <p>Enter the email address your service provider has for you, and we will email you a link to see your plan, visits, reports and invoices.</p>
              <label>
                Email
                <input name="email" type="email" required autoComplete="email" />
              </label>
              {error && <p className="error">{error}</p>}
              <button type="submit" disabled={busy}>
                Email me a link
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
