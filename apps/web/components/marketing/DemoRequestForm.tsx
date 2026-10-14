"use client";

import { demoRequestReceipt, type DemoRequestReceipt } from "@aerowise/domain";
import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ApiError, formValues } from "@/lib/api";
import { WALKTHROUGH } from "./copy";

const ATTEMPT_STORAGE = "aerowise.pilotRequestAttempt.v1";
type RememberedAttempt = { key: string; fingerprint: string };

async function fingerprintOf(body: Record<string, string | undefined>): Promise<string | null> {
  try {
    const normalized = Object.fromEntries(Object.keys(body).sort().filter((key) => body[key] !== undefined).map((key) => [key, key === "email" ? body[key]!.toLowerCase() : body[key]]));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(normalized)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    // If hashing is unavailable, the in-memory attempt still protects repeated taps/retries.
    return null;
  }
}

function rememberedAttempt(): RememberedAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(ATTEMPT_STORAGE) ?? "null") as Partial<RememberedAttempt> | null;
    return value && typeof value.key === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.key) && typeof value.fingerprint === "string" && /^[0-9a-f]{64}$/.test(value.fingerprint) ? value as RememberedAttempt : null;
  } catch { return null; }
}

function rememberAttempt(value: RememberedAttempt | null) {
  try {
    if (value) sessionStorage.setItem(ATTEMPT_STORAGE, JSON.stringify(value));
    else sessionStorage.removeItem(ATTEMPT_STORAGE);
  } catch { /* Storage-blocked browsers retain only the current page's in-memory attempt. */ }
}

/** Saved in /admin, which alerts the platform contacts. A tab-session key/fingerprint survives lost confirmations without storing contact fields. */
export function DemoRequestForm() {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<DemoRequestReceipt | null>(null);
  const [sentTo, setSentTo] = useState("");
  const active = useRef(false);
  const attempt = useRef<{ key: string; body: string } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current) return;
    active.current = true;
    const body = formValues(event.currentTarget);
    const serialized = JSON.stringify(body);
    setState("sending");
    setError(null);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fingerprint = await fingerprintOf(body);
      const remembered = fingerprint ? rememberedAttempt() : null;
      if (attempt.current?.body !== serialized) attempt.current = { key: remembered?.fingerprint === fingerprint ? remembered.key : crypto.randomUUID(), body: serialized };
      rememberAttempt(fingerprint ? { key: attempt.current!.key, fingerprint } : null);
      timer = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch("/api/public/demo-requests", { method: "POST", credentials: "omit", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, submissionKey: attempt.current!.key }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new ApiError(response.status, result.error ?? "request_failed", result.message ?? WALKTHROUGH.failed);
      setReceipt(demoRequestReceipt.parse(result));
      setSentTo(body.email ?? "");
      setState("sent");
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 429 ? WALKTHROUGH.tooMany : err.status >= 500 ? WALKTHROUGH.failed : err.message) : WALKTHROUGH.failed);
      setState("idle");
    } finally {
      clearTimeout(timer);
      active.current = false;
    }
  }

  if (state === "sent") {
    return (
      <div className="card stack home-form" role="status">
        <strong>{WALKTHROUGH.thanks}</strong>
        <p>{receipt?.duplicate ? WALKTHROUGH.duplicate : WALKTHROUGH.reply(sentTo)}</p>
        <button type="button" className="link" onClick={() => { rememberAttempt(null); attempt.current = null; setReceipt(null); setError(null); setState("idle"); }}>{WALKTHROUGH.another}</button>
      </div>
    );
  }
  return (
    <form className="card stack home-form" onSubmit={onSubmit} aria-label="Request a walkthrough">
      <div className="home-form-row">
        <label>
          Your name
          <input name="name" autoComplete="name" required maxLength={120} />
        </label>
        <label>
          Company
          <input name="company" autoComplete="organization" required maxLength={160} />
        </label>
      </div>
      <div className="home-form-row">
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required maxLength={320} />
        </label>
        <label>
          Phone (optional)
          <input name="phone" type="tel" autoComplete="tel" maxLength={40} />
        </label>
      </div>
      <label>
        Counties you work in (optional)
        <input name="counties" maxLength={300} placeholder="e.g. Williamson, Travis" />
      </label>
      <label>
        Anything we should know? (optional)
        <textarea name="message" rows={3} maxLength={2000} placeholder="How many contracts, what you use today…" />
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
        {state === "sending" ? WALKTHROUGH.sending : WALKTHROUGH.button}
      </button>
      <p className="home-fine">{WALKTHROUGH.privacy} <Link href="/privacy">Privacy policy</Link></p>
    </form>
  );
}
