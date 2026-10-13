"use client";

import type { ReportSigning } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { LoadState } from "@/components/LoadState";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { when } from "@/lib/format";

/**
 * The licensed maintenance provider's signature on the latest authority report
 * (30 TAC 285.7(b)(3)): who signed it and what they attested, or the statement and a
 * typed-name signature for an MP who can sign it now.
 */
export function ReportSignature({ inspectionId, editable, onSigned }: { inspectionId: string; editable: boolean; onSigned: () => void }) {
  const recordLoad = useLoad<ReportSigning>(`/inspections/${inspectionId}/signature`);
  const { data, reload } = recordLoad;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return <LoadState load={recordLoad} label="provider signature" />;

  async function sign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const v = formValues(event.currentTarget);
    try {
      await api(`/inspections/${inspectionId}/signature`, { method: "POST", body: { typedName: v.typedName, delegationNote: v.delegationNote || null } });
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
      <LoadState load={recordLoad} label="provider signature" />
      <h2>Maintenance provider signature</h2>
      {s ? (
        <>
          <p className="small">
            Report version {data.version} signed by <strong>{s.signedByName}</strong>, MP {s.licenseNumber}, {when(s.signedAt)}. The filing sends this signed copy.
          </p>
          <blockquote className="small" style={{ margin: 0, paddingLeft: 12, borderLeft: "3px solid #d9dfdc" }}>{s.statement}</blockquote>
          {s.delegationNote && <div className="small">Signed under a documented delegation: {s.delegationNote}</div>}
          <div className="muted small">Signed copy SHA-256 {s.sha256}</div>
          {data.customerCopy && <div className="muted small">Customer copy version {data.customerCopy.version}: {data.customerCopy.signed ? "signed, and the only copy the customer gets" : "not signed"}</div>}
        </>
      ) : (
        <>
          {data.required ? (
            <p className="small">
              30 TAC 285.7(b)(3) requires the licensed maintenance provider to sign every maintenance report. Report version {data.version} is not signed yet, so it cannot be filed, and the
              customer&apos;s copy is held until it is. Signing signs both.
            </p>
          ) : (
            <p className="small">
              Report version {data.version} is not signed. This demo&apos;s example county rules don&apos;t hold the filing or the customer&apos;s copy for a signature. A real report must be
              signed by the licensed maintenance provider (30 TAC 285.7(b)(3)) before it is filed or sent; you can try signing here.
            </p>
          )}
          {data.provider && (
            <p className="small">
              Signs by default: <strong>{data.provider.name}</strong>, MP {data.provider.number} ({data.provider.source === "contract" ? "named on the site's contract" : "the organization's responsible MP"}).
            </p>
          )}
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
                {data.delegationRequired && (
                  <label>
                    You are signing for {data.provider?.name}. Describe the documented delegation and how you supervise this work
                    <textarea name="delegationNote" required minLength={20} rows={3} />
                  </label>
                )}
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
