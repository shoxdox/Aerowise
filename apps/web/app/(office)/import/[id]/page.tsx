"use client";

import { IMPORT_FIELD_LABELS, IMPORT_FIELDS, type ImportDetail, type ImportField, type ImportRow, type ImportUndoCheck } from "@aerowise/domain";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { OnboardingSummary } from "@/components/OnboardingSummary";
import { LoadState } from "@/components/LoadState";
import { StatusBadge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { day, plural, when } from "@/lib/format";
import { usePageTitle } from "@/lib/title";

const SHOWN = 200;
/** A date from the file as the rest of Aerowise shows dates, when it reads as one. */
const fileDate = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? day(value) : value);
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

/** Undoing a saved import, or the work that stops it. */
function Undo({ imp, busy, onUndo }: { imp: ImportDetail; busy: boolean; onUndo: () => void }) {
  const recordLoad = useLoad<ImportUndoCheck>(`/imports/${imp.id}/undo`);
  const { data: check } = recordLoad;
  if (!check) return null;
  const r = check.removes;
  if (check.canUndo) {
    return (
      <div className="card row">
        <span>
          Imported the wrong file? Undo deletes the {plural(r.customers, "new customer")}, {plural(r.sites, "site")}, {plural(r.contracts, "contract")} and{" "}
          {plural(r.visits, "visit")} this import created.
        </span>
        <ConfirmButton className="secondary danger" question={`Delete the ${plural(r.sites, "site")} and everything else this import created?`} confirmLabel="Undo import" busy={busy} onConfirm={onUndo}>
          Undo import
        </ConfirmButton>
      </div>
    );
  }
  if (check.blockers.length === 0) return null;
  return (
    <div className="card">
      <p>This import can&apos;t be undone because work was done on what it created:</p>
      <ul>
        {check.blockers.map((b) => (
          <li key={b.table}>{b.label}</li>
        ))}
      </ul>
    </div>
  );
}

export default function ImportPreviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const importLoad = useLoad<ImportDetail>(`/imports/${id}`);
  const { data: loaded } = importLoad;
  const [updated, setUpdated] = useState<ImportDetail | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const imp = updated ?? loaded;
  usePageTitle(imp ? `Import · ${imp.filename}` : null);

  const acting = useSubmit(
    async (path: string, body: object = {}, method: string = "POST") => {
      try {
        setUpdated(await api<ImportDetail>(`/imports/${id}${path}`, { method, body }));
        return true;
      } catch (err) {
        // A failed commit is recorded on the import; show it.
        if (path === "/commit") setUpdated(await api<ImportDetail>(`/imports/${id}`).catch(() => null));
        throw err;
      }
    },
    { fallback: "Could not save." },
  );
  const run = (path: string, body: object = {}, method = "POST") => acting.run(path, body, method);
  const busy = acting.busy;
  const error = acting.error;

  if (!imp) return <LoadState load={importLoad} label="import" back={{ href: "/import", label: "Import" }} />;

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
      <LoadState load={importLoad} label="import" back={{ href: "/import", label: "Import" }} />
      <div className="row">
        <h1>{imp.filename}</h1>
        <StatusBadge of="import" value={imp.status} />
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
      {imp.status === "committed" && (
        <section className="stack">
          <h2>What this import brought in</h2>
          <OnboardingSummary importId={imp.id} />
          <p>
            <Link href="/import/summary">See the whole book</Link>
          </p>
        </section>
      )}
      {imp.status === "committed" && <Undo imp={imp} busy={busy} onUndo={() => void run("/undo")} />}
      {imp.status === "undone" && imp.undoneAt && (
        <p className="card">Undone {when(imp.undoneAt)}. Nothing this import created remains; you can import the file again.</p>
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
          <span className="muted">This workbook has {plural(imp.sheets.length, "sheet")} with data. Only the chosen sheet is imported.</span>
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
          <SubmitButton type="button" busy={busy} busyLabel="Working…" disabled={s.included === 0} onClick={() => void run("/commit")}>
            Import {plural(s.included, "row")}
          </SubmitButton>
          <ConfirmButton className="secondary danger" question="Discard this preview? Nothing from the file is imported." confirmLabel="Discard" busy={busy} onConfirm={async () => (await run("/discard")) && router.push("/import")}>
            Discard
          </ConfirmButton>
          <span className="muted">Rows that can&apos;t be imported are skipped. Duplicates are skipped unless you tick them.</span>
        </div>
      )}
      <FormError error={error} />

      {/* Wide on a phone: the table scrolls sideways instead of widening the page. */}
      <div className="scroll-x">
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
                  {r.existingCustomer && <div className="muted">Existing customer</div>}
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
                      {fileDate(r.record.contractStart)}
                      {r.record.contractEnd && ` to ${fileDate(r.record.contractEnd)}`}
                    </div>
                  )}
                  {r.record.lastInspection && <div className="muted">last inspected {fileDate(r.record.lastInspection)}</div>}
                </td>
                <td>
                  <StatusBadge of="importRow" value={r.status} />
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
      </div>
      {rows.length > SHOWN && (
        <p className="muted">
          Showing the first {SHOWN} of {rows.length} rows. Use the tiles above to see only the rows that need a look.
        </p>
      )}
    </div>
  );
}
