"use client";

import { validateInspection, type InspectionValues, type TemplateDefinition } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { TemplateFieldInput } from "@/components/forms/TemplateFields";
import { LoadState } from "@/components/LoadState";
import { useLoad } from "@/components/useLoad";

function display(value: unknown) { return value === null || value === undefined || value === "" ? "Not recorded" : typeof value === "boolean" ? value ? "Yes" : "No" : String(value); }

export function ReportCorrection({ filingId, busy, onSubmit }: { filingId: string; busy: boolean; onSubmit: (body: { reason: string; amendments: InspectionValues }) => void }) {
  const load = useLoad<{ definition: TemplateDefinition; values: InspectionValues }>(`/filings/${filingId}/correction-fields`);
  const [amendments, setAmendments] = useState<InspectionValues>({});
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);
  const data = load.data;
  const fields = data?.definition.fields.filter((f) => Object.hasOwn(amendments, f.key)).map((f) => ({ ...f, showWhen: undefined })) ?? [];
  const problems = data && fields.length ? validateInspection({ ...data.definition, fields, photos: [] }, amendments, {}) : [];
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAttempted(true);
    if (!fields.length || problems.length || !reason.trim()) return;
    onSubmit({ reason: reason.trim(), amendments });
  }
  return <form className="card stack" onSubmit={submit}><h2>Correct the report and submit again</h2><p className="muted small">Makes a new report version naming what it replaces and why. Prior signed reports and submitted packages stay unchanged. The new version returns through provider review and filing checks.</p><LoadState load={load} label="report answers" />{data && <>
    <label>Answer to correct<select value="" onChange={(e) => { const key = e.target.value; if (key) setAmendments((v) => ({ ...v, [key]: data.values[key] ?? null })); }}><option value="">Choose a labeled reading or answer…</option>{data.definition.fields.filter((f) => !Object.hasOwn(amendments, f.key)).map((f) => <option key={f.key} value={f.key}>{f.section} · {f.label}</option>)}</select></label>
    {fields.map((field) => <div className="card stack" key={field.key}><p className="muted small">Current {field.label}: {display(data.values[field.key])}</p><TemplateFieldInput field={field} value={amendments[field.key]} problem={attempted ? problems.find((p) => p.key === field.key) : undefined} onChange={(value) => setAmendments((v) => ({ ...v, [field.key]: value }))} /><button type="button" className="link" onClick={() => setAmendments((v) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== field.key)))}>Keep current {field.label}</button></div>)}
    <label>Reason for the correction<input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={2000} /></label>
    {fields.length > 0 && <section aria-label="Change preview"><h3>Review changes</h3><ul>{fields.map((f) => <li key={f.key}>{f.label}: {display(data.values[f.key])} → <strong>{display(amendments[f.key])}</strong></li>)}</ul></section>}
    {attempted && !fields.length && <p className="error" role="alert">Choose at least one corrected answer. Use Resubmit unchanged when no answer needs correction.</p>}
    <button type="submit" disabled={busy || !fields.length}>{busy ? "Making corrected version…" : "Make corrected version"}</button>
  </>}</form>;
}
