"use client";

import { roleHasPermission, type DataExport } from "@aerowise/domain";
import { useEffect, useState } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";
import { when } from "@/lib/format";
import { useSession } from "@/lib/session";

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export default function ExportPage() {
  const me = useSession();
  if (!roleHasPermission(me.role, "data:export")) return <p className="muted">Only the owner can export the company&apos;s data.</p>;
  return <Exports />;
}

function Exports() {
  const { data, reload } = useLoad<{ items: DataExport[] }>("/exports");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const building = data?.items.some((e) => e.status === "queued") ?? false;

  // While an export is being built, check back every few seconds.
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [building, reload]);

  async function request() {
    setBusy(true);
    setError(null);
    try {
      await api<DataExport>("/exports", { method: "POST", body: {} });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the export");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h1>Export your data</h1>
      <div className="card stack">
        <p>
          Download everything your company keeps in Aerowise: customers, contacts, sites, units, contracts, visits, inspections, invoices and payments
          as CSV files, with every inspection report, signed report, invoice and signed agreement as a PDF, in one zip file.
        </p>
        <p className="muted">Your data is yours. You can export it at any time, including when your account is read-only.</p>
        <div className="row">
          <button disabled={busy || building} onClick={request}>
            {building ? "Preparing your export…" : "Prepare an export"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>

      <h2>Recent exports</h2>
      {data && data.items.length === 0 && <p className="muted">No exports yet.</p>}
      {data && data.items.length > 0 && (
        <table className="compact">
          <thead>
            <tr>
              <th>Asked for</th>
              <th>By</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((e) => (
              <tr key={e.id}>
                <td>{when(e.requestedAt)}</td>
                <td>{e.requestedBy}</td>
                <td>
                  {e.status === "ready" && e.contents
                    ? `${e.contents.files.reduce((n, f) => n + f.rows, 0)} records, ${e.contents.documents} documents`
                    : e.status === "failed"
                      ? `Failed: ${e.error ?? "unknown error"}. Prepare a new one.`
                      : "Preparing…"}
                  {e.contents && e.contents.missing.length > 0 && <div className="muted">{e.contents.missing.length} documents could not be found; see README.txt</div>}
                </td>
                <td>
                  {e.status === "ready" && e.byteSize !== null && (
                    <a className="button secondary" href={`/api/exports/${e.id}/download`}>
                      Download ({size(e.byteSize)})
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
