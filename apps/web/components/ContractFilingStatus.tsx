"use client";

import {
  CONTRACT_FILING_BASES,
  CONTRACT_FILING_BASIS_DATE_LABELS,
  CONTRACT_FILING_BASIS_LABELS,
  type ContractFilingBasis,
  type ContractFilingBasisState,
  type CustomerDelivery,
  type FilingStatus,
} from "@aerowise/domain";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { FilingStatusBadge } from "@/components/FilingBadges";
import { LoadState } from "@/components/LoadState";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, formValues } from "@/lib/api";
import { day, mpNumber, when } from "@/lib/format";

interface Status {
  signedAt: string | null;
  signedDocumentSha256: string | null;
  uploadedDocuments: { id: string; filename: string; sha256: string; signedOn: string | null; uploadedAt: string; url: string }[];
  customerCopy: CustomerDelivery[];
  authority: { filingId: string; status: FilingStatus; deadlineOn: string | null; deadlineBasis: string | null; sentAt: string | null; confirmedAt: string | null; reviewReason: string | null } | null;
  basis: ContractFilingBasisState;
  discontinuation: {
    discontinuedBy: "provider" | "owner" | null;
    serviceEndsOn: string | null;
    noticeDueOn: string | null;
    recipients: string[];
    noticeSentOn: string | null;
    noticeNote: string | null;
  } | null;
  provider: { credentialId: string; name: string; number: string; source: "contract" | "organization" } | null;
}

interface CredentialRow {
  id: string;
  kind: string;
  holderName: string;
  number: string;
  active: boolean;
}

/**
 * A contract's paperwork, each step on its own line: signed, the customer's copy emailed,
 * filed with the authority, acknowledged by it. One never stands in for another.
 */
