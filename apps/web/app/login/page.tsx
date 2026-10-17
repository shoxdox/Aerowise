"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { PasswordInput } from "@/components/PasswordInput";
import { api, ApiError, formValues } from "@/lib/api";
import { useDemoMode } from "@/lib/demo";
import { nextFromAddress } from "@/lib/safe-next";

/** What went wrong, in words that say what to do next. */
function signInProblem(err: unknown): string {
  if (!(err instanceof ApiError)) return "Couldn't reach Aerowise. Check your connection and try again.";
  if (err.code === "invalid_credentials") return "That email and password don't match. Check both, or reset your password below.";
  if (err.code === "no_membership") return "Your access to this company has been turned off. Ask the company's owner if that's a mistake.";
  if (err.status === 429) return "Too many tries. Wait a minute, then try again.";
  return err.message;
}

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const demo = useDemoMode();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { email, password } = formValues(event.currentTarget);
    try {
      const me = await api<{ role: string }>("/auth/login", { method: "POST", body: { email, password: password ?? "" } });
      // Technicians work from the phone app, so a texted office link (which their role can't
      // use) still lands them on their route; everyone else goes where the link pointed.
      const technician = me.role === "technician";
      window.location.href = nextFromAddress(technician ? "/tech" : "/") ?? (technician ? "/tech" : "/inbox");
    } catch (err) {
      setError(signInProblem(err));
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
        <h1>Sign in</h1>
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
        <a href="/forgot-password" className="small">
          Forgot your password?
        </a>
        {demo && (
          <p className="muted small" data-testid="demo-start">
            New here? <a href="/demo">Try the demo</a> with a fictional company of your own. No sign-up or password needed.
          </p>
        )}
      </form>
    </main>
  );
}
