"use client";

import type { CustomerDelivery, FilingStatus } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { FilingStatusBadge } from "@/components/FilingBadges";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";
import { day, when } from "@/lib/format";

interface Status {
  signedAt: string | null;
  signedDocumentSha256: string | null;
  uploadedDocuments: { id: string; filename: string; sha256: string; signedOn: string | null; uploadedAt: string; url: string }[];
  customerCopy: CustomerDelivery[];
  authority: { filingId: string; status: FilingStatus; deadlineOn: string | null; sentAt: string | null; confirmedAt: string | null; reviewReason: string | null } | null;
}

/**
 * A contract's paperwork, each step on its own line: signed, the customer's copy emailed,
 * filed with the authority, acknowledged by it. One never stands in for another.
 */
export function ContractFilingStatus({ contractId, editable }: { contractId: string; editable: boolean }) {
  const { data, reload } = useLoad<Status>(`/contracts/${contractId}/filing-status`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await api(`/contracts/${contractId}/document`, { method: "POST", body: { filename: file.name, contentBase64: btoa(binary) } });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;
  const emailed = data.customerCopy.find((d) => d.status === "accepted");
  const a = data.authority;
  return (
    <dl className="details small">
      <dt>Signed</dt>
      <dd>
        {data.signedAt ? (
          `Signed online ${when(data.signedAt)}`
        ) : data.uploadedDocuments.length ? (
          <>
            Signed copy uploaded:{" "}
            <a href={`/api${data.uploadedDocuments[0]!.url}`} target="_blank" rel="noreferrer">
              {data.uploadedDocuments[0]!.filename}
            </a>
            {data.uploadedDocuments[0]!.signedOn && ` (signed ${day(data.uploadedDocuments[0]!.signedOn)})`}
          </>
        ) : (
          <span className="muted">No signed copy in Aerowise</span>
        )}
        {editable && !data.signedAt && (
          <label className="link">
            {" "}
            {data.uploadedDocuments.length ? "Upload a newer copy" : "Upload signed PDF"}
            <input type="file" accept="application/pdf" hidden disabled={busy} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          </label>
        )}
        {error && <p className="error">{error}</p>}
      </dd>
      <dt>Customer copy</dt>
      <dd>{emailed ? `Emailed to ${emailed.recipient} ${when(emailed.attemptedAt)} (accepted by the mail provider)` : <span className="muted">Not emailed from Aerowise</span>}</dd>
      <dt>Authority</dt>
      <dd>
        {a ? (
          <>
            <Link href={`/filings/${a.filingId}`}>
              <FilingStatusBadge status={a.status} />
            </Link>
            {a.deadlineOn && ` · due ${day(a.deadlineOn)}`}
            {a.sentAt && ` · sent ${when(a.sentAt)}`}
            {a.status === "needs_review" && a.reviewReason && <div className="restriction">{a.reviewReason}</div>}
          </>
        ) : (
          <span className="muted">No contract filing (the site&apos;s authority does not ask for contracts, or none is chosen)</span>
        )}
      </dd>
      <dt>Acknowledged</dt>
      <dd>{a?.confirmedAt ? when(a.confirmedAt) : <span className="muted">Not yet</span>}</dd>
    </dl>
  );
}
