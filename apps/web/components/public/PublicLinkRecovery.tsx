"use client";

import Link from "next/link";
import type { ApiError } from "@/lib/api";

export function PublicLinkRecovery({ error, retry, kind, provider }: { error: ApiError; retry: () => Promise<void>; kind: "invoice" | "renewal" | "estimate" | "account"; provider?: { name: string; phone: string | null; email: string | null } }) {
  const expired = error.code === "expired";
  const revoked = error.code === "revoked";
  const unavailable = error.status === 404 || error.status === 410 || expired || revoked || error.status === 400;
  const title = expired ? "This link has expired" : revoked ? "This link was turned off" : unavailable ? `This ${kind} link was not found` : error.code === "offline" ? "You are offline" : error.code === "stalled" ? "The request took too long" : error.status === 429 ? "Please wait before trying again" : "This page could not load";
  return <main className="pay"><div className="pay-card card stack" role="alert">
    <h1>{title}</h1>
    <p>{unavailable ? "Check that you opened the complete link from your provider. If it has ended or was replaced, ask your provider for a current link." : "Your link may still be valid. Check your connection and retry. No payment or signature was submitted by this read."}</p>
    {!unavailable && <button onClick={() => void retry()}>Retry</button>}
    {unavailable && kind === "account" && <Link href="/portal">Email me a new link</Link>}
    {provider ? <p>Contact {provider.name}{provider.phone && <> · <a href={`tel:${provider.phone}`}>{provider.phone}</a></>}{provider.email && <> · <a href={`mailto:${provider.email}`}>{provider.email}</a></>}.</p> : <p className="muted small">Your provider&apos;s contact details are in the original email or agreement.</p>}
  </div></main>;
}
