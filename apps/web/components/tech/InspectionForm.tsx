"use client";

import {
  applyRequirements,
  ISSUE_LABELS,
  ISSUE_SEVERITIES,
  ISSUE_TYPES,
  validateInspection,
  visibleFields,
  visiblePhotos,
  type InspectionTemplate,
  type InspectionValue,
  type Stop,
  type ValidationProblem,
} from "@aerowise/domain";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { TemplateSections } from "@/components/forms/TemplateFields";
import { saveInspection, withSentState, type LocalInspection, type PhotoBlob } from "@/lib/offline/db";
import { currentPosition, preparePhoto, templateById } from "@/lib/offline/data";
import { isStorageFull, saveOrReport, STORAGE_FULL_MESSAGE, useStorageFull } from "@/lib/offline/storage";

export function InspectionForm({ stop, initial, onSaved, onFinished }: { stop: Stop; initial: LocalInspection; onSaved: () => void; onFinished: () => void }) {
  const [insp, setInsp] = useState(initial);
  const [template, setTemplate] = useState<InspectionTemplate | null | undefined>(undefined);
  const [problems, setProblems] = useState<ValidationProblem[]>(
    initial.server?.validationStatus === "invalid" ? (initial.server.problems as ValidationProblem[]) : [],
  );
  const [photoError, setPhotoError] = useState<string | null>(null);
  // No room for another photo until waiting items are sent; everything already taken is kept.
  const storageFull = useStorageFull();
  useEffect(() => {
    if (!storageFull) setPhotoError((e) => (e === STORAGE_FULL_MESSAGE ? null : e));
  }, [storageFull]);
  const [finishing, setFinishing] = useState(false);
  const latest = useRef(insp);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // What sending has recorded since the form opened (photos sent, the server's answer) shows here too.
  useEffect(() => {
    latest.current = withSentState(latest.current, initial);
    setInsp(latest.current);
  }, [initial]);

  useEffect(() => {
    templateById(initial.templateId).then((t) => setTemplate(t ?? null));
  }, [initial.templateId]);

  // Saves are debounced while typing; photos and finishing save straight away.
  const persist = async (next: LocalInspection, photo?: PhotoBlob) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    await saveOrReport(() => saveInspection(next, photo));
    onSaved();
  };
  const update = (next: LocalInspection) => {
    latest.current = next;
    setInsp(next);
    if (timer.current) clearTimeout(timer.current);
    // A save that does not fit is reported on screen; the edit stays there for the next save.
    timer.current = setTimeout(() => void persist(latest.current).catch(() => {}), 400);
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
  // An answer out of range (a negative chlorine reading) is flagged as it is typed, not only at Finish.
  const invalidNow = readOnly ? [] : validateInspection(def, insp.values, counts).filter((p) => p.problem === "invalid");
  const problemFor = (key: string) => problems.find((p) => p.key === key) ?? invalidNow.find((p) => p.key === key);

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
      let clientId: string | null = null;
      try {
        const { blob, contentType } = await preparePhoto(file);
        const gps = await currentPosition(3000);
        clientId = crypto.randomUUID();
        const next: LocalInspection = {
          ...latest.current,
          photos: [...latest.current.photos, { clientId, photoKey, capturedAt: new Date().toISOString(), lat: gps?.lat ?? null, lng: gps?.lng ?? null, uploaded: false }],
        };
        latest.current = next;
        setInsp(next);
        await persist(next, { clientId, inspectionClientId: next.clientId, blob, contentType });
        setProblems((ps) => ps.filter((p) => p.key !== photoKey));
      } catch (err) {
        // Not saved: take the photo back off the screen, so nothing shows that is not on the phone.
        if (clientId && latest.current.photos.some((p) => p.clientId === clientId)) {
          const without = { ...latest.current, photos: latest.current.photos.filter((p) => p.clientId !== clientId) };
          latest.current = without;
          setInsp(without);
        }
        setPhotoError((err as Error).message);
        if (isStorageFull()) break;
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
    const before = latest.current;
    latest.current = done;
    try {
      await persist(done);
    } catch {
      // Not saved (the phone is full): still a draft here, so finishing can be tried again.
      latest.current = before;
      setFinishing(false);
      return;
    }
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
        <TemplateSections fields={fields} values={insp.values} problemFor={problemFor} onChange={setValue} />

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
              <label className={`button secondary photo-button${storageFull ? " disabled" : ""}`} aria-disabled={storageFull}>
                Add photo
                <input type="file" accept="image/*" capture="environment" multiple hidden disabled={storageFull} onChange={(e) => void addPhoto(p.key, e)} aria-label={`Add photo: ${p.label}`} />
              </label>
            </div>
          ))}
          {storageFull ? (
            <p className="error small" role="alert" data-testid="storage-full">
              {STORAGE_FULL_MESSAGE}
            </p>
          ) : (
            photoError && <p className="error small">{photoError}</p>
          )}
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

      {!readOnly && storageFull && (
        <p className="error small" role="alert">
          {STORAGE_FULL_MESSAGE}
        </p>
      )}
      {!readOnly && (
        <button className="big" onClick={() => void finish()} disabled={finishing}>
          {finishing ? "Saving…" : "Finish inspection"}
        </button>
      )}
    </div>
  );
}
