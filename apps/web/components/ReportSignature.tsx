"use client";

import type { ReportSigning } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { when } from "@/lib/format";

/**
 * The licensed maintenance provider's signature on the latest authority report
 * (30 TAC 285.7(b)(3)): who signed it and what they attested, or the statement and a
 * typed-name signature for an MP who can sign it now.
 */
export function ReportSignature({ inspectionId, editable, onSigned }: { inspectionId: string; editable: boolean; onSigned: () => void }) {
  const { data, reload } = useLoad<ReportSigning>(`/inspections/${inspectionId}/signature`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;

  async function sign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/inspections/${inspectionId}/signature`, { method: "POST", body: { typedName: formValues(event.currentTarget).typedName } });
      await reload();
      onSigned();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign");
    } finally {
      setBusy(false);
    }
  }

  const s = data.signature;
  return (
    <section className="card stack">
      <h2>Maintenance provider signature</h2>
      {s ? (
        <>
          <p className="small">
            Report version {data.version} signed by <strong>{s.signedByName}</strong>, MP {s.licenseNumber}, {when(s.signedAt)}. The filing sends this signed copy.
          </p>
          <blockquote className="small" style={{ margin: 0, paddingLeft: 12, borderLeft: "3px solid #d9dfdc" }}>{s.statement}</blockquote>
          <div className="muted small">Signed copy SHA-256 {s.sha256}</div>
        </>
      ) : (
        <>
          <p className="small">30 TAC 285.7(b)(3) requires the licensed maintenance provider to sign every maintenance report. Report version {data.version} is not signed yet, so it cannot be filed.</p>
          <blockquote className="small" style={{ margin: 0, paddingLeft: 12, borderLeft: "3px solid #d9dfdc" }}>{data.statement}</blockquote>
          {data.problems.length > 0 ? (
            <ul className="restriction small">
              {data.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : (
            editable && (
              <form className="stack" onSubmit={sign}>
                <label>
                  Type your name as it appears on your MP license{data.holderName ? ` (${data.holderName})` : ""} to sign
                  <input name="typedName" required autoComplete="off" />
                </label>
                <button className="primary" disabled={busy}>
                  Sign report version {data.version}
                </button>
              </form>
            )
          )}
          {error && <p className="error">{error}</p>}
        </>
      )}
    </section>
  );
}
