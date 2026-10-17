"use client";

import { LAB_ANALYTE_LABELS, type LabTest, type LabTestStatus } from "@aerowise/domain";
import { useState } from "react";
import { LoadState } from "@/components/LoadState";
import { Badge, toneClass } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { day } from "@/lib/format";

const STATE_BADGE: Record<LabTestStatus["state"], [string, string]> = {
  ok: [toneClass("neutral"), "Up to date"],
  due_soon: [toneClass("warning"), "Due soon"],
  late: [toneClass("danger"), "Overdue"],
};

/**
 * Lab tests (BOD, TSS) the site's authority requires: when the next is due and the
 * results on record. Results come from the lab's report and are never edited; a mistake
 * is fixed with a correction that replaces the record. Hidden when nothing is required
 * and nothing is on file.
 */
export function SiteLabTests({ siteId, editable }: { siteId: string; editable: boolean }) {
  const recordLoad = useLoad<{ requirement: LabTestStatus | null; items: LabTest[] }>(`/sites/${siteId}/lab-tests`);
  const { data, reload } = recordLoad;
  const [form, setForm] = useState<{ replaces: LabTest | null } | null>(null);
  const saving = useSubmit(
    async (v: Record<string, string | undefined>) => {
      const measured = data?.requirement?.analytes ?? (["bod", "tss"] as const);
      await api(`/sites/${siteId}/lab-tests`, {
        method: "POST",
        body: {
          sampledOn: v.sampledOn,
          labName: v.labName,
          labReference: v.labReference ?? null,
          notes: v.notes ?? null,
          results: measured.filter((a) => v[a] !== undefined).map((a) => ({ analyte: a, value: Number(v[a]) })),
          ...(form?.replaces ? { replacesId: form.replaces.id } : {}),
        },
      });
      setForm(null);
      await reload();
    },
    { fallback: "Could not save the results." },
  );

  if (!data) return <LoadState load={recordLoad} label="lab tests" />;
  if (!data.requirement && data.items.length === 0) return null;
  const req = data.requirement;
  const analytes = req?.analytes ?? (["bod", "tss"] as const);

  return (
    <section className="stack">
      <LoadState load={recordLoad} label="lab tests" />
      <div className="row">
        <h2>Lab tests</h2>
        {req && <span className={STATE_BADGE[req.state][0]}>{STATE_BADGE[req.state][1]}</span>}
        <span className="spacer" />
        {editable && !form && (
          <button className="secondary" onClick={() => setForm({ replaces: null })}>
            Record lab results
          </button>
        )}
      </div>
      {req && (
        <p className="small">
          {req.authorityName} requires {req.analytes.map((a) => LAB_ANALYTE_LABELS[a]).join(" and ")} every {req.everyMonths} months. Next due{" "}
          <strong>{day(req.dueOn)}</strong> ({req.dueBasis}).
          {req.note && <span className="muted"> {req.note}</span>}
        </p>
      )}
      {req && req.overLimit.length > 0 && (
        <p className="restriction" role="alert">
          The latest sample is above {req.authorityName}&apos;s limit:{" "}
          {req.overLimit.map((o) => `${LAB_ANALYTE_LABELS[o.analyte]} ${o.value} mg/L (limit ${o.limit})`).join(", ")}.
        </p>
      )}
      {form && (
        <form className="card grid" onSubmit={saving.form}>
          {form.replaces && <p className="wide small">Correcting the sample of {day(form.replaces.sampledOn)}. The original stays on record, marked as replaced.</p>}
          <label>
            Sampled on
            <input name="sampledOn" type="date" required defaultValue={form.replaces?.sampledOn} />
          </label>
          <label>
            Lab
            <input name="labName" required defaultValue={form.replaces?.labName} />
          </label>
          <label>
            Lab report or sample number
            <input name="labReference" defaultValue={form.replaces?.labReference ?? ""} />
          </label>
          {analytes.map((a) => (
            <label key={a}>
              {LAB_ANALYTE_LABELS[a]} (mg/L)
              <input name={a} inputMode="decimal" required={!!req} defaultValue={form.replaces?.results.find((r) => r.analyte === a)?.value} />
            </label>
          ))}
          <label className="wide">
            Notes
            <textarea name="notes" rows={2} />
          </label>
          <FormError error={saving.error} className="wide" />
          <div className="wide row">
            <SubmitButton busy={saving.busy}>{form.replaces ? "Save correction" : "Save results"}</SubmitButton>
            <button type="button" className="link" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {data.items.length === 0 && <p className="muted">No results on record.</p>}
      {data.items.map((t) => (
        <div key={t.id} className="card tight">
          <div className="row">
            <strong>Sampled {day(t.sampledOn)}</strong>
            {t.replacedById && <Badge tone="muted">Replaced by a correction</Badge>}
            {t.replacesId && <Badge>Correction</Badge>}
            <span className="spacer" />
            {editable && !t.replacedById && !form && (
              <button className="link" onClick={() => setForm({ replaces: t })}>
                Correct
              </button>
            )}
          </div>
          <p className="small">
            {t.results.map((r) => `${LAB_ANALYTE_LABELS[r.analyte]} ${r.value} mg/L`).join(" · ")} · {t.labName}
            {t.labReference && ` (${t.labReference})`} · recorded by {t.recordedBy}
          </p>
          {t.notes && <p className="small muted">{t.notes}</p>}
        </div>
      ))}
    </section>
  );
}
