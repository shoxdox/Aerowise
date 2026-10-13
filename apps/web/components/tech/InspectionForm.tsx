"use client";

import {
  applyRequirements,
  INSPECTION_CONFLICT_REASON_LABELS,
  ISSUE_LABELS,
  LOCATION_STATUS_PHONE_TEXT,
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
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { InspectionRecap } from "./InspectionRecap";
import { PhotoField } from "./PhotoField";
import { focusProblems, FormNavigation, LocalSaveStatus, sectionId, type LocalSaveState } from "./FormStatus";
import { TemplateSections } from "@/components/forms/TemplateFields";
import { activeStore, withSentState, type LocalInspection, type PhotoBlob } from "@/lib/offline/db";
import { currentPosition, preparePhoto, templateById } from "@/lib/offline/data";
import { isStorageFull, saveOrReport, STORAGE_FULL_MESSAGE, useStorageFull } from "@/lib/offline/storage";

export function InspectionForm({ stop, initial, onSaved, onFinished, onRefreshPhotos }: { stop: Stop; initial: LocalInspection; onRefreshPhotos: () => Promise<boolean>; onSaved: () => void; onFinished: () => void }) {
  const store = useMemo(() => activeStore(), []);
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
  const [localSave, setLocalSave] = useState<LocalSaveState>("saved");
  const [photoBusy, setPhotoBusy] = useState(false);
  const photoQueue = useRef<Promise<void>>(Promise.resolve());
  const photoPending = useRef(0);
  const [finishing, setFinishing] = useState(false);
  const latest = useRef(insp);
  const editVersion = useRef(0);
  const saveAttempt = useRef(0);
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
    const version = editVersion.current;
    const attempt = ++saveAttempt.current;
    setLocalSave("saving");
    try {
      await saveOrReport(() => store.saveInspection(next, photo));
      if (editVersion.current === version && saveAttempt.current === attempt) setLocalSave("saved");
      onSaved();
    } catch (err) { if (saveAttempt.current === attempt) setLocalSave("failed"); throw err; }
  };
  const update = (next: LocalInspection) => {
    editVersion.current++;
    latest.current = next;
    setInsp(next);
    setLocalSave("saving");
    if (timer.current) clearTimeout(timer.current);
    // A save that does not fit is reported on screen; the edit stays there for the next save.
    timer.current = setTimeout(() => void persist(latest.current).catch(() => {}), 400);
  };
  useEffect(
    () => () => {
      // Leaving the form flushes anything not yet saved.
      if (!timer.current) return;
      // The pending save runs now and its timer never fires against the closed form; a full phone is reported on screen.
      clearTimeout(timer.current);
      timer.current = null;
      void persist(latest.current).catch(() => {});
    },
    [],
  );
  useEffect(() => {
    // The phone going to the lock screen, the camera or another app can end this page without
    // unmounting it: save at once instead of waiting out the debounce.
    const flush = () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      void persist(latest.current).catch(() => {});
    };
    const onVisibility = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  if (template === undefined) return <p className="muted">Loading form…</p>;
  if (template === null) return <p className="error">The form for this inspection is not on this phone. Open the app once with signal.</p>;

  // The county's requirements, saved with the route, make extra fields required.
  const def = applyRequirements(template.definition, stop.requirements);
  const readOnly = insp.status === "completed" || insp.server?.status === "completed" || !!insp.held;
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

  function addPhoto(photoKey: string, e: ChangeEvent<HTMLInputElement>, replaceId?: string) {
    if (readOnly || finishing) return;
    photoPending.current++;
    setPhotoBusy(true);
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    const capture = async () => {
      setPhotoError(null);
      for (const file of files) {
        let clientId: string | null = null;
        let photoSaved = false;
        const beforePhoto = latest.current;
        try {
          const { blob, contentType, preview } = await preparePhoto(file);
          clientId = crypto.randomUUID();
          // The photo goes to the phone's database first; its position is added after, so a few
          // seconds waiting on GPS cannot lose a photo the phone is holding only in memory.
          const next: LocalInspection = {
            ...latest.current,
            photos: [...latest.current.photos.filter(p => p.clientId !== replaceId), { clientId, photoKey, capturedAt: new Date().toISOString(), lat: null, lng: null, uploaded: false, preview }],
            removedPhotoClientIds: replaceId ? [...new Set([...(latest.current.removedPhotoClientIds ?? []), replaceId])] : latest.current.removedPhotoClientIds,
          };
          latest.current = next;
          await persist(next, { clientId, inspectionClientId: next.clientId, blob, contentType });
          photoSaved = true;
          setInsp(latest.current);
          replaceId = undefined;
          setProblems((ps) => ps.filter((p) => p.key !== photoKey));
          // Position is optional metadata added after the durable photo save. It never blocks the next photo.
          void currentPosition(3000).then(async gps => {
            if (gps && latest.current.status === "draft" && !latest.current.held && latest.current.photos.some(p => p.clientId === clientId)) {
              const located = { ...latest.current, photos: latest.current.photos.map(p => p.clientId === clientId ? { ...p, lat: gps.lat, lng: gps.lng } : p) };
              latest.current = located;
              setInsp(located);
              await persist(located);
            }
          }).catch(() => {});
        } catch (err) {
          // Not saved: take the photo back off the screen, so nothing shows that is not on the phone.
          if (!photoSaved && clientId && latest.current.photos.some((p) => p.clientId === clientId)) {
            const without = { ...latest.current, photos: [...latest.current.photos.filter(p => p.clientId !== clientId), ...beforePhoto.photos.filter(p => !latest.current.photos.some(x => x.clientId === p.clientId))], removedPhotoClientIds: beforePhoto.removedPhotoClientIds };
            latest.current = without;
            setInsp(without);
          }
          setPhotoError((err as Error).message);
          if (isStorageFull()) break;
        }
      }
    };
    // A second file-input event joins the queue; no selected photo is silently dropped.
    const queued = photoQueue.current.then(capture, capture);
    photoQueue.current = queued;
    void queued.finally(() => { photoPending.current--; if (photoPending.current === 0) setPhotoBusy(false); }).catch(() => {});
  }

  async function removePhoto(clientId: string) {
    if (readOnly || photoPending.current > 0 || finishing) return;
    photoPending.current++;
    setPhotoBusy(true);
    const before = latest.current;
    const next = { ...before, photos: before.photos.filter(p => p.clientId !== clientId), removedPhotoClientIds: [...new Set([...(before.removedPhotoClientIds ?? []), clientId])] };
    latest.current = next;
    try { await persist(next); setInsp(latest.current); }
    catch (err) { latest.current = before; setPhotoError((err as Error).message); }
    finally { photoPending.current--; if (photoPending.current === 0) setPhotoBusy(false); }
  }

  const setIssues = (issues: LocalInspection["issues"]) => update({ ...latest.current, issues });

  async function finish() {
    if (finishing || photoPending.current > 0 || readOnly) return;
    const found = validateInspection(def, latest.current.values, counts);
    setProblems(found);
    if (found.length) {
      requestAnimationFrame(focusProblems);
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

  if (insp.status === "completed" && !insp.held) return <InspectionRecap stop={stop} inspection={insp} definition={def} onRefreshPhotos={onRefreshPhotos} />;

  return (
    <div className="stack inspection">
      <div>
        <h1>Inspection</h1>
        <p className="muted">
          {stop.customer.displayName} · {stop.site.addressLine1}
        </p>
        {stop.requirements && <p className="muted small">Reported to {stop.requirements.authorityName}</p>}
        {insp.held && (
          <p className="card warn" role="status" data-testid="inspection-held">
            {INSPECTION_CONFLICT_REASON_LABELS[insp.held.reason]} while this phone was offline. Your inspection reached the office, and the office will decide what to do with it.
          </p>
        )}
        {readOnly && !insp.held && <p className="badge ok">Finished on this phone</p>}
        {insp.locationStatus && insp.locationStatus !== "recorded" && (
          <p className="muted small" role="status" data-testid="inspection-location">
            {LOCATION_STATUS_PHONE_TEXT[insp.locationStatus]}
          </p>
        )}
      </div>

      {!readOnly && <LocalSaveStatus state={localSave} retry={() => void persist(latest.current).catch(() => {})} />}
      {!readOnly && <FormNavigation fields={fields} values={insp.values} photoRequired={photos.reduce((n, p) => n + p.minCount, 0)} photoDone={photos.reduce((n, p) => n + Math.min(p.minCount, counts[p.key] ?? 0), 0)} actionLabel="Finish inspection" />}
      {problems.length > 0 && (
        <div className="card problems" role="alert" tabIndex={-1}>
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

        <section className="card stack" id={sectionId("Photos")} tabIndex={-1}>
          <h2>Photos</h2>
          {photos.map(p => <PhotoField key={p.key} label={p.label} photoKey={p.key} minCount={p.minCount} photos={insp.photos.filter(x => x.photoKey === p.key)} disabled={storageFull || photoBusy || finishing} readOnly={readOnly} error={problemFor(p.key)?.message} onAdd={(e, replaceId) => void addPhoto(p.key, e, replaceId)} onRemove={id => void removePhoto(id)} />)}
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
        <button id={sectionId("Finish inspection")} className="big" onClick={() => void finish()} disabled={finishing || photoBusy}>
          {finishing ? "Saving…" : "Finish inspection"}
        </button>
      )}
    </div>
  );
}
