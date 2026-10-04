"use client";

import { CONFIRMATION_EVIDENCE_KINDS, CONFIRMATION_EVIDENCE_LABELS, type FilingDetail } from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { DeadlineCell, FilingStatusBadge } from "@/components/FilingBadges";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day, when } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

/** "field_key: value" lines into corrected answers; numbers and yes/no are read as such. */
function parseAmendments(text: string | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const line of (text ?? "").split("\n")) {
    const at = line.indexOf(":");
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    const raw = line.slice(at + 1).trim();
    out[key] = raw === "" ? null : raw === "true" ? true : raw === "false" ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return out;
}

export default function FilingPage() {
  const { id } = useParams<{ id: string }>();
  const editable = canEdit(useSession());
  const { data: f, error, reload } = useLoad<FilingDetail>(`/filings/${id}`);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error) return <p className="error">{error}</p>;
  if (!f) return <p className="muted">Loading…</p>;

  async function run(path: string, body: object = {}) {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/filings/${id}/${path}`, { method: "POST", body });
      await reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const onForm = (path: string) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    void run(path, v);
  };

  const manual = f.submissionMethod === "manual_export";
  const draft = f.profile?.status === "draft";
  const canFallBack = f.package?.fallback === "manual_export" && !manual;

  return (
    <div className="stack">
      <p>
        <Link href="/filings">← Filings</Link>
      </p>
      <div className="row">
        <h1>
          {f.kind === "contract" ? "Contract" : "Inspection report"}: {f.site.addressLine1}, {f.site.city}
        </h1>
        <FilingStatusBadge status={f.status} />
      </div>

      <dl className="card details">
        <dt>Authority</dt>
        <dd>{f.jurisdiction ? `${f.jurisdiction.authorityName} · rules v${f.jurisdiction.rulesetVersion}` : "None matched"}</dd>
        <dt>Customer</dt>
        <dd>
          <Link href={`/customers/${f.customer.id}`}>{f.customer.displayName}</Link> · <Link href={`/sites/${f.site.id}`}>site</Link>
        </dd>
        <dt>Permit</dt>
        <dd>{f.site.permitNumber ?? "Not recorded"}</dd>
        {f.inspection && (
          <>
            <dt>Inspected</dt>
            <dd>{when(f.inspection.completedAt)}</dd>
          </>
        )}
        {f.contract && (
          <>
            <dt>Contract</dt>
            <dd>
              {f.contract.planName}, {day(f.contract.startOn)} to {day(f.contract.endOn)}
            </dd>
          </>
        )}
        <dt>Filing deadline</dt>
        <dd>
          <DeadlineCell deadlineOn={f.deadlineOn} state={f.deadlineState} />
          {f.deadlineBasis && <div className="muted small">{f.deadlineBasis}</div>}
        </dd>
        {f.kind === "inspection_report" && (
          <>
            <dt>Next inspection due by</dt>
            <dd>{f.nextDueOn ? day(f.nextDueOn) : "—"}</dd>
          </>
        )}
        <dt>Method</dt>
        <dd>{f.submissionMethod === "email" ? "Email" : manual ? "By hand (portal, mail or counter)" : "—"}</dd>
        <dt>Sent</dt>
        <dd>
          {when(f.sentAt)}
          {f.proof && (
            <div className="muted small">
              {f.proof.kind === "email_message_id" ? `Message ID ${f.proof.reference}` : `Filed by hand${f.proof.by ? ` by ${f.proof.by}` : ""}${f.proof.reference ? `, portal reference ${f.proof.reference}` : ""}`}
              {f.proof.note && ` · ${f.proof.note}`}
            </div>
          )}
        </dd>
        <dt>Acknowledged</dt>
        <dd>
          {f.confirmedAt ? (
            <>
              {when(f.confirmedAt)} · reference <strong>{f.confirmationReference}</strong>
              {f.confirmationEvidence && (
                <div className="muted small">
                  {CONFIRMATION_EVIDENCE_LABELS[f.confirmationEvidence.kind]}, received {day(f.confirmationEvidence.receivedOn)}
                  {f.confirmationEvidence.from ? ` from ${f.confirmationEvidence.from}` : ""}
                </div>
              )}
              {f.confirmationNote && <div className="muted small">{f.confirmationNote}</div>}
            </>
          ) : (
            <>
              Not yet
              {f.profile?.confirmationMode === "none_published" && <div className="muted small">This authority publishes no acknowledgment process. {f.profile.confirmationNote}</div>}
            </>
          )}
        </dd>
      </dl>

      {draft && (
        <div className="card">
          <p className="restriction">
            This authority&apos;s requirements are a draft written from its public pages. Nothing is sent automatically; check the package below before sending.
          </p>
          {f.profile!.sourcesCheckedOn && (
            <p className="muted small">
              Sources read {day(f.profile!.sourcesCheckedOn)}.{" "}
              {f.profile!.requirementEffective?.date ? `Requirement in effect since ${day(f.profile!.requirementEffective.date)}.` : "When the requirement took effect is not published."}
            </p>
          )}
          {f.profile!.unresolved.length > 0 && (
            <details>
              <summary className="small">{f.profile!.unresolved.length} open questions</summary>
              <ul className="small">
                {f.profile!.unresolved.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {f.status === "needs_review" && <p className="card restriction">{f.reviewReason}</p>}
      {f.status === "failed" && <p className="card restriction">Sending failed: {f.lastError}. It retries automatically.</p>}
      {f.status === "rejected" && <p className="card restriction">The authority rejected it: {f.rejectionReason}</p>}

      {editable && (
        <section className="stack">
          {actionError && <p className="error">{actionError}</p>}

          {f.status === "sent" && (
            <div className="columns">
              <form
                className="card stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  const v = formValues(event.currentTarget);
                  void run("confirm", { reference: v.reference, note: v.note, evidence: { kind: v.evidenceKind, receivedOn: v.receivedOn, from: v.from ?? null } });
                }}
              >
                <strong>The authority acknowledged it</strong>
                <label>
                  What showed it
                  <select name="evidenceKind" defaultValue="authority_email_reply">
                    {CONFIRMATION_EVIDENCE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {CONFIRMATION_EVIDENCE_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Received on
                  <input name="receivedOn" type="date" required />
                </label>
                <label>
                  From
                  <input name="from" placeholder="Who or which address (optional)" />
                </label>
                <label>
                  Their reference, or the email&apos;s subject and date
                  <input name="reference" required />
                </label>
                <label>
                  Note
                  <input name="note" placeholder="Optional" />
                </label>
                <button type="submit" disabled={busy}>
                  Record acknowledgment
                </button>
              </form>
              <form className="card stack" onSubmit={onForm("reject")}>
                <strong>The authority rejected it</strong>
                <label>
                  Why
                  <input name="reason" required />
                </label>
                <button type="submit" className="secondary" disabled={busy}>
                  Record rejection
                </button>
              </form>
            </div>
          )}

          {f.status === "rejected" && f.kind === "inspection_report" && (
            <form
              className="card stack"
              onSubmit={(event) => {
                event.preventDefault();
                const v = formValues(event.currentTarget);
                void run("correct", { reason: v.reason, amendments: parseAmendments(v.amendments) });
              }}
            >
              <strong>Correct the report and submit again</strong>
              <p className="muted small">
                Makes a new report version that names the one it replaces and why. The rejected version and what was sent stay as they were.
              </p>
              <label>
                What was corrected
                <input name="reason" required />
              </label>
              <label>
                Corrected answers (one per line, as field_key: value)
                <textarea name="amendments" rows={3} placeholder="chlorine_level: 2" />
              </label>
              <button type="submit" disabled={busy}>
                Make corrected version
              </button>
            </form>
          )}

          {f.status === "ready" && manual && (
            <form className="card stack" onSubmit={onForm("mark-sent")}>
              <strong>File it by hand</strong>
              <p className="muted small">
                {f.package?.reportUrl && (
                  <>
                    <a href={`/api${f.package.reportUrl}`} target="_blank" rel="noreferrer">
                      Download the authority report
                    </a>
                    {", "}
                  </>
                )}
                {f.package?.portalUrl ? (
                  <>
                    upload it on{" "}
                    <a href={f.package.portalUrl} target="_blank" rel="noreferrer">
                      the authority&apos;s portal
                    </a>
                  </>
                ) : (
                  <>send it to {f.package?.destination ?? "the authority"}</>
                )}
                , then record it here.
              </p>
              <label>
                Portal or receipt reference
                <input name="reference" placeholder="Optional" />
              </label>
              <label>
                Note
                <input name="note" placeholder="Optional" />
              </label>
              <button type="submit" disabled={busy}>
                Mark as filed
              </button>
            </form>
          )}

          <div className="row">
            {f.status === "ready" && f.submissionMethod === "email" && (
              <button disabled={busy} onClick={() => void run("submit")}>
                Send now
              </button>
            )}
            {f.status === "failed" && (
              <button disabled={busy} onClick={() => void run("retry")}>
                Retry now
              </button>
            )}
            {f.status === "rejected" && (
              <button className={f.kind === "inspection_report" ? "secondary" : undefined} disabled={busy} onClick={() => void run("resubmit")}>
                Resubmit unchanged
              </button>
            )}
            {f.status === "needs_review" && (
              <button disabled={busy} onClick={() => void run("recheck")}>
                Check again
              </button>
            )}
            {canFallBack && (f.status === "ready" || f.status === "failed") && (
              <button className="secondary" disabled={busy} onClick={() => void run("manual")}>
                File by hand instead
              </button>
            )}
          </div>
        </section>
      )}

      <section className="stack">
        <h2>Packages</h2>
        <p className="muted small">Each submission&apos;s package is fixed once made: exactly these files and fields are what was (or will be) sent.</p>
        {f.packages.length === 0 && <p className="muted">No package yet.</p>}
        {f.packages.map((p) => (
          <div key={p.id} className="card stack">
            <div className="row">
              <strong>Submission {p.submissionNo}</strong>
              {p.submissionNo < f.submissionNo && !f.attempts.some((a) => a.packageId === p.id) && !(f.proof && f.proof.kind === "manual_submission") && (
                <span className="badge inactive">Never sent (replaced)</span>
              )}
              <span className="muted small">
                {p.method === "email" ? `Email to ${p.recipient ?? "—"}` : "By hand"} · made {when(p.createdAt)}
              </span>
            </div>
            <div className="small">Subject: {p.subject}</div>
            <ul className="small">
              {p.documents.map((d) => (
                <li key={d.filename}>
                  <a href={`/api${d.url}`} target="_blank" rel="noreferrer">
                    {d.filename}
                  </a>{" "}
                  <span className="muted">
                    {d.role === "cover_sheet" ? "cover sheet" : d.role === "contract" ? "signed contract" : `authority report${d.sourceVersion ? ` v${d.sourceVersion}` : ""}`} · SHA-256 {d.sha256.slice(0, 12)}…
                  </span>
                </li>
              ))}
            </ul>
            {p.fields.length > 0 && (
              <details>
                <summary className="small">Cover sheet fields</summary>
                <dl className="details small">
                  {p.fields.map((x) => (
                    <div key={x.label} style={{ display: "contents" }}>
                      <dt>{x.label}</dt>
                      <dd>{x.value ?? <span className={x.required ? "error" : "muted"}>{x.required ? "Missing (required)" : "—"}</span>}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
            <div className="muted small">Manifest SHA-256 {p.manifestSha256}</div>
          </div>
        ))}
      </section>

      {f.reports.length > 1 && (
        <section className="stack">
          <h2>Report versions</h2>
          <ul>
            {f.reports.map((r) => (
              <li key={r.id}>
                Version {r.version} · {when(r.generatedAt)}
                {r.correctionReason && <span className="muted small"> · replaces version {r.version - 1}: {r.correctionReason}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="stack">
        <h2>Attempts</h2>
        {f.attempts.length === 0 && <p className="muted">Not sent yet.</p>}
        {f.attempts.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Started</th>
                <th>Method</th>
                <th>To</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {f.attempts.map((a) => (
                <tr key={a.attemptNo}>
                  <td>
                    {a.attemptNo}
                    {f.submissionNo > 1 && <span className="muted small"> (submission {a.submissionNo})</span>}
                  </td>
                  <td>{when(a.startedAt)}</td>
                  <td>{a.method === "email" ? "Email" : "By hand"}</td>
                  <td>{a.recipient ?? "—"}</td>
                  <td>{a.status === "failed" ? <span className="error">{a.error}</span> : a.status === "succeeded" ? (a.method === "email" ? "Accepted by the mail provider" : "Recorded as filed") : "In progress"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
