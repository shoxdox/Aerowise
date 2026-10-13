"use client";

/** Each independently loaded section keeps its own recovery; other sections stay useful. */
export function LoadState({ load, label = "records" }: { load: { loading: boolean; refreshing: boolean; stale: boolean; error: string | null; reload: () => Promise<void>; updatedAt?: number | null }; label?: string }) {
  if (load.error) return <div className="card stack" role="alert"><p className="error">Could not refresh {label}. {load.error}</p>{load.stale && <p className="muted small">Showing the last successful result for these same filters{load.updatedAt ? `, loaded ${new Date(load.updatedAt).toLocaleString()}` : ""}. It may be out of date.</p>}<div><button className="secondary" onClick={() => void load.reload()}>Retry {label}</button></div></div>;
  if (load.loading || load.refreshing) return <p className="muted" role="status">{load.refreshing ? "Refreshing" : "Loading"} {label}…</p>;
  return null;
}
