"use client";

import type { FilingDetail } from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { DeadlineCell, FilingStatusBadge } from "@/components/FilingBadges";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");

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
  const canFallBack = f.package?.fallback === "manual_export" && !manual;

  return (
    <div className="stack">
      <p>
        <Link href="/filings">← Filings</Link>
      </p>
      <div className="row">
        <h1>
          {f.site.addressLine1}, {f.site.city}
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
        <dt>Inspected</dt>
        <dd>{when(f.inspection.completedAt)}</dd>
        <dt>Filing deadline</dt>
        <dd>
          <DeadlineCell deadlineOn={f.deadlineOn} state={f.deadlineState} />
        </dd>
        <dt>Next inspection due by</dt>
        <dd>{f.nextDueOn ? day(f.nextDueOn) : "—"}</dd>
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
        <dt>Confirmed</dt>
        <dd>
          {f.confirmedAt ? (
            <>
              {when(f.confirmedAt)} · reference <strong>{f.confirmationReference}</strong>
              {f.confirmationNote && <div className="muted small">{f.confirmationNote}</div>}
            </>
          ) : (
            "Not yet"
          )}
        </dd>
      </dl>

      {f.status === "needs_review" && <p className="card restriction">{f.reviewReason}</p>}
      {f.status === "failed" && <p className="card restriction">Sending failed: {f.lastError}. It retries automatically.</p>}
      {f.status === "rejected" && <p className="card restriction">The authority rejected it: {f.rejectionReason}</p>}

      {editable && (
        <section className="stack">
          {actionError && <p className="error">{actionError}</p>}

          {f.status === "sent" && (
            <div className="columns">
              <form className="card stack" onSubmit={onForm("confirm")}>
                <strong>The authority confirmed it</strong>
                <label>
                  Their reference or confirmation number
                  <input name="reference" required />
                </label>
                <label>
                  Note
                  <input name="note" placeholder="Optional" />
                </label>
                <button type="submit" disabled={busy}>
                  Record confirmation
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
              <button disabled={busy} onClick={() => void run("resubmit")}>
                Resubmit
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
        <h2>Attempts</h2>
        {f.attempts.length === 0 && <p className="muted">Not sent yet.</p>}
        {f.attempts.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Started</th>
                <th>Method</th>
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
                  <td>{a.status === "failed" ? <span className="error">{a.error}</span> : a.status === "succeeded" ? "Sent" : "In progress"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
