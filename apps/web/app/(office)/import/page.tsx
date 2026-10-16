"use client";

import { MAX_IMPORT_BYTES, type ImportDetail, type ImportListItem } from "@aerowise/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ChangeEvent } from "react";
import { LoadState } from "@/components/LoadState";
import { StatusBadge } from "@/components/StatusBadge";
import { FormError } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, Refusal } from "@/lib/api";
import { plural, when } from "@/lib/format";
import { EmptyState } from "@/components/EmptyState";

/** The file's bytes as base64, without the data: URL prefix. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function ImportPage() {
  const router = useRouter();
  const imports = useLoad<{ items: ImportListItem[] }>("/imports");
  const { data } = imports;
  const upload = useSubmit(
    async (file: File) => {
      if (file.size > MAX_IMPORT_BYTES) throw new Refusal("That file is larger than 10 MB. Split it into smaller files.");
      const created = await api<ImportDetail>("/imports", { method: "POST", body: { filename: file.name, contentBase64: await readBase64(file) } });
      router.push(`/import/${created.id}`);
    },
    { fallback: "Could not read the file.", leaves: true },
  );

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (file) void upload.run(file);
  }

  return (
    <div className="stack">
      <h1>Import customers</h1>
      <div className="card stack">
        <p>
          Upload a CSV or Excel (.xlsx) file with one service site per row. Aerowise works out which column is which, shows you every row before
          anything is saved, and flags rows that are missing an address or are already on file.
        </p>
        <p className="muted">
          Useful columns: customer name, phone, email, service address, city, ZIP, county, permit number, gate code, unit make, model and serial, plan
          and contract start or end date, and the last inspection date, so renewals and overdue visits show up right away. Up to 5,000 rows. In a workbook with several sheets you choose the sheet in the preview, and the column choices you
          make are remembered for your next import.
        </p>
        <label className="row">
          <input type="file" accept=".csv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={onFile} disabled={upload.busy} aria-label="Spreadsheet" />
          {upload.busy && <span className="muted">Reading the file…</span>}
        </label>
        <FormError error={upload.error} />
      </div>

      <p>
        <Link href="/import/summary">Your book at a glance</Link>: active and expiring contracts, overdue inspections, and sites missing an authority or permit.
      </p>

      <h2>Recent imports</h2>
      <LoadState load={imports} label="imports" quiet />
      {data && data.items.length === 0 && (
        <EmptyState title="No imports yet">
          Bring customers, sites and contracts in from a spreadsheet above. Each import you run is listed here with what it added and what it skipped.
        </EmptyState>
      )}
      {data && data.items.length > 0 && (
        <table className="compact stack">
          <thead>
            <tr>
              <th>File</th>
              <th>Uploaded</th>
              <th className="num">Rows</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.id}>
                <td data-label="File">
                  <Link href={`/import/${i.id}`}>{i.filename}</Link>
                </td>
                <td data-label="Uploaded">{when(i.createdAt)}</td>
                <td data-label="Rows" className="num">
                  {i.rows}
                </td>
                <td data-label="Status">
                  <StatusBadge of="import" value={i.status} />
                </td>
                <td data-label="Created" className="muted">
                  {i.result ? `${plural(i.result.customers, "customer")}, ${plural(i.result.sites, "site")}, ${plural(i.result.contracts, "contract")}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
