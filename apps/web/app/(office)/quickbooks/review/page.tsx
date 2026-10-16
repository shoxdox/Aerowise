"use client";

import { MATCH_REASON_LABELS, type QuickBooksReview, type QuickBooksReviewRow, type QuickBooksStatus } from "@aerowise/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLoad } from "@/components/useLoad";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/StatusBadge";
import { SubmitButton } from "@/components/SubmitButton";
import { useSubmit } from "@/components/useSubmit";
import { api, ApiError } from "@/lib/api";
import { when } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

const FOUND_LABELS = { exact: "Exact match", review: "Check this", none: "New to QuickBooks" } as const;

/** One customer: what Aerowise found in QuickBooks, and the choice for it. */
function ReviewRow({ row, editable, onChange }: { row: QuickBooksReviewRow; editable: boolean; onChange: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const saved = row.decision === "match" ? `match:${row.match?.id}` : (row.decision ?? "");
  // Shown at once; put back if saving fails.
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);

  async function choose(v: string) {
    setError(null);
    setValue(v);
    const body = v.startsWith("match:") ? { decision: "match", externalId: v.slice(6) } : { decision: v };
    try {
      await api(`/quickbooks/review/${row.customer.id}`, { method: "PUT", body });
      await onChange();
    } catch (err) {
      setValue(saved);
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <tr data-testid="review-row">
      <td>
        <strong>{row.customer.displayName}</strong>
        <div className="muted small">{[row.customer.email, row.customer.phone].filter(Boolean).join(" · ") || "No email or phone"}</div>
      </td>
      <td>
        <Badge tone={row.found === "review" && !row.decision ? "warning" : row.found === "exact" ? "success" : "neutral"}>{FOUND_LABELS[row.found]}</Badge>
      </td>
      <td>
        <fieldset className="plain stack" disabled={!editable}>
          {row.candidates.map((c) => (
            <label key={c.id} className="check">
              <input type="radio" name={`r-${row.customer.id}`} checked={value === `match:${c.id}`} onChange={() => void choose(`match:${c.id}`)} />
              <span>
                Link to <strong>{c.name}</strong> <span className="muted small">{[c.email, c.phone].filter(Boolean).join(" · ")}</span>{" "}
                {c.reasons.map((r) => (
                  <span key={r} className="badge">
                    {MATCH_REASON_LABELS[r]}
                  </span>
                ))}
              </span>
            </label>
          ))}
          <label className="check">
            <input type="radio" name={`r-${row.customer.id}`} checked={value === "create"} onChange={() => void choose("create")} />
            Create in QuickBooks
          </label>
          <label className="check">
            <input type="radio" name={`r-${row.customer.id}`} checked={value === "skip"} onChange={() => void choose("skip")} />
            Don&apos;t sync
          </label>
        </fieldset>
        {error && <p className="error small">{error}</p>}
      </td>
    </tr>
  );
}

export default function QuickBooksReviewPage() {
  const me = useSession();
  const editable = canEdit(me);
  const router = useRouter();
  const status = useLoad<QuickBooksStatus>("/quickbooks");
  const review = useLoad<QuickBooksReview>("/quickbooks/review");
  const [filter, setFilter] = useState<"all" | "undecided">("all");
  const reading = useSubmit(
    async () => {
      await api("/quickbooks/review/refresh", { method: "POST", body: {} });
      await review.reload();
    },
    { fallback: "Could not read QuickBooks." },
  );
  const committing = useSubmit(
    async () => {
      await api("/quickbooks/review/commit", { method: "POST", body: {} });
      router.push("/quickbooks");
    },
    { fallback: "Could not start syncing." },
  );
  const refresh = () => reading.run();
  const busy = reading.busy || committing.busy;
  const message = reading.error ?? committing.error;

  // The first visit reads QuickBooks straight away.
  const neverFetched = review.data && !review.data.fetchedAt;
  useEffect(() => {
    if (neverFetched && editable) void refresh();
  }, [neverFetched, editable]);

  if (status.data && status.data.connection?.setupState !== "review") {
    return (
      <div className="stack">
        <h1>First sync</h1>
        <p className="card muted">
          The first sync is done. Anything still to decide is on the <Link href="/quickbooks">QuickBooks page</Link>.
        </p>
      </div>
    );
  }
  if (status.error) return <LoadState load={status} label="QuickBooks" />;
  if (!review.data) return <LoadState load={review} label="customer matches" />;
  const r = review.data;

  const rows = filter === "undecided" ? r.rows.filter((x) => !x.decision) : r.rows;
  return (
    <div className="stack">
      <div className="row">
        <h1>First sync: match customers</h1>
        <span className="spacer" />
        <Link href="/quickbooks">Back to QuickBooks</Link>
      </div>
      <p className="muted">
        Aerowise compared your customers with the {r.remoteCustomers} active customers in QuickBooks
        {r.fetchedAt ? ` (read ${when(r.fetchedAt)})` : ""}. Exact matches (same name and the same email or phone) are linked as they are; customers with no likely match are created. Check the rest.
      </p>
      <div className="tiles">
        <button className={`card tile${filter === "undecided" ? " selected" : ""}`} onClick={() => setFilter(filter === "undecided" ? "all" : "undecided")}>
          <strong className={r.counts.undecided ? "restriction" : undefined}>{r.counts.undecided}</strong>
          <span className="muted small">Need a choice</span>
        </button>
        <div className="card tile">
          <strong>{r.counts.exact}</strong>
          <span className="muted small">Exact matches</span>
        </div>
        <div className="card tile">
          <strong>{r.counts.review}</strong>
          <span className="muted small">Possible matches</span>
        </div>
        <div className="card tile">
          <strong>{r.counts.none}</strong>
          <span className="muted small">New to QuickBooks</span>
        </div>
      </div>
      {editable && (
        <div className="row">
          {r.counts.undecided > 0 ? (
            <ConfirmButton
              className=""
              danger={false}
              question={`${r.counts.undecided} customers have no choice yet. They wait on the QuickBooks page and do not sync until you decide.`}
              confirmLabel="Start syncing"
              busy={committing.busy}
              disabled={busy}
              onConfirm={() => committing.run()}
            >
              Start syncing
            </ConfirmButton>
          ) : (
            <SubmitButton type="button" busy={committing.busy} disabled={busy} onClick={() => void committing.run()}>
              Start syncing
            </SubmitButton>
          )}
          <SubmitButton type="button" className="secondary" busy={reading.busy} busyLabel="Reading QuickBooks…" disabled={busy} onClick={() => void refresh()}>
            Read QuickBooks again
          </SubmitButton>
          {message && <span className="error">{message}</span>}
        </div>
      )}
      <table className="import-rows qb-review">
        <thead>
          <tr>
            <th>Aerowise customer</th>
            <th>Found</th>
            <th>Choice</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <ReviewRow key={row.customer.id} row={row} editable={editable} onChange={review.reload} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                {busy ? "Reading QuickBooks…" : "Nothing to show."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
