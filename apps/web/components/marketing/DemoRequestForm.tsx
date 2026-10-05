"use client";

import { useState, type FormEvent } from "react";
import { api, ApiError, formValues } from "@/lib/api";
import { DEMO } from "./copy";

/** The public "ask for a demo" form. Lands in /admin and emails Aerowise. */
export function DemoRequestForm() {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("sending");
    setError(null);
    try {
      await api("/public/demo-requests", { method: "POST", body: formValues(event.currentTarget) });
      setState("sent");
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 429 ? DEMO.tooMany : err.message) : DEMO.failed);
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <p className="card" role="status">
        {DEMO.thanks}
      </p>
    );
  }
  return (
    <form className="card stack" onSubmit={onSubmit} aria-label="Ask for a demo">
      <label>
        Your name
        <input name="name" autoComplete="name" required maxLength={120} />
      </label>
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required maxLength={320} />
      </label>
      <label>
        Company
        <input name="company" autoComplete="organization" required maxLength={160} />
      </label>
      <label>
        Phone (optional)
        <input name="phone" type="tel" autoComplete="tel" maxLength={40} />
      </label>
      <label>
        Counties you work in (optional)
        <input name="counties" maxLength={300} />
      </label>
      <label>
        Anything else (optional)
        <textarea name="message" rows={3} maxLength={2000} />
      </label>
      {/* Spam trap: hidden from people and screen readers; bots that fill it are dropped. */}
      <div className="trap" aria-hidden="true">
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={state === "sending"}>
        {state === "sending" ? "Sending…" : DEMO.button}
      </button>
    </form>
  );
}