export function ContractFilingStatus({ contractId, editable }: { contractId: string; editable: boolean }) {
  const load = useLoad<Status>(`/contracts/${contractId}/filing-status`);
  const { data, reload } = load;
  const uploading = useSubmit(
    async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await api(`/contracts/${contractId}/document`, { method: "POST", body: { filename: file.name, contentBase64: btoa(binary) } });
      await reload();
    },
    { fallback: "Could not upload the signed copy." },
  );
  const saving = useSubmit(
    async (path: string, method: "PUT" | "POST", body: object) => {
      await api(`/contracts/${contractId}/${path}`, { method, body });
      setEditingBasis(false);
      setMps(null);
      await reload();
    },
    { fallback: "Could not save." },
  );
  const listing = useSubmit(
    async () => {
      const all = await api<{ items: CredentialRow[] }>("/credentials");
      setMps(all.items.filter((c) => c.kind === "tceq_maintenance_provider" && c.active));
    },
    { fallback: "Could not load the licenses." },
  );
  const busy = uploading.busy || saving.busy;
  const error = uploading.error ?? saving.error ?? listing.error;

  const [basisChoice, setBasisChoice] = useState<ContractFilingBasis | "">("");
  const [editingBasis, setEditingBasis] = useState(false);
  const [mps, setMps] = useState<CredentialRow[] | null>(null);

  const save = (path: string, method: "PUT" | "POST", body: object) => saving.run(path, method, body);

  function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    void save("provider", "PUT", { credentialId: v.credentialId || null });
  }

  function saveBasis(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    void save("filing-basis", "PUT", { basis: v.basis, basisOn: v.basisOn || null, note: v.note || null });
  }

  function saveNotice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    void save("discontinuation-notice", "POST", { sentOn: v.sentOn, note: v.note });
  }

  if (!data) return <LoadState load={load} label="contract paperwork and filing status" />;
  const emailed = data.customerCopy.find((d) => d.status === "accepted");
  const a = data.authority;
  return (
    <div className="stack"><LoadState load={load} label="contract paperwork and filing status" /><dl className="details small">
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
            <input type="file" accept="application/pdf" hidden disabled={busy} onChange={(e) => e.target.files?.[0] && void uploading.run(e.target.files[0])} />
          </label>
        )}
        <FormError error={error} />
      </dd>
      <dt>Signing MP</dt>
      <dd>
        {data.provider ? (
          <>
            {data.provider.name}, {mpNumber(data.provider.number)}
            <span className="muted">{data.provider.source === "contract" ? " (named on this contract)" : " (the organization's responsible MP)"}</span>
          </>
        ) : (
          <span className="restriction">No maintenance provider named, so reports at this site cannot be signed</span>
        )}
        <div className="muted small">Signs this site&apos;s reports. Anyone else needs a documented delegation and supervision.</div>
        {editable && !mps && (
          <button className="link" disabled={listing.busy} onClick={() => void listing.run()}>
            {data.provider?.source === "contract" ? "Change" : "Name the MP on this contract"}
          </button>
        )}
        {editable && mps && (
          <form className="stack" onSubmit={saveProvider}>
            <select name="credentialId" defaultValue={data.provider?.source === "contract" ? data.provider.credentialId : ""}>
              <option value="">The organization&apos;s responsible MP</option>
              {mps.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.holderName}, {mpNumber(c.number)}
                </option>
              ))}
            </select>
            <SubmitButton busy={saving.busy}>Save</SubmitButton>
          </form>
        )}
      </dd>
      <dt>Customer copy</dt>
      <dd>
        {!emailed ? (
          <span className="muted">Not emailed from Aerowise</span>
        ) : emailed.delivery === "outbox" ? (
          `Recorded in the test outbox for ${emailed.recipient} ${when(emailed.attemptedAt)}; no email was delivered`
        ) : (
          `Emailed to ${emailed.recipient} ${when(emailed.attemptedAt)} (accepted by the mail provider)`
        )}
      </dd>
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
      <dd>{a?.confirmedAt ? when(a.confirmedAt) : a ? <Link href={`/filings/${a.filingId}`}>No acknowledgment recorded. Review the authority’s process and submission evidence.</Link> : <span className="muted">No authority filing recorded</span>}</dd>
      {a && (
        <>
          <dt>Deadline</dt>
          <dd>
            {data.basis.basis ? CONTRACT_FILING_BASIS_LABELS[data.basis.basis] : <span className="muted">Kind of contract not recorded</span>}{" "}
            {a.deadlineBasis && <div className="muted small">{a.deadlineBasis}</div>}
            {data.basis.note && <div className="muted small">Note: {data.basis.note}</div>}
            {editable && !editingBasis && (
              <button className="link" onClick={() => setEditingBasis(true)}>
                {data.basis.basis && !data.basis.derived ? "Change" : "Record which deadline applies"}
              </button>
            )}
            {editable && editingBasis && (
              <form className="stack" onSubmit={saveBasis}>
                <select name="basis" required value={basisChoice} onChange={(e) => setBasisChoice(e.target.value as ContractFilingBasis)}>
                  <option value="" disabled>
                    What kind of contract is this?
                  </option>
                  {CONTRACT_FILING_BASES.map((b) => (
                    <option key={b} value={b}>
                      {CONTRACT_FILING_BASIS_LABELS[b]}
                    </option>
                  ))}
                </select>
                {basisChoice && CONTRACT_FILING_BASIS_DATE_LABELS[basisChoice] && (
                  <label>
                    {CONTRACT_FILING_BASIS_DATE_LABELS[basisChoice]}
                    <input name="basisOn" type="date" required />
                  </label>
                )}
                <input name="note" placeholder="Where this came from (optional)" />
                <div>
                  <SubmitButton busy={saving.busy}>Save</SubmitButton>
                </div>
              </form>
            )}
          </dd>
        </>
      )}
      {data.discontinuation && (
        <>
          <dt>Service ends</dt>
          <dd>
            {data.discontinuation.serviceEndsOn ? (
              <>
                Last day of service {day(data.discontinuation.serviceEndsOn)}
                {data.discontinuation.discontinuedBy && `, ended by the ${data.discontinuation.discontinuedBy}`}
              </>
            ) : (
              <span className="muted">Last day of service not recorded</span>
            )}
          </dd>
          <dt>Ending notice</dt>
          <dd>
            {data.discontinuation.noticeSentOn ? (
              <>
                Sent {day(data.discontinuation.noticeSentOn)}: {data.discontinuation.noticeNote}
              </>
            ) : (
              <>
                <span className="restriction">
                  Not recorded. Write to {data.discontinuation.recipients.join(", ").replace(/, ([^,]*)$/, " and $1")}
                  {data.discontinuation.noticeDueOn && ` by ${day(data.discontinuation.noticeDueOn)}`} (30 TAC 285.7(d)(3)).
                </span>
                {editable && (
                  <form className="stack" onSubmit={saveNotice}>
                    <label>
                      Notice sent on
                      <input name="sentOn" type="date" required />
                    </label>
                    <input name="note" required placeholder="Who you wrote to, and how" />
                    <div>
                      <SubmitButton busy={saving.busy}>Record notice</SubmitButton>
                    </div>
                  </form>
                )}
              </>
            )}
          </dd>
        </>
      )}
    </dl></div>
  );
}
