"use client";

import type { InvitationPreview } from "@aerowise/domain";
import { useParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formValues } from "@/lib/api";

const ROLE_TEXT = { owner: "an owner", office: "office staff", technician: "a technician", read_only: "a read-only user" } as const;

export default function AcceptInvitationPage() {
  const { token } = useParams<{ token: string }>();
  const [invite, setInvite] = useState<InvitationPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<InvitationPreview>(`/invitations/accept/${encodeURIComponent(token)}`).then(setInvite, (err) =>
      setProblem(err instanceof ApiError ? err.message : "Could not open this invitation"),
    );
  }, [token]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const v = formValues(event.currentTarget);
    if (!invite?.existingUser && v.password !== v.confirm) {
      setError("The two passwords do not match");
      return;
    }
    setBusy(true);
    try {
      const me = await api<{ role: string }>(`/invitations/accept/${encodeURIComponent(token)}`, {
        method: "POST",
        body: { name: v.name, password: v.password ?? "" },
      });
      window.location.href = me.role === "technician" ? "/tech" : "/";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not accept the invitation");
      setBusy(false);
    }
  }

  return (
    <main className="login">
      {problem && (
        <div className="card stack">
          <h1>Aerowise</h1>
          <p role="alert">{problem}</p>
          <a href="/login">Go to sign-in</a>
        </div>
      )}
      {!problem && !invite && <p className="muted">Loading…</p>}
      {invite && (
        <form className="card stack" onSubmit={onSubmit}>
          <h1>Join {invite.organizationName}</h1>
          <p className="muted">
            You are invited as {ROLE_TEXT[invite.role]}, with the email {invite.email}.
          </p>
          {invite.existingUser ? (
            <>
              <p className="small">You already have an Aerowise login. Confirm with its password to add {invite.organizationName} to it.</p>
              <label>
                Password
                <input name="password" type="password" autoComplete="current-password" required autoFocus />
              </label>
            </>
          ) : (
            <>
              <label>
                Your name
                <input name="name" defaultValue={invite.name ?? ""} autoComplete="name" required />
              </label>
              <label>
                Choose a password
                <input name="password" type="password" autoComplete="new-password" minLength={10} required />
              </label>
              <label>
                Password again
                <input name="confirm" type="password" autoComplete="new-password" minLength={10} required />
              </label>
              <p className="muted small">At least 10 characters.</p>
            </>
          )}
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? "Joining…" : `Join ${invite.organizationName}`}
          </button>
        </form>
      )}
    </main>
  );
}
