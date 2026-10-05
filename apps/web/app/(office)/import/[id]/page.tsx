"use client";

import { IMPORT_FIELD_LABELS, IMPORT_FIELDS, type ImportDetail, type ImportField, type ImportRow } from "@aerowise/domain";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";
import { when } from "@/lib/format";

const SHOWN = 200;
const STATUS_CLASS: Record<ImportRow["status"], string> = { ready: "ok", warning: "warn", duplicate: "upcoming", error: "danger" };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
type Filter = "all" | "problems" | ImportRow["status"];

function Mapping({ imp, disabled, onSave }: { imp: ImportDetail; disabled: boolean; onSave: (m: Partial<Record<ImportField, number | null>>) => void }) {
  const set = (field: ImportField, value: string) => {
    const next: Partial<Record<ImportField, number | null>> = { ...imp.mapping };
    // A column holds one field; choosing it here takes it away from any other field.
    for (const f of IMPORT_FIELDS) if (value !== "" && next[f] === Number(value)) next[f] = null;
    next[field] = value === "" ? null : Number(value);
    onSave(next);
  };
  return (
    <details className="card" open={imp.summary.error > 0 && imp.status === "preview"}>
      <summary>
        <strong>Columns</strong> <span className="muted">{Object.keys(imp.mapping).length} of {imp.headers.length} columns used</span>
      </summary>
      <div className="mapping">
        {IMPORT_FIELDS.map((field) => (
          <label key={field}>
            <span>{IMPORT_FIELD_LABELS[field]}</span>
            <select value={imp.mapping[field] ?? ""} disabled={disabled} onChange={(e) => set(field, e.currentTarget.value)} aria-label={IMPORT_FIELD_LABELS[field]}>
              <option value="">Not in file</option>
              {imp.headers.map((h, i) => (
                <option key={i} value={i}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </details>
  );
}

export default function ImportPreviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: loaded, error: loadError } = useLoad<ImportDetail>(`/imports/${id}`);
  const [updated, setUpdated] = useState<ImportDetail | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imp = updated ?? loaded;

  async function run(path: string, body: object = {}, method = "POST") {
    setBusy(true);
    setError(null);
    try {
      setUpdated(await api<ImportDetail>(`/imports/${id}${path}`, { method, body }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
      // A failed commit is recorded on the import; show it.
      if (path === "/commit") setUpdated(await api<ImportDetail>(`/imports/${id}`).catch(() => null));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <p className="error">{loadError}</p>;
  if (!imp) return <p className="muted">Loading…</p>;

  const open = imp.status === "preview" || imp.status === "failed";
  const s = imp.summary;
  const rows = imp.rows.filter((r) => (filter === "all" ? true : filter === "problems" ? r.status !== "ready" : r.status === filter));
  const tiles: [Filter, string, number][] = [
    ["all", "Rows", s.rows],
    ["ready", "Ready", s.ready],
    ["warning", "Warnings", s.warning],
    ["duplicate", "Duplicates", s.duplicate],
    ["error", "Can't import", s.error],
  ];

  return (
    <div className="stack">
      <div className="row">
        <h1>{imp.filename}</h1>
        <span className={`badge ${imp.status === "committed" ? "ok" : imp.status === "failed" ? "danger" : ""}`}>{imp.status}</span>
      </div>
      <p className="muted">
        <Link href="/import">All imports</Link> · uploaded {when(imp.createdAt)}
        {imp.committedAt && ` · imported ${when(imp.committedAt)}`}
      </p>

      {imp.status === "committed" && imp.result && (
        <p className="card">
          Imported {plural(imp.result.customers, "new customer")}, {plural(imp.result.sites, "site")} and {plural(imp.result.contracts, "contract")}.{" "}
          <Link href="/customers">Go to customers</Link> or{" "}
          <Link href="/due">see what is due</Link>.
        </p>
      )}
      {imp.status === "failed" && <p className="card problems">Nothing was imported: {imp.error}. Fix the cause and try again; the preview is unchanged.</p>}

      {imp.sheets.length > 1 && (
        <div className="card row">
          <label className="check" htmlFor="import-sheet">
            Sheet
          </label>
          <select id="import-sheet" value={imp.sheetIndex} disabled={!open || busy} onChange={(e) => run("/sheet", { sheetIndex: Number(e.currentTarget.value) }, "PUT")}>
            {imp.sheets.map((sheet, i) => (
              <option key={i} value={i}>
                {sheet.name} ({plural(sheet.rows, "row")})
              </option>
            ))}
          </select>
          <span className="muted">This workbook has {imp.sheets.length} sheets with data. Only the chosen sheet is imported.</span>
        </div>
      )}

      <div className="tiles">
        {tiles.map(([key, label, n]) => (
          <button key={key} className={`card tile${filter === key ? " selected" : ""}${key === "error" && n > 0 ? " alert" : ""}`} onClick={() => setFilter(key)}>
            <strong>{n}</strong>
            <span>{label}</span>
          </button>
        ))}
      </div>

      {imp.mappingSource === "saved" && open && <p className="muted">Columns were matched using the choices saved with your last import. Check them below.</p>}

      <Mapping imp={imp} disabled={!open || busy} onSave={(mapping) => run("/mapping", { mapping }, "PUT")} />

      {open && (
        <div className="row">
          <button disabled={busy || s.included === 0} onClick={() => run("/commit")}>
            {busy ? "Working…" : `Import ${s.included} ${s.included === 1 ? "row" : "rows"}`}
          </button>
          <button className="secondary" disabled={busy} onClick={() => run("/discard").then(() => router.push("/import"))}>
            Discard
          </button>
          <span className="muted">Rows that can&apos;t be imported are skipped. Duplicates are skipped unless you tick them.</span>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <table className="compact import-rows">
        <thead>
          <tr>
            <th>Row</th>
            <th>Import</th>
            <th>Customer</th>
            <th>Service address</th>
            <th>Permit</th>
            <th>Phone / email</th>
            <th>Plan</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, SHOWN).map((r) => (
            <tr key={r.rowNo} className={r.include ? undefined : "skipped"}>
              <td>{r.rowNo}</td>
              <td>
                <input
                  type="checkbox"
                  checked={r.include}
                  disabled={!open || busy || r.status === "error"}
                  onChange={(e) => run("/rows", e.currentTarget.checked ? { include: [r.rowNo] } : { exclude: [r.rowNo] })}
                  aria-label={`Import row ${r.rowNo}`}
                />
              </td>
              <td>
                {r.record.customerName ?? "—"}
                {r.existingCustomer && <div className="muted">existing customer</div>}
                {r.result && (
                  <div>
                    <Link href={`/sites/${r.result.siteId}`}>Open site</Link>
                  </div>
                )}
              </td>
              <td>
                {[r.record.addressLine1, r.record.addressLine2].filter(Boolean).join(", ") || "—"}
                <div className="muted">{[r.record.city, r.record.state, r.record.postalCode].filter(Boolean).join(" ")}{r.record.county && ` · ${r.record.county}`}</div>
              </td>
              <td>{r.record.permitNumber ?? ""}</td>
              <td>
                {r.record.phone}
                {r.record.email && <div>{r.record.email}</div>}
              </td>
              <td>
                {r.record.planName}
                {r.record.contractStart && (
                  <div className="muted">
                    {r.record.contractStart}
                    {r.record.contractEnd && ` to ${r.record.contractEnd}`}
                  </div>
                )}
                {r.record.lastInspection && <div className="muted">last inspected {r.record.lastInspection}</div>}
              </td>
              <td>
                <span className={`badge ${STATUS_CLASS[r.status]}`}>{r.status}</span>
                {r.duplicateOf && (
                  <div>
                    Same as{" "}
                    {r.duplicateOf.siteId ? <Link href={`/sites/${r.duplicateOf.siteId}`}>{r.duplicateOf.label}</Link> : r.duplicateOf.label}
                  </div>
                )}
                {r.notes.map((m) => (
                  <div key={m} className="muted">
                    {m}
                  </div>
                ))}
                {r.messages.map((m) => (
                  <div key={m} className={r.status === "error" ? "error" : "muted"}>
                    {m}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > SHOWN && (
        <p className="muted">
          Showing the first {SHOWN} of {rows.length} rows. Use the tiles above to see only the rows that need a look.
        </p>
      )}
    </div>
  );
}
