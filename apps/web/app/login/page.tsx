"use client";

import { useState, type FormEvent } from "react";
import { api, ApiError, formValues } from "@/lib/api";

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { email, password } = formValues(event.currentTarget);
    try {
      const me = await api<{ role: string }>("/auth/login", { method: "POST", body: { email, password: password ?? "" } });
      const next = new URLSearchParams(window.location.search).get("next");
      // Technicians land on their phone app; everyone else on the office screens.
      const home = me.role === "technician" ? "/tech" : "/inbox";
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : home;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in");
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card stack" onSubmit={onSubmit}>
        <h1>Aerowise</h1>
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required autoFocus />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
