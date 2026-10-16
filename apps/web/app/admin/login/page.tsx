"use client";

import { useState, type FormEvent } from "react";
import { PasswordInput } from "@/components/PasswordInput";
import { api, ApiError, formValues } from "@/lib/api";
import { nextFromAddress } from "@/lib/safe-next";

export default function AdminLoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { email, password } = formValues(event.currentTarget);
    try {
      await api("/admin/auth/login", { method: "POST", body: { email, password: password ?? "" } });
      window.location.href = nextFromAddress("/admin") ?? "/admin";
    } catch (err) {
      setError(
        !(err instanceof ApiError)
          ? "Couldn't reach Aerowise. Check your connection and try again."
          : err.status === 429
            ? "Too many tries. Wait a minute, then try again."
            : err.message,
      );
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card stack" onSubmit={onSubmit}>
        <h1>Aerowise admin</h1>
        <p className="muted small">
          For the Aerowise team. Company staff sign in at the <a href="/login">regular sign-in page</a>.
        </p>
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required autoFocus />
        </label>
        <PasswordInput name="password" autoComplete="current-password" required />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
