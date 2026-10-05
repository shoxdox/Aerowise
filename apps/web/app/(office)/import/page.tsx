"use client";

import { MAX_IMPORT_BYTES, type ImportDetail, type ImportListItem } from "@aerowise/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ChangeEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";
import { when } from "@/lib/format";

/** The file's bytes as base64, without the data: URL prefix. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const STATUS_CLASS: Record<ImportListItem["status"], string> = { preview: "upcoming", committed: "ok", failed: "danger", discarded: "cancelled" };

export default function ImportPage() {
  const router = useRouter();
  const { data } = useLoad<{ items: ImportListItem[] }>("/imports");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setError(null);
    if (file.size > MAX_IMPORT_BYTES) {
      setError("That file is larger than 10 MB. Split it into smaller files.");
      return;
    }
    setBusy(true);
    try {
      const created = await api<ImportDetail>("/imports", { method: "POST", body: { filename: file.name, contentBase64: await readBase64(file) } });
      router.push(`/import/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not read the file");
      setBusy(false);
    }
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
          and contract start. Up to 5,000 rows. In a workbook with several sheets you choose the sheet in the preview, and the column choices you
          make are remembered for your next import.
        </p>
        <label className="row">
          <input type="file" accept=".csv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={onFile} disabled={busy} aria-label="Spreadsheet" />
          {busy && <span className="muted">Reading the file…</span>}
        </label>
        {error && <p className="error">{error}</p>}
      </div>

      <h2>Recent imports</h2>
      {data && data.items.length === 0 && <p className="muted">No imports yet.</p>}
      {data && data.items.length > 0 && (
        <table className="compact">
          <thead>
            <tr>
              <th>File</th>
              <th>Uploaded</th>
              <th>Rows</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.id}>
                <td>
                  <Link href={`/import/${i.id}`}>{i.filename}</Link>
                </td>
                <td>{when(i.createdAt)}</td>
                <td>{i.rows}</td>
                <td>
                  <span className={`badge ${STATUS_CLASS[i.status]}`}>{i.status}</span>
                </td>
                <td className="muted">{i.result ? `${i.result.customers} customers, ${i.result.sites} sites, ${i.result.contracts} contracts` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
