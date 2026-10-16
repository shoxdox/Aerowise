"use client";

import type { ReportSigning } from "@aerowise/domain";
import { LoadState } from "@/components/LoadState";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { mpNumber, when } from "@/lib/format";

/**
 * The licensed maintenance provider's signature on the latest authority report
 * (30 TAC 285.7(b)(3)): who signed it and what they attested, or the statement and a
 * typed-name signature for an MP who can sign it now.
 */
export function ReportSignature({ inspectionId, editable, onSigned }: { inspectionId: string; editable: boolean; onSigned: () => void }) {
  const recordLoad = useLoad<ReportSigning>(`/inspections/${inspectionId}/signature`);
  const { data, reload } = recordLoad;
  const signing = useSubmit(
    async (v: Record<string, string | undefined>) => {
      await api(`/inspections/${inspectionId}/signature`, { method: "POST", body: { typedName: v.typedName, delegationNote: v.delegationNote || null } });
      await reload();
      onSigned();
    },
    { fallback: "Could not sign the report." },
  );
  if (!data) return <LoadState load={recordLoad} label="provider signature" />;

  const s = data.signature;
  return (
    <section className="card stack">
      <LoadState load={recordLoad} label="provider signature" />
      <h2>Maintenance provider signature</h2>
      {s ? (
        <>
          <p className="small">
            Report version {data.version} signed by <strong>{s.signedByName}</strong>, {mpNumber(s.licenseNumber)}, {when(s.signedAt)}. The filing sends this signed copy.
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
              Signs by default: <strong>{data.provider.name}</strong>, {mpNumber(data.provider.number)} ({data.provider.source === "contract" ? "named on the site's contract" : "the organization's responsible MP"}).
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
              <form className="stack" onSubmit={signing.form}>
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
                <div>
                  <SubmitButton busy={signing.busy} busyLabel="Signing…">
                    Sign report version {data.version}
                  </SubmitButton>
                </div>
              </form>
            )
          )}
          <FormError error={signing.error} />
        </>
      )}
    </section>
  );
}
