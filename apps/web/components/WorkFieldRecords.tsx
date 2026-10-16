"use client";

import { CONFLICT_REASON_LABELS, formatAnswer, type FormTemplate, type WorkRecord, type WorkSyncConflict } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { LoadState } from "@/components/LoadState";
import { Pagination } from "@/components/Pagination";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { plural, when } from "@/lib/format";

// The office's view of what technicians recorded on their phones for a work order's visits
// (SW-2), and the records held because the visit changed while the phone was offline.

type Answers = Record<string, unknown>;

/** Answers in the form's order with its labels, when the form version is known; otherwise as sent. */
function AnswerList({ values, form }: { values: Answers; form: FormTemplate | undefined }) {
  const fields = form?.definition.fields ?? [];
  const keys = [...fields.map((f) => f.key).filter((k) => k in values), ...Object.keys(values).filter((k) => !fields.some((f) => f.key === k))];
  if (keys.length === 0) return <p className="muted small">No answers.</p>;
  return (
    <dl className="details">
      {keys.map((k) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{fields.find((f) => f.key === k)?.label ?? k}</dt>
          <dd style={{ whiteSpace: "pre-wrap" }}>{formatAnswer(form?.definition, k, values[k])}</dd>
        </div>
      ))}
    </dl>
  );
}

export function VisitFieldRecord({ jobId, forms }: { jobId: string; forms: Map<string, FormTemplate> }) {
  const load = useLoad<WorkRecord>(`/jobs/${jobId}/work-record`);
  const record = load.data;
  if (load.errorStatus === 404) return <p className="muted small">No field record received for this visit.</p>;
  if (!record) return <LoadState load={load} label="visit field record" />;
  return (
    <div className="stack" data-testid="field-record">
      <LoadState load={load} label="visit field record" />
      <div className="muted small">
        Field record {record.status === "completed" ? `finished ${record.completedAt ? when(record.completedAt) : ""}` : "in progress on the phone"}
        {record.attachedByOffice && " · accepted by the office from a held record"}
        {!record.finalVisit && " · another visit is needed"}
      </div>
      <AnswerList values={record.values} form={forms.get(record.templateId)} />
      {record.photos.length > 0 && (
        <p className="row">
          {record.photos.map((p) => (
            <a key={p.id} href={`/api${p.url}`} target="_blank" rel="noreferrer" className="badge">
              Photo: {forms.get(record.templateId)?.definition.photos.find((x) => x.key === p.photoKey)?.label ?? p.photoKey}
            </a>
          ))}
        </p>
      )}
      {record.signatures.map((s) => (
        <p key={s.id} className="small">
          Signed by {s.signerName} · {when(s.signedAt)}
        </p>
      ))}
    </div>
  );
}

/** The company's current work forms, by version id, for labelling answers. */
export function useWorkForms(on: boolean) {
  const forms = useLoad<{ items: FormTemplate[] }>(on ? "/form-templates?purpose=work" : null);
  return new Map((forms.data?.items ?? []).map((f) => [f.id, f]));
}

/** Records held for the office on this work order, with what can be done about each. */
export function HeldFieldRecords({ workOrderId, forms, editable, onChanged }: { workOrderId: string; forms: Map<string, FormTemplate>; editable: boolean; onChanged: () => void }) {
  const [offset, setOffset] = useState(0);
  const load = useLoad<{ items: WorkSyncConflict[]; total: number }>(editable ? `/work/conflicts?workOrderId=${workOrderId}&limit=50&offset=${offset}` : null);
  const { data, reload } = load;
  const [dismissing, setDismissing] = useState<string | null>(null);
  const acting = useSubmit(
    async (path: string, body: unknown) => {
      await api(path, { method: "POST", body });
      setDismissing(null);
      await reload();
      onChanged();
    },
    { fallback: "Could not save." },
  );
  const act = (path: string, body: unknown) => acting.run(path, body);
  const items = data?.items ?? [];
  if (!editable) return null;
  if (!data) return <LoadState load={load} label="held field records" />;
  if (data.total === 0 && !load.error && offset === 0) return null;

  return (
    <section className="stack" data-testid="held-records">
      <h2>Held field records</h2>
      <LoadState load={load} label="held field records" />
      <Pagination total={data.total} offset={offset} onChange={setOffset} />
      <p className="muted small">These reached the office after the visit changed while the technician&apos;s phone was offline. Nothing from them counts until you accept one.</p>
      <FormError error={acting.error} />
      {items.map((c) => {
        const payload = (c.payload ?? {}) as { values?: Answers; status?: string; templateId?: string; finalVisit?: boolean };
        return (
          <div key={c.id} className="card stack">
            <div>
              <strong>{c.technicianName}</strong> · {CONFLICT_REASON_LABELS[c.reason]}{" "}
              <Badge tone={c.status === "held" ? "warning" : c.status === "attached" ? "success" : "muted"}>{c.status === "held" ? "Waiting for you" : c.status === "attached" ? "Accepted" : "Set aside"}</Badge>
            </div>
            <div className="muted small">
              Received {when(c.createdAt)} · {payload.status === "completed" ? "finished on the phone" : "not finished on the phone"} · {plural(c.photoCount, "photo")} · {plural(c.signatureCount, "signature")}
            </div>
            <AnswerList values={payload.values ?? {}} form={payload.templateId ? forms.get(payload.templateId) : undefined} />
            {c.resolutionNote && <p className="small">{c.resolutionNote}</p>}
            {c.status === "held" && dismissing !== c.id && (
              <div className="row">
                {payload.status === "completed" && (
                  <SubmitButton type="button" busy={acting.busy} onClick={() => void act(`/work/conflicts/${c.id}/attach`, {})}>
                    Accept this record
                  </SubmitButton>
                )}
                <button className="secondary" onClick={() => setDismissing(c.id)}>
                  Set aside
                </button>
              </div>
            )}
            {c.status === "held" && dismissing === c.id && (
              <form
                className="stack"
                onSubmit={(e: FormEvent<HTMLFormElement>) => {
                  e.preventDefault();
                  void act(`/work/conflicts/${c.id}/dismiss`, { reason: new FormData(e.currentTarget).get("reason") });
                }}
              >
                <label>
                  Why is it set aside?
                  <input name="reason" required minLength={3} maxLength={2000} />
                </label>
                <div className="row">
                  <SubmitButton busy={acting.busy}>Set aside</SubmitButton>
                  <button type="button" className="link" onClick={() => setDismissing(null)}>
                    Back
                  </button>
                </div>
              </form>
            )}
          </div>
        );
      })}
    </section>
  );
}
