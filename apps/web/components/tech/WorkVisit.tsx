"use client";

import {
  LOCATION_STATUS_PHONE_TEXT,
  formatEntered,
  pumpOutProblems,
  signatureProblems,
  signaturesForVisit,
  snapshotSha256,
  validateInspection,
  visibleFields,
  visiblePhotos,
  type FormTemplate,
  type PumpingFieldData,
  type InspectionValue,
  type InspectionValues,
  type TemplateDefinition,
  type ValidationProblem,
  type WorkStop,
  type SignatureCapture,
} from "@aerowise/domain";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { SignaturePad } from "@/components/forms/SignaturePad";
import { PhotoField } from "./PhotoField";
import { focusProblems, FormNavigation, LocalSaveStatus, sectionId, type LocalSaveState } from "./FormStatus";
import { TemplateSections } from "@/components/forms/TemplateFields";
import { currentPosition, preparePhoto, workFormById } from "@/lib/offline/data";
import { isStorageFull, saveOrReport, STORAGE_FULL_MESSAGE, useStorageFull } from "@/lib/offline/storage";
import { clearUnsaved, mirrorUnsaved, onFlushUnsaved } from "@/lib/offline/unsaved";
import { withSentState, type LocalWork, type WorkBlob, type WorkSignatureLocal, type WorkStore } from "@/lib/offline/work";
import { PumpOutSection, sendablePumpOut } from "./PumpOut";
import { heldText, workStatus } from "./WorkStops";

// One work visit on the phone (SW-2): what the office asked for, then the visit's work form,
// photos and the customer's sign-off. Everything is saved on the phone first and sent when
// there is signal; the record is the technician's own until it is finished.

const CONSENT = "I have read the summary of the work above and confirm it describes the work done at this property.";

function display(def: TemplateDefinition, key: string, value: InspectionValue): string {
  const field = def.fields.find((f) => f.key === key);
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (field?.type === "pass_fail") return value === "pass" ? "Pass" : "Fail";
  if (field?.type === "select") return field.options.find((o) => o.value === value)?.label ?? String(value);
  if (field?.type === "number" && field.unit) return `${value} ${field.unit}`;
  return String(value);
}

/** What the customer reads and signs: the work done, as answered, and whether another visit is needed. */
export function workSummary(stop: WorkStop, def: TemplateDefinition, values: InspectionValues, finalVisit: boolean, pumpOut?: LocalWork["pumpOut"]) {
  const pumped = sendablePumpOut(pumpOut);
  return {
    workOrder: `${stop.workOrderLabel} · ${stop.title}`,
    customer: stop.customerName,
    address: stop.address,
    visit: stop.visitNumber,
    answers: visibleFields(def, values)
      .filter((f) => values[f.key] !== undefined && values[f.key] !== null && values[f.key] !== "")
      .map((f) => ({ label: f.label, answer: display(def, f.key, values[f.key]!) })),
    anotherVisitNeeded: !finalVisit,
    // SW-6: only on a visit with a pump-out, so every other summary (and its hash) stays as it was.
    ...(pumped ? { pumped: formatEntered(pumped.volume, pumped.unit) } : {}),
  };
}

export function WorkVisit({
  stop,
  store,
  record,
  failed,
  onStart,
  starting = false,
  notice,
  onSaved,
  onFinished,
}: {
  stop: WorkStop;
  store: WorkStore;
  record: LocalWork | undefined;
  failed: boolean;
  onStart: () => void;
  starting?: boolean;
  notice?: string | null;
  onSaved: () => void;
  onFinished: () => void;
}) {
  const status = workStatus(stop.record, record, failed);
  return (
    <div className="stack">
      <div>
        <h1>
          {stop.workOrderLabel} · {stop.title}
        </h1>
        <p className="muted">
          {stop.customerName} · {stop.address}
        </p>
        <p className="muted small">
          {stop.workTypeName} · visit {stop.visitNumber}
        </p>
        {stop.coverage !== undefined && <WorkCoverageNote coverage={stop.coverage} />}
        <p className={`badge ${status.tone}`} data-testid="work-visit-status">
          {status.label}
        </p>
      </div>
      {(stop.description || stop.notes) && (
        <dl className="details card">
          {stop.description && (
            <>
              <dt>What needs doing</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{stop.description}</dd>
            </>
          )}
          {stop.notes && (
            <>
              <dt>Office notes</dt>
              <dd>{stop.notes}</dd>
            </>
          )}
        </dl>
      )}
      {notice && <p role="alert" className="error">{notice}</p>}
      {record ? (
        <WorkForm key={record.clientId} stop={stop} store={store} initial={record} onSaved={onSaved} onFinished={onFinished} />
      ) : stop.record ? (
        // Recorded from another phone, or before this phone's data was cleared.
        <p className="muted">{stop.record.status === "completed" ? "This visit's record is already with the office." : "This visit was started on another phone. Finish it there."}</p>
      ) : stop.templateId ? (
        <button className="big" onClick={onStart} disabled={starting} aria-busy={starting}>
          {starting ? "Starting…" : "Arrive and start work"}
        </button>
      ) : (
        <p className="muted">This kind of work has no form on the phone. Tell the office how it went; they record it.</p>
      )}
    </div>
  );
}

