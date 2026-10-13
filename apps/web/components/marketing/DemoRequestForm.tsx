"use client";

import { demoRequestReceipt, type DemoRequestReceipt } from "@aerowise/domain";
import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ApiError, formValues } from "@/lib/api";
import { CONTACT, DEMO } from "./copy";

/** The public "ask for a demo" form. Lands in /admin and emails Aerowise. */
export function DemoRequestForm() {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<DemoRequestReceipt | null>(null);
  const active = useRef(false);
  const attempt = useRef<{ key: string; body: string } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current) return;
    active.current = true;
    const body = formValues(event.currentTarget);
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) attempt.current = { key: crypto.randomUUID(), body: serialized };
    setState("sending");
    setError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch("/api/public/demo-requests", { method: "POST", credentials: "omit", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, submissionKey: attempt.current!.key }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new ApiError(response.status, result.error ?? "request_failed", result.message ?? DEMO.failed);
      setReceipt(demoRequestReceipt.parse(result));
      setState("sent");
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 429 ? DEMO.tooMany : err.status >= 500 ? DEMO.failed : err.message) : DEMO.failed);
      setState("idle");
    } finally {
      clearTimeout(timer);
      active.current = false;
    }
  }

  if (state === "sent") {
    return (
      <div className="card stack" role="status">
        <strong>{DEMO.thanks}</strong>
        {receipt?.duplicate && <p>This retry reused your saved request; no duplicate request was created.</p>}
        <p>{receipt?.notification === "simulated" ? "The alert is recorded in a simulated test outbox. No notification email reached Justin." : receipt?.notification === "provider_accepted" ? "A mail provider accepted the notification; that is not a guarantee Justin has read or received it." : receipt?.notification === "failed" ? "The notification failed. Your saved request is still visible to the administrator." : "Notification delivery has not been confirmed."}</p>
        <a href={`mailto:${CONTACT.email}`}>Email Justin directly: {CONTACT.email}</a>
        <a href={CONTACT.phoneHref}>Call {CONTACT.phone}</a>
      </div>
    );
  }
  return (
    <form className="card stack" onSubmit={onSubmit} aria-label="Save a pilot request">
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
      <p className="muted small">This saves your contact details and message for private admin follow-up. <Link href="/privacy">Read the privacy policy</Link>. Do not include customer records, permits or sensitive information.</p>
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
        {state === "sending" ? "Saving request…" : DEMO.button}
      </button>
    </form>
  );
}
