"use client";

import { MATCH_REASON_LABELS, type QuickBooksReview, type QuickBooksReviewRow, type QuickBooksStatus } from "@aerowise/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLoad } from "@/components/useLoad";
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
        <span className={`badge ${row.found === "review" && !row.decision ? "warn" : row.found === "exact" ? "ok" : ""}`}>{FOUND_LABELS[row.found]}</span>
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "undecided">("all");

  async function refresh() {
    setBusy(true);
    setMessage(null);
    try {
      await api("/quickbooks/review/refresh", { method: "POST", body: {} });
      await review.reload();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Could not read QuickBooks");
    }
    setBusy(false);
  }

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
  const err = status.error ?? review.error;
  if (err) return <p className="error">{err}</p>;
  if (!review.data) return <p className="muted">Loading…</p>;
  const r = review.data;

  async function commit() {
    if (r.counts.undecided > 0 && !window.confirm(`${r.counts.undecided} customers have no choice yet. They will wait on the QuickBooks page and not sync until you decide. Continue?`)) return;
    setBusy(true);
    try {
      await api("/quickbooks/review/commit", { method: "POST", body: {} });
      router.push("/quickbooks");
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "Could not start syncing");
      setBusy(false);
    }
  }

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
          <button disabled={busy} onClick={() => void commit()}>
            Start syncing
          </button>
          <button className="secondary" disabled={busy} onClick={() => void refresh()}>
            Read QuickBooks again
          </button>
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
