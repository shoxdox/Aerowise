"use client";

import Link from "next/link";
import { when } from "@/lib/format";

interface Load {
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  errorStatus?: number | null;
  reload: () => Promise<void>;
  updatedAt?: number | null;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A record that is not there (deleted, mistyped, another company's): where to go instead. Never a Retry that loops. */
export function NotFound({ title, back = { href: "/inbox", label: "Inbox" } }: { title: string; back?: { href: string; label: string } }) {
  return (
    <div className="card stack" role="alert">
      <h1>{title}</h1>
      <p className="muted">It may have been removed, or the link is out of date.</p>
      <p>
        <Link href={back.href}>← Back to {back.label}</Link>
      </p>
    </div>
  );
}

/** A screen this role cannot open. */
export function NotForYourRole() {
  return (
    <div className="card stack" role="alert">
      <h1>This page isn&apos;t available for your role</h1>
      <p className="muted">Ask the company&apos;s owner if you need it.</p>
      <p>
        <Link href="/inbox">← Back to Inbox</Link>
      </p>
    </div>
  );
}

/**
 * Each independently loaded section keeps its own recovery; other sections stay useful.
 * `label` names what loads ("customer", "invoices"); `back` is where a missing record sends you.
 * `quiet` keeps the rows on screen without a "Refreshing" line when the page reloads them
 * itself (after a change, or while polling).
 */
export function LoadState({ load, label = "records", back, quiet = false }: { load: Load; label?: string; back?: { href: string; label: string }; quiet?: boolean }) {
  if (load.error) {
    // A missing record (or a malformed link to one) will not appear on retry.
    if (load.errorStatus === 404 || (load.errorStatus === 400 && !load.stale)) return <NotFound title={`${capital(label)} not found`} back={back} />;
    if (load.errorStatus === 403) return <NotForYourRole />;
    return (
      <div className="card stack" role="alert">
        <p className="error">
          {load.stale ? "Could not refresh" : "Could not load"} {label}. {load.error}
        </p>
        {load.stale && <p className="muted small">Showing what loaded {load.updatedAt ? `at ${when(new Date(load.updatedAt).toISOString())}` : "last time"}. It may be out of date.</p>}
        <div>
          {/* Named for its section: a page can have several that failed on their own. */}
          <button className="secondary" onClick={() => void load.reload()}>
            Retry {label}
          </button>
        </div>
      </div>
    );
  }
  if (load.loading || (load.refreshing && !quiet)) return <p className="muted" role="status">{load.refreshing ? "Refreshing" : "Loading"} {label}…</p>;
  return null;
}
