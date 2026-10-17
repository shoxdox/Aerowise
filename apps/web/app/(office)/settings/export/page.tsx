"use client";

import { roleHasPermission, type DataExport } from "@aerowise/domain";
import { useEffect } from "react";
import { LoadState } from "@/components/LoadState";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { plural, when } from "@/lib/format";
import { useSession } from "@/lib/session";
import { EmptyState } from "@/components/EmptyState";

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export default function ExportPage() {
  const me = useSession();
  if (!roleHasPermission(me.role, "data:export")) return <p className="muted">Only the owner can export the company&apos;s data.</p>;
  return <Exports />;
}

function Exports() {
  const exports = useLoad<{ items: DataExport[] }>("/exports");
  const { data, reload } = exports;
  const building = data?.items.some((e) => e.status === "queued") ?? false;

  // While an export is being built, check back every few seconds.
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [building, reload]);

  const request = useSubmit(
    async () => {
      await api<DataExport>("/exports", { method: "POST", body: {} });
      await reload();
    },
    { fallback: "Could not start the export." },
  );

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
          <SubmitButton type="button" busy={request.busy} busyLabel="Preparing your export…" disabled={building} onClick={() => void request.run()}>
            {building ? "Preparing your export…" : "Prepare an export"}
          </SubmitButton>
        </div>
        <FormError error={request.error} />
      </div>

      <h2>Recent exports</h2>
      <LoadState load={exports} label="exports" quiet />
      {data && data.items.length === 0 && (
        <EmptyState title="No exports yet">
          An export is a zip of all your company&apos;s records, reports and photos. Make one above; it is listed here to download when it is ready.
        </EmptyState>
      )}
      {data && data.items.length > 0 && (
        <table className="compact stack">
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
                <td data-label="Asked for">{when(e.requestedAt)}</td>
                <td data-label="By">{e.requestedBy}</td>
                <td data-label="Status">
                  {e.status === "ready" && e.contents
                    ? `${plural(e.contents.files.reduce((n, f) => n + f.rows, 0), "record")}, ${plural(e.contents.documents, "document")}`
                    : e.status === "failed"
                      ? `Failed: ${e.error ?? "unknown error"}. Prepare a new one.`
                      : "Preparing…"}
                  {e.contents && e.contents.missing.length > 0 && <div className="muted">{plural(e.contents.missing.length, "document")} could not be found; see README.txt</div>}
                </td>
                <td className={e.status === "ready" ? "actions" : undefined}>
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
