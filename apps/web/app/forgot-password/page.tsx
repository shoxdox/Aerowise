"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { api, ApiError, formValues } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/password-reset", { method: "POST", body: { email: formValues(event.currentTarget).email ?? "" } });
      setSent(true);
    } catch (err) {
      setError(
        !(err instanceof ApiError)
          ? "Couldn't reach Aerowise. Check your connection and try again."
          : err.status === 429
            ? "Too many requests for this email. Wait a minute, then try again."
            : err.message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card stack" onSubmit={onSubmit}>
        <Link href="/" className="brand">
          <img src="/icons/icon.svg" alt="" width={32} height={32} />
          Aerowise
        </Link>
        <h1>Reset your password</h1>
        {sent ? (
          <p role="status">If that email has an Aerowise login, a reset link is on its way. It works for an hour.</p>
        ) : (
          <>
            <p className="muted small">Enter the email you sign in with and we will send you a link to choose a new password.</p>
            <label>
              Email
              <input name="email" type="email" autoComplete="username" required autoFocus />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </>
        )}
        <a href="/login" className="small">
          Back to sign-in
        </a>
      </form>
    </main>
  );
}
