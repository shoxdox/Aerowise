"use client";

import { CONFLICT_REASON_LABELS, type FormTemplate, type WorkRecord, type WorkSyncConflict } from "@aerowise/domain";
import { useEffect, useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";

// The office's view of what technicians recorded on their phones for a work order's visits
// (SW-2), and the records held because the visit changed while the phone was offline.

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

type Answers = Record<string, unknown>;

/** Answers in the form's order with its labels, when the form version is known; otherwise as sent. */
function AnswerList({ values, form }: { values: Answers; form: FormTemplate | undefined }) {
  const fields = form?.definition.fields ?? [];
  const keys = [...fields.map((f) => f.key).filter((k) => k in values), ...Object.keys(values).filter((k) => !fields.some((f) => f.key === k))];
  if (keys.length === 0) return <p className="muted small">No answers.</p>;
  const show = (v: unknown) => (v === true ? "Yes" : v === false ? "No" : String(v));
  return (
    <dl className="details">
      {keys.map((k) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{fields.find((f) => f.key === k)?.label ?? k}</dt>
          <dd style={{ whiteSpace: "pre-wrap" }}>{show(values[k])}</dd>
        </div>
      ))}
    </dl>
  );
}

export function VisitFieldRecord({ jobId, forms }: { jobId: string; forms: Map<string, FormTemplate> }) {
  const [record, setRecord] = useState<WorkRecord | null | undefined>(undefined);
  useEffect(() => {
    api<WorkRecord>(`/jobs/${jobId}/work-record`)
      .then(setRecord)
      .catch(() => setRecord(null));
  }, [jobId]);
  if (record === undefined || record === null) return null;
  return (
    <div className="stack" data-testid="field-record">
      <div className="muted small">
        Field record {record.status === "completed" ? `finished ${record.completedAt ? when(record.completedAt) : ""}` : "in progress on the phone"}
        {record.attachedByOffice && " · accepted by the office from a held record"}
        {!record.finalVisit && " · another visit is needed"}
      </div>
      <AnswerList values={record.values} form={forms.get(record.templateId)} />
      {record.photos.length > 0 && (
        <p className="row">
          {record.photos.map((p) => (
            <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="badge">
              Photo · {p.photoKey}
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
  const { data, reload } = useLoad<{ items: WorkSyncConflict[] }>(editable ? "/work/conflicts" : null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const items = (data?.items ?? []).filter((c) => c.workOrderId === workOrderId);
  if (items.length === 0) return null;

  async function act(path: string, body: unknown) {
    setProblem(null);
    try {
      await api(path, { method: "POST", body });
      setDismissing(null);
      await reload();
      onChanged();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <section className="stack" data-testid="held-records">
      <h2>Held field records</h2>
      <p className="muted small">These reached the office after the visit changed while the technician&apos;s phone was offline. Nothing from them counts until you accept one.</p>
      {problem && <p className="error">{problem}</p>}
      {items.map((c) => {
        const payload = (c.payload ?? {}) as { values?: Answers; status?: string; templateId?: string; finalVisit?: boolean };
        return (
          <div key={c.id} className="card stack">
            <div>
              <strong>{c.technicianName}</strong> · {CONFLICT_REASON_LABELS[c.reason]}{" "}
              <span className={`badge ${c.status === "held" ? "warn" : c.status === "attached" ? "ok" : ""}`}>{c.status === "held" ? "waiting for you" : c.status === "attached" ? "accepted" : "set aside"}</span>
            </div>
            <div className="muted small">
              Received {when(c.createdAt)} · {payload.status === "completed" ? "finished on the phone" : "not finished on the phone"} · {c.photoCount} photos · {c.signatureCount} signatures
            </div>
            <AnswerList values={payload.values ?? {}} form={payload.templateId ? forms.get(payload.templateId) : undefined} />
            {c.resolutionNote && <p className="small">{c.resolutionNote}</p>}
            {c.status === "held" && dismissing !== c.id && (
              <div className="row">
                {payload.status === "completed" && (
                  <button onClick={() => void act(`/work/conflicts/${c.id}/attach`, {})}>Accept this record</button>
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
                  <button type="submit">Set aside</button>
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
