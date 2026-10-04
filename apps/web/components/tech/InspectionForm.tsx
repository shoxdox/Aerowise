"use client";

import {
  applyRequirements,
  ISSUE_SEVERITIES,
  ISSUE_TYPES,
  validateInspection,
  visibleFields,
  visiblePhotos,
  type InspectionTemplate,
  type InspectionValue,
  type Stop,
  type TemplateField,
  type ValidationProblem,
} from "@aerowise/domain";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { saveInspection, type LocalInspection, type PhotoBlob } from "@/lib/offline/db";
import { currentPosition, preparePhoto, templateById } from "@/lib/offline/data";

const ISSUE_LABELS: Record<string, string> = {
  repair_needed: "Repair needed",
  pump_out: "Pump-out needed",
  part_replacement: "Part replacement",
  callback: "Callback",
  estimate_required: "Estimate required",
  noncompliance: "Noncompliance",
};

function Choice({ label, options, value, onChange }: { label: string; options: { value: string | boolean; label: string }[]; value: InspectionValue | undefined; onChange: (v: InspectionValue) => void }) {
  return (
    <div className="choice" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={value === o.value ? "chosen" : "secondary"}
          aria-pressed={value === o.value}
          onClick={() => onChange(value === o.value ? null : o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ field, value, problem, onChange }: { field: TemplateField; value: InspectionValue | undefined; problem?: ValidationProblem; onChange: (v: InspectionValue) => void }) {
  const title = (
    <span className="field-title">
      {field.label}
      {field.type === "number" && field.unit ? ` (${field.unit})` : ""}
      {field.required && <span className="req" aria-label="required"> *</span>}
    </span>
  );
  let control;
  switch (field.type) {
    case "pass_fail":
      control = <Choice label={field.label} value={value} onChange={onChange} options={[{ value: "pass", label: "Pass" }, { value: "fail", label: "Fail" }]} />;
      break;
    case "boolean":
      control = <Choice label={field.label} value={value} onChange={onChange} options={[{ value: true, label: "Yes" }, { value: false, label: "No" }]} />;
      break;
    case "select":
      control = <Choice label={field.label} value={value} onChange={onChange} options={field.options} />;
      break;
    case "number":
      control = (
        <input
          aria-label={field.label}
          type="number"
          inputMode="decimal"
          step="any"
          min={field.min}
          max={field.max}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
      break;
    case "text":
      control = <textarea aria-label={field.label} rows={3} maxLength={field.maxLength} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
      break;
  }
  return (
    <div className={`field ${problem ? "has-problem" : ""}`} data-field={field.key}>
      {title}
      {control}
      {field.help && <span className="muted small">{field.help}</span>}
      {problem && <span className="error small">{problem.message}</span>}
    </div>
  );
}

export function InspectionForm({ stop, initial, onSaved, onFinished }: { stop: Stop; initial: LocalInspection; onSaved: () => void; onFinished: () => void }) {
  const [insp, setInsp] = useState(initial);
  const [template, setTemplate] = useState<InspectionTemplate | null | undefined>(undefined);
  const [problems, setProblems] = useState<ValidationProblem[]>(
    initial.server?.validationStatus === "invalid" ? (initial.server.problems as ValidationProblem[]) : [],
  );
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const latest = useRef(insp);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    templateById(initial.templateId).then((t) => setTemplate(t ?? null));
  }, [initial.templateId]);

  // Saves are debounced while typing; photos and finishing save straight away.
  const persist = async (next: LocalInspection, photo?: PhotoBlob) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    await saveInspection(next, photo);
    onSaved();
  };
  const update = (next: LocalInspection) => {
    latest.current = next;
    setInsp(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(latest.current), 400);
  };
  useEffect(
    () => () => {
      // Leaving the form flushes anything not yet saved.
      if (timer.current) void saveInspection(latest.current);
    },
    [],
  );

  if (template === undefined) return <p className="muted">Loading form…</p>;
  if (template === null) return <p className="error">The form for this inspection is not on this phone. Open the app once with signal.</p>;

  // The county's requirements, saved with the route, make extra fields required.
  const def = applyRequirements(template.definition, stop.requirements);
  const readOnly = insp.status === "completed";
  const fields = visibleFields(def, insp.values);
  const photos = visiblePhotos(def, insp.values);
  const counts: Record<string, number> = {};
  for (const p of insp.photos) counts[p.photoKey] = (counts[p.photoKey] ?? 0) + 1;
  const problemFor = (key: string) => problems.find((p) => p.key === key);
  const sections = [...new Set(fields.map((f) => f.section))];

  const setValue = (key: string, v: InspectionValue) => {
    const values = { ...latest.current.values };
    if (v === null || v === "") delete values[key];
    else values[key] = v;
    update({ ...latest.current, values });
    if (problems.length) setProblems((ps) => ps.filter((p) => p.key !== key));
  };

  async function addPhoto(photoKey: string, e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    setPhotoError(null);
    for (const file of files) {
      try {
        const { blob, contentType } = await preparePhoto(file);
        const gps = await currentPosition(3000);
        const clientId = crypto.randomUUID();
        const next: LocalInspection = {
          ...latest.current,
          photos: [...latest.current.photos, { clientId, photoKey, capturedAt: new Date().toISOString(), lat: gps?.lat ?? null, lng: gps?.lng ?? null, uploaded: false }],
        };
        latest.current = next;
        setInsp(next);
        await persist(next, { clientId, inspectionClientId: next.clientId, blob, contentType });
        setProblems((ps) => ps.filter((p) => p.key !== photoKey));
      } catch (err) {
        setPhotoError((err as Error).message);
      }
    }
  }

  const setIssues = (issues: LocalInspection["issues"]) => update({ ...latest.current, issues });

  async function finish() {
    const found = validateInspection(def, latest.current.values, counts);
    setProblems(found);
    if (found.length) {
      document.querySelector(".problems")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setFinishing(true);
    const done: LocalInspection = { ...latest.current, status: "completed", completedAt: new Date().toISOString(), completionGps: await currentPosition(5000) };
    latest.current = done;
    await persist(done);
    onFinished();
  }

  return (
    <div className="stack inspection">
      <div>
        <h1>Inspection</h1>
        <p className="muted">
          {stop.customer.displayName} · {stop.site.addressLine1}
        </p>
        {stop.requirements && <p className="muted small">Reported to {stop.requirements.authorityName}</p>}
        {readOnly && <p className="badge ok">Finished on this phone</p>}
      </div>

      {problems.length > 0 && (
        <div className="card problems" role="alert">
          <strong>Before you can finish:</strong>
          <ul>
            {problems.map((p) => (
              <li key={p.key}>{p.message}</li>
            ))}
          </ul>
        </div>
      )}

      <fieldset disabled={readOnly} className="stack plain">
        {sections.map((section) => (
          <section key={section} className="card stack">
            <h2>{section}</h2>
            {fields
              .filter((f) => f.section === section)
              .map((f) => (
                <Field key={f.key} field={f} value={insp.values[f.key]} problem={problemFor(f.key)} onChange={(v) => setValue(f.key, v)} />
              ))}
          </section>
        ))}

        <section className="card stack">
          <h2>Photos</h2>
          {photos.map((p) => (
            <div key={p.key} className={`field ${problemFor(p.key) ? "has-problem" : ""}`} data-photo={p.key}>
              <span className="field-title">
                {p.label}
                {p.minCount > 0 && <span className="req"> *</span>}
              </span>
              <span className="muted small">
                {counts[p.key] ?? 0} taken{p.minCount > 0 ? `, ${p.minCount} needed` : ""}
                {insp.photos.some((x) => x.photoKey === p.key && !x.uploaded) ? " · some not sent yet" : ""}
              </span>
              <label className="button secondary photo-button">
                Add photo
                <input type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => void addPhoto(p.key, e)} aria-label={`Add photo: ${p.label}`} />
              </label>
            </div>
          ))}
          {photoError && <p className="error small">{photoError}</p>}
        </section>

        <section className="card stack">
          <h2>Issues found</h2>
          {insp.issues.map((issue, i) => (
            <div key={issue.clientId} className="issue stack">
              <div className="row">
                <select aria-label="Issue type" value={issue.type} onChange={(e) => setIssues(insp.issues.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
                  {ISSUE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {ISSUE_LABELS[t]}
                    </option>
                  ))}
                </select>
                <select aria-label="Severity" value={issue.severity} onChange={(e) => setIssues(insp.issues.map((x, j) => (j === i ? { ...x, severity: e.target.value } : x)))}>
                  {ISSUE_SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s[0]!.toUpperCase() + s.slice(1)}
                    </option>
                  ))}
                </select>
                <button type="button" className="link" onClick={() => setIssues(insp.issues.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
              <textarea
                aria-label="Issue description"
                rows={2}
                maxLength={2000}
                placeholder="What did you find?"
                value={issue.description}
                onChange={(e) => setIssues(insp.issues.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
              />
            </div>
          ))}
          <button type="button" className="secondary" onClick={() => setIssues([...insp.issues, { clientId: crypto.randomUUID(), type: "repair_needed", severity: "medium", description: "" }])}>
            Add issue
          </button>
        </section>

        <section className="card stack">
          <label>
            Access problem (optional)
            <input value={insp.accessIssue ?? ""} maxLength={500} onChange={(e) => update({ ...latest.current, accessIssue: e.target.value || null })} />
          </label>
        </section>
      </fieldset>

      {!readOnly && (
        <button className="big" onClick={() => void finish()} disabled={finishing}>
          {finishing ? "Saving…" : "Finish inspection"}
        </button>
      )}
    </div>
  );
}
