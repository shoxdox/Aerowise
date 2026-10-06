"use client";

import { CURRENT_LEGAL_VERSIONS, LEGAL_DOCUMENT_TITLES, type LegalDocument } from "@aerowise/domain";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

const HREF: Record<LegalDocument, string> = { terms: "/terms", privacy: "/privacy" };

/** Shown to an owner instead of the office screens until they accept the current terms and privacy policy. */
export function LegalGate({ due, companyName }: { due: LegalDocument[]; companyName: string }) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await api("/legal/accept", { method: "POST", body: CURRENT_LEGAL_VERSIONS });
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record your acceptance");
      setBusy(false);
    }
  }

  return (
    <section className="card stack legal-gate" aria-labelledby="legal-gate-title">
      <h1 id="legal-gate-title">{due.length === 2 ? "Before you start" : "We updated our terms"}</h1>
      <p>As the owner of {companyName}, please read and accept these on your company&apos;s behalf:</p>
      <ul>
        {due.map((d) => (
          <li key={d}>
            <a href={HREF[d]} target="_blank" rel="noopener">
              {LEGAL_DOCUMENT_TITLES[d]}
            </a>{" "}
            <span className="muted small">(version {CURRENT_LEGAL_VERSIONS[d]})</span>
          </li>
        ))}
      </ul>
      <label className="check">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />I have read and accept them
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button onClick={accept} disabled={!agreed || busy}>
        {busy ? "Saving…" : "Accept and continue"}
      </button>
    </section>
  );
}
