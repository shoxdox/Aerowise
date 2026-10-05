"use client";

import { useParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formValues } from "@/lib/api";

export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const [email, setEmail] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ email: string }>(`/auth/password-reset/${encodeURIComponent(token)}`).then(
      (r) => setEmail(r.email),
      (err) => setProblem(err instanceof ApiError ? err.message : "Could not open this link"),
    );
  }, [token]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const v = formValues(event.currentTarget);
    if (v.password !== v.confirm) {
      setError("The two passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await api(`/auth/password-reset/${encodeURIComponent(token)}`, { method: "POST", body: { password: v.password ?? "" } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change the password");
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="card stack">
        <h1>Choose a new password</h1>
        {problem && (
          <>
            <p role="alert">{problem}</p>
            <a href="/forgot-password">Ask for a new link</a>
          </>
        )}
        {done && (
          <>
            <p role="status">Your password is changed, and you are signed out everywhere. Sign in with the new password.</p>
            <a href="/login">Go to sign-in</a>
          </>
        )}
        {email && !done && (
          <form className="stack" onSubmit={onSubmit}>
            <p className="muted small">For {email}. At least 10 characters.</p>
            <label>
              New password
              <input name="password" type="password" autoComplete="new-password" minLength={10} required autoFocus />
            </label>
            <label>
              New password again
              <input name="confirm" type="password" autoComplete="new-password" minLength={10} required />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save new password"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