/**
 * What the customer's plan covers for this work, for the technician: covered or not, never a
 * price (plan §4.3). Informational; the office's invoice decides what is billed.
 */
function WorkCoverageNote({ coverage }: { coverage: NonNullable<WorkStop["coverage"]> | null }) {
  const rules = coverage?.rules.filter((r) => r.effect !== "excluded") ?? [];
  if (!coverage || rules.length === 0)
    return (
      <p className="badge" data-testid="work-coverage">
        Not covered, quote needed
      </p>
    );
  return (
    <ul className="plain small" data-testid="work-coverage">
      {rules.map((r) => (
        <li key={r.label}>
          <span className="badge ok">{r.effect === "included" ? "Covered" : "Partly covered"}</span> by {coverage.planName}: {r.label}
        </li>
      ))}
    </ul>
  );
}

function WorkForm({ stop, store, initial, onSaved, onFinished }: { stop: WorkStop; store: WorkStore; initial: LocalWork; onSaved: () => void; onFinished: () => void }) {
  const [rec, setRec] = useState(initial);
  const [form, setForm] = useState<FormTemplate | null | undefined>(undefined);
  const [problems, setProblems] = useState<ValidationProblem[]>(initial.server?.validationStatus === "invalid" && initial.status === "draft" ? (initial.server.problems as ValidationProblem[]) : []);
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
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const latest = useRef(rec);
  const editVersion = useRef(0);
  // The edits saved on the phone so far; anything after them is only on screen.
  const committed = useRef(0);
  const saveAttempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formId = useMemo(() => crypto.randomUUID(), []);

  // What sending has recorded since the form opened (photos sent, the server's answer) shows here too.
  useEffect(() => {
    latest.current = withSentState(latest.current, initial);
    setRec(latest.current);
  }, [initial]);

  useEffect(() => {
    void workFormById(store, initial.templateId).then((f) => setForm(f ?? null));
  }, [store, initial.templateId]);
  // SW-6: the company's trucks, cached for the pump-out.
  const [field, setField] = useState<PumpingFieldData | undefined>(undefined);
  useEffect(() => {
    if (stop.requiresDisposalRecord) void store.kvGet<PumpingFieldData>("pumping-field").then(setField);
  }, [store, stop.requiresDisposalRecord]);

  const persist = async (next: LocalWork, extra?: Parameters<WorkStore["saveWork"]>[1]) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const version = editVersion.current;
    const attempt = ++saveAttempt.current;
    setLocalSave("saving");
    try {
      await saveOrReport(() => store.saveWork(next, extra));
      committed.current = Math.max(committed.current, version);
      clearUnsaved(store.tenant, "work", next.clientId, formId, version);
      if (editVersion.current === version && saveAttempt.current === attempt) setLocalSave("saved");
      onSaved();
    } catch (err) { if (saveAttempt.current === attempt) setLocalSave("failed"); throw err; }
  };
  // Saves wait for a pause in typing; taps, photos and finishing save straight away.
  const update = (next: LocalWork, typing = false) => {
    editVersion.current++;
    latest.current = next;
    setRec(next);
    setLocalSave("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    // A save that does not fit is reported on screen; the edit stays there for the next save.
    if (typing) timer.current = setTimeout(() => void persist(latest.current).catch(() => {}), 400);
    else void persist(next).catch(() => {});
  };
  /** The answers not yet saved, written at once where the next start of the app puts them back (lib/offline/unsaved.ts). */
  const mirror = () => {
    const r = latest.current;
    if (editVersion.current <= committed.current || r.status !== "draft" || r.held || r.resolved) return;
    mirrorUnsaved(store.tenant, { kind: "work", jobId: r.jobId, clientId: r.clientId, values: r.values, finalVisit: r.finalVisit, pumpOut: r.pumpOut }, formId, editVersion.current);
  };
  // A Sign out, or a screen about to lock, waits for these answers to be saved.
  useEffect(() => onFlushUnsaved(async () => {
    if (editVersion.current > committed.current) await persist(latest.current);
  }), [store]);
  useEffect(
    () => () => {
      // Leaving the form flushes anything not yet saved.
      if (!timer.current) return;
      // The pending save runs now and its timer never fires against the closed form; a full phone is reported on screen.
      clearTimeout(timer.current);
      timer.current = null;
      void persist(latest.current).catch(() => {});
    },
    [store],
  );
  useEffect(() => {
    // The phone going to the lock screen, the camera or another app can end this page without
    // unmounting it, and Back, a reload or pull-to-refresh can end it before a save started now
    // finishes: the answers are also written down synchronously, then saved at once.
    const flush = () => {
      mirror();
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
  }, [store]);

  if (form === undefined) return <p className="muted">Loading form…</p>;
  if (form === null) return <p className="error">The form for this visit is not on this phone. Open the app once with signal.</p>;

  const def = form.definition;
  const readOnly = rec.status === "completed" || rec.server?.status === "completed" || !!rec.held || !!rec.resolved;
  const fields = visibleFields(def, rec.values);
  const photos = visiblePhotos(def, rec.values);
  const counts: Record<string, number> = {};
  for (const p of rec.photos) counts[p.photoKey] = (counts[p.photoKey] ?? 0) + 1;
  const invalidNow = readOnly ? [] : validateInspection(def, rec.values, counts).filter((p) => p.problem === "invalid");
  const problemFor = (key: string) => problems.find((p) => p.key === key) ?? invalidNow.find((p) => p.key === key);
  // SW-7: a sign-off marked for the final visit is not asked for while another visit is to come.
  const signatures = signaturesForVisit(def, rec.finalVisit);
  const required = signatures.filter((s) => s.required);

  const setValue = (key: string, v: InspectionValue) => {
    const values = { ...latest.current.values };
    if (v === null || v === "") delete values[key];
    else values[key] = v;
    const type = def.fields.find((f) => f.key === key)?.type;
    update({ ...latest.current, values }, type === "number" || type === "text");
    if (problems.length) setProblems((ps) => ps.filter((p) => p.key !== key));
  };

  function addPhoto(photoKey: string, e: ChangeEvent<HTMLInputElement>, replaceId?: string) {
    if (readOnly || busy) return;
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
          const next: LocalWork = {
            ...latest.current,
            photos: [...latest.current.photos.filter(p => p.clientId !== replaceId), { clientId, photoKey, capturedAt: new Date().toISOString(), lat: null, lng: null, uploaded: false, preview }],
            removedPhotoClientIds: replaceId ? [...new Set([...(latest.current.removedPhotoClientIds ?? []), replaceId])] : latest.current.removedPhotoClientIds,
          };
          latest.current = next;
          await persist(next, { photo: { clientId, recordClientId: next.clientId, blob, contentType } satisfies WorkBlob });
          photoSaved = true;
          setRec(latest.current);
          replaceId = undefined;
          setProblems((ps) => ps.filter((p) => p.key !== photoKey));
          // Position is optional metadata added after the durable photo save. It never blocks the next photo.
          void currentPosition(3000).then(async gps => {
            if (gps && latest.current.status === "draft" && !latest.current.held && latest.current.photos.some(p => p.clientId === clientId)) {
              const located = { ...latest.current, photos: latest.current.photos.map(p => p.clientId === clientId ? { ...p, lat: gps.lat, lng: gps.lng } : p) };
              latest.current = located;
              setRec(located);
              await persist(located);
            }
          }).catch(() => {});
        } catch (err) {
          // Not saved: take the photo back off the screen, so nothing shows that is not on the phone.
          if (!photoSaved && clientId && latest.current.photos.some((p) => p.clientId === clientId)) {
            const without = { ...latest.current, photos: [...latest.current.photos.filter(p => p.clientId !== clientId), ...beforePhoto.photos.filter(p => !latest.current.photos.some(x => x.clientId === p.clientId))], removedPhotoClientIds: beforePhoto.removedPhotoClientIds };
            latest.current = without;
            setRec(without);
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
    if (readOnly || photoPending.current > 0 || busy) return;
    photoPending.current++;
    setPhotoBusy(true);
    const before = latest.current;
    const next = { ...before, photos: before.photos.filter(p => p.clientId !== clientId), removedPhotoClientIds: [...new Set([...(before.removedPhotoClientIds ?? []), clientId])] };
    latest.current = next;
    try { await persist(next); setRec(latest.current); }
    catch (err) { latest.current = before; setPhotoError((err as Error).message); }
    finally { photoPending.current--; if (photoPending.current === 0) setPhotoBusy(false); }
  }

  /** Checks the form; with a sign-off on the form, shows the summary to sign next. */
  function review() {
    if (busy || photoPending.current > 0 || readOnly) return;
    const found = [...validateInspection(def, latest.current.values, counts), ...pumpOutProblems(stop.requiresDisposalRecord, sendablePumpOut(latest.current.pumpOut))];
    setProblems(found);
    if (found.length) {
      requestAnimationFrame(focusProblems);
      return;
    }
    if (signatures.length > 0) { setSigning(true); requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="work-signoff"]')?.focus()); }
    else void finish(null);
  }

  /** Finishes the visit, with the customer's signature on the summary if one was given. */
  async function finish(signed: { requirementKey: string; signerName: string; capture: SignatureCapture } | null) {
    if (busy || photoPending.current > 0 || readOnly) return;
    setBusy(true);
    const base = latest.current;
    const summary = signed ? workSummary(stop, def, base.values, base.finalVisit, base.pumpOut) : null;
    const sigs: WorkSignatureLocal[] = signed
      ? [
          {
            clientId: crypto.randomUUID(),
            requirementKey: signed.requirementKey,
            signerName: signed.signerName,
            capture: signed.capture,
            summarySha256: await snapshotSha256(summary),
            consentText: CONSENT,
            signedAt: new Date().toISOString(),
            uploaded: false,
          },
        ]
      : [];
    const missing = signatureProblems(def, new Set(sigs.map((s) => s.requirementKey)), base.finalVisit);
    if (missing.length) {
      setProblems(missing);
      setBusy(false);
      return;
    }
    const done: LocalWork = { ...base, status: "completed", completedAt: new Date().toISOString(), completionGps: await currentPosition(5000), summary, signatures: [...base.signatures, ...sigs] };
    latest.current = done;
    try {
      await persist(done, { signatureClientIds: sigs.map((s) => s.clientId) });
    } catch {
      // Not saved (the phone is full): still a draft here, so finishing can be tried again.
      latest.current = base;
      setBusy(false);
      return;
    }
    onFinished();
  }

  return (
    <div className="stack inspection">
      {rec.held && (
        <div className="card warn" role="status" data-testid="work-held">
          {heldText(rec)}
        </div>
      )}
      {rec.resolved && (
        <p className="muted" role="status">
          {rec.resolved.resolution === "attached" ? "The office accepted this record." : "The office set this record aside. Its photos and signature are kept."}
        </p>
      )}
      {rec.locationStatus && rec.locationStatus !== "recorded" && (
        <p className="muted small" role="status" data-testid="work-location">
          {LOCATION_STATUS_PHONE_TEXT[rec.locationStatus]}
        </p>
      )}
      {!readOnly && <LocalSaveStatus state={localSave} retry={() => void persist(latest.current).catch(() => {})} />}
      {!readOnly && !signing && <FormNavigation hasPhotos={photos.length > 0} fields={fields} values={rec.values} photoRequired={photos.reduce((n, p) => n + p.minCount, 0)} photoDone={photos.reduce((n, p) => n + Math.min(p.minCount, counts[p.key] ?? 0), 0)} actionLabel="Review and finish" />}
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

      {signing && !readOnly ? (
        <SignOff
          summary={workSummary(stop, def, rec.values, rec.finalVisit, rec.pumpOut)}
          requirements={signatures}
          busy={busy}
          onBack={() => setSigning(false)}
          onSign={(s) => void finish(s)}
          onSkip={required.length === 0 ? () => void finish(null) : undefined}
        />
      ) : (
        <>
          <fieldset disabled={readOnly} className="stack plain">
            <TemplateSections fields={fields} values={rec.values} problemFor={problemFor} onChange={setValue} />

            {(stop.requiresDisposalRecord || rec.pumpOut) && (
              <PumpOutSection
                value={rec.pumpOut}
                vehicles={field?.vehicles ?? []}
                problem={problemFor("pump_out")?.message ?? null}
                onChange={(pumpOut) => {
                  // Mostly typed: the amount pumped.
                  update({ ...latest.current, pumpOut }, true);
                  if (problems.length) setProblems((ps) => ps.filter((p) => p.key !== "pump_out"));
                }}
              />
            )}

            {photos.length > 0 && (
              <section className="card stack" id={sectionId("Photos")} tabIndex={-1}>
                <h2>Photos</h2>
                {photos.map(p => <PhotoField key={p.key} label={p.label} photoKey={p.key} minCount={p.minCount} photos={rec.photos.filter(x => x.photoKey === p.key)} disabled={storageFull || photoBusy || busy} readOnly={readOnly} error={problemFor(p.key)?.message} onAdd={(e, replaceId) => void addPhoto(p.key, e, replaceId)} onRemove={id => void removePhoto(id)} />)}
                {storageFull ? (
                  <p className="error small" role="alert" data-testid="storage-full">
                    {STORAGE_FULL_MESSAGE}
                  </p>
                ) : (
                  photoError && <p className="error small">{photoError}</p>
                )}
              </section>
            )}

            <section className="card stack">
              <label className="row">
                <input type="checkbox" checked={!rec.finalVisit} onChange={(e) => update({ ...latest.current, finalVisit: !e.target.checked })} />
                Another visit is needed to finish this work
              </label>
            </section>
          </fieldset>

          {rec.signatures.length > 0 && (
            <p className="muted small">
              Signed by {rec.signatures.map((s) => s.signerName).join(", ")}
              {rec.signatures.some((s) => !s.uploaded) ? " · not sent yet" : ""}
            </p>
          )}
          {!readOnly && storageFull && (
            <p className="error small" role="alert">
              {STORAGE_FULL_MESSAGE}
            </p>
          )}
          {!readOnly && (
            <button id={sectionId("Review and finish")} className="big" onClick={review} disabled={busy || photoBusy}>
              {signatures.length > 0 ? "Review and sign" : busy ? "Saving…" : "Finish visit"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function SignOff({
  summary,
  requirements,
  busy,
  onBack,
  onSign,
  onSkip,
}: {
  summary: ReturnType<typeof workSummary>;
  requirements: NonNullable<TemplateDefinition["signatures"]>;
  busy: boolean;
  onBack: () => void;
  onSign: (s: { requirementKey: string; signerName: string; capture: SignatureCapture }) => void;
  onSkip?: () => void;
}) {
  const [mode, setMode] = useState<"drawn" | "typed">("drawn");
  const [name, setName] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const requirement = requirements[0]!;
  return (
    <section className="card stack" data-testid="work-signoff" tabIndex={-1}>
      <h2>{requirement.label}</h2>
      <p className="muted small">Hand the phone to the customer to read and sign. Once signed, the record can no longer be changed.</p>
      <dl className="details" data-testid="work-summary">
        <dt>Work</dt>
        <dd>{summary.workOrder}</dd>
        <dt>Address</dt>
        <dd>{summary.address}</dd>
        {summary.answers.map((a) => (
          <div key={a.label} style={{ display: "contents" }}>
            <dt>{a.label}</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>{a.answer}</dd>
          </div>
        ))}
        {summary.pumped && (
          <>
            <dt>Pumped</dt>
            <dd>{summary.pumped}</dd>
          </>
        )}
        <dt>Another visit needed</dt>
        <dd>{summary.anotherVisitNeeded ? "Yes" : "No"}</dd>
      </dl>
      <p className="small">{CONSENT}</p>
      <label>
        Name of the person signing
        <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="choice" role="group" aria-label="Signature method"><button type="button" aria-pressed={mode === "drawn"} className={mode === "drawn" ? "chosen" : "secondary"} onClick={() => { setImage(null); setMode("drawn"); }}>Draw signature</button><button type="button" aria-pressed={mode === "typed"} className={mode === "typed" ? "chosen" : "secondary"} onClick={() => setMode("typed")}>Type signature</button></div>
      {mode === "drawn" ? <SignaturePad onChange={setImage} /> : <p className="card small">By choosing Sign and finish visit, I adopt my typed name as my electronic signature and agree to the summary and consent above. <strong>{name || "Enter your name above."}</strong></p>}
      <button className="big" disabled={busy || !name.trim() || (mode === "drawn" && !image)} onClick={() => onSign({ requirementKey: requirement.key, signerName: name.trim(), capture: mode === "typed" ? { kind: "typed" } : { kind: "drawn", image: image! } })}>
        {busy ? "Saving…" : "Sign and finish visit"}
      </button>
      <div className="row">
        <button type="button" className="link" onClick={onBack} disabled={busy}>
          Back to the form
        </button>
        <span className="spacer" />
        {onSkip && (
          <button type="button" className="link" onClick={onSkip} disabled={busy}>
            Finish without a signature
          </button>
        )}
      </div>
    </section>
  );
}
