"use client";

import {
  signatureProblems,
  snapshotSha256,
  validateInspection,
  visibleFields,
  visiblePhotos,
  type FormTemplate,
  type InspectionValue,
  type InspectionValues,
  type TemplateDefinition,
  type ValidationProblem,
  type WorkStop,
} from "@aerowise/domain";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { SignaturePad } from "@/components/forms/SignaturePad";
import { TemplateSections } from "@/components/forms/TemplateFields";
import { currentPosition, preparePhoto, workFormById } from "@/lib/offline/data";
import { isStorageFull, saveOrReport, STORAGE_FULL_MESSAGE, useStorageFull } from "@/lib/offline/storage";
import { withSentState, type LocalWork, type WorkBlob, type WorkSignatureLocal, type WorkStore } from "@/lib/offline/work";
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
export function workSummary(stop: WorkStop, def: TemplateDefinition, values: InspectionValues, finalVisit: boolean) {
  return {
    workOrder: `${stop.workOrderLabel} · ${stop.title}`,
    customer: stop.customerName,
    address: stop.address,
    visit: stop.visitNumber,
    answers: visibleFields(def, values)
      .filter((f) => values[f.key] !== undefined && values[f.key] !== null && values[f.key] !== "")
      .map((f) => ({ label: f.label, answer: display(def, f.key, values[f.key]!) })),
    anotherVisitNeeded: !finalVisit,
  };
}

export function WorkVisit({
  stop,
  store,
  record,
  failed,
  onStart,
  onSaved,
  onFinished,
}: {
  stop: WorkStop;
  store: WorkStore;
  record: LocalWork | undefined;
  failed: boolean;
  onStart: () => void;
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
      {record ? (
        <WorkForm key={record.clientId} stop={stop} store={store} initial={record} onSaved={onSaved} onFinished={onFinished} />
      ) : stop.record ? (
        // Recorded from another phone, or before this phone's data was cleared.
        <p className="muted">{stop.record.status === "completed" ? "This visit's record is already with the office." : "This visit was started on another phone. Finish it there."}</p>
      ) : stop.templateId ? (
        <button className="big" onClick={onStart}>
          Arrive and start work
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
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const latest = useRef(rec);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // What sending has recorded since the form opened (photos sent, the server's answer) shows here too.
  useEffect(() => {
    latest.current = withSentState(latest.current, initial);
    setRec(latest.current);
  }, [initial]);

  useEffect(() => {
    void workFormById(store, initial.templateId).then((f) => setForm(f ?? null));
  }, [store, initial.templateId]);

  const persist = async (next: LocalWork, extra?: Parameters<WorkStore["saveWork"]>[1]) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    await saveOrReport(() => store.saveWork(next, extra));
    onSaved();
  };
  const update = (next: LocalWork) => {
    latest.current = next;
    setRec(next);
    if (timer.current) clearTimeout(timer.current);
    // A save that does not fit is reported on screen; the edit stays there for the next save.
    timer.current = setTimeout(() => void persist(latest.current).catch(() => {}), 400);
  };
  useEffect(
    () => () => {
      // Leaving the form flushes anything not yet saved.
      if (timer.current) void store.saveWork(latest.current);
    },
    [store],
  );

  if (form === undefined) return <p className="muted">Loading form…</p>;
  if (form === null) return <p className="error">The form for this visit is not on this phone. Open the app once with signal.</p>;

  const def = form.definition;
  const readOnly = rec.status === "completed" || !!rec.held || !!rec.resolved;
  const fields = visibleFields(def, rec.values);
  const photos = visiblePhotos(def, rec.values);
  const counts: Record<string, number> = {};
  for (const p of rec.photos) counts[p.photoKey] = (counts[p.photoKey] ?? 0) + 1;
  const invalidNow = readOnly ? [] : validateInspection(def, rec.values, counts).filter((p) => p.problem === "invalid");
  const problemFor = (key: string) => problems.find((p) => p.key === key) ?? invalidNow.find((p) => p.key === key);
  const signatures = def.signatures ?? [];
  const required = signatures.filter((s) => s.required);

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
        const next: LocalWork = {
          ...latest.current,
          photos: [...latest.current.photos, { clientId, photoKey, capturedAt: new Date().toISOString(), lat: gps?.lat ?? null, lng: gps?.lng ?? null, uploaded: false }],
        };
        latest.current = next;
        setRec(next);
        await persist(next, { photo: { clientId, recordClientId: next.clientId, blob, contentType } satisfies WorkBlob });
        setProblems((ps) => ps.filter((p) => p.key !== photoKey));
      } catch (err) {
        // Not saved: take the photo back off the screen, so nothing shows that is not on the phone.
        if (clientId && latest.current.photos.some((p) => p.clientId === clientId)) {
          const without = { ...latest.current, photos: latest.current.photos.filter((p) => p.clientId !== clientId) };
          latest.current = without;
          setRec(without);
        }
        setPhotoError((err as Error).message);
        if (isStorageFull()) break;
      }
    }
  }

  /** Checks the form; with a sign-off on the form, shows the summary to sign next. */
  function review() {
    const found = validateInspection(def, latest.current.values, counts);
    setProblems(found);
    if (found.length) {
      document.querySelector(".problems")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (signatures.length > 0) setSigning(true);
    else void finish(null);
  }

  /** Finishes the visit, with the customer's signature on the summary if one was given. */
  async function finish(signed: { requirementKey: string; signerName: string; image: string } | null) {
    setBusy(true);
    const base = latest.current;
    const summary = signed ? workSummary(stop, def, base.values, base.finalVisit) : null;
    const sigs: WorkSignatureLocal[] = signed
      ? [
          {
            clientId: crypto.randomUUID(),
            requirementKey: signed.requirementKey,
            signerName: signed.signerName,
            capture: { kind: "drawn", image: signed.image },
            summarySha256: await snapshotSha256(summary),
            consentText: CONSENT,
            signedAt: new Date().toISOString(),
            uploaded: false,
          },
        ]
      : [];
    const missing = signatureProblems(def, new Set(sigs.map((s) => s.requirementKey)));
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

      {signing && !readOnly ? (
        <SignOff
          summary={workSummary(stop, def, rec.values, rec.finalVisit)}
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

            {photos.length > 0 && (
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
                      {rec.photos.some((x) => x.photoKey === p.key && !x.uploaded) ? " · some not sent yet" : ""}
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
            <button className="big" onClick={review} disabled={busy}>
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
  onSign: (s: { requirementKey: string; signerName: string; image: string }) => void;
  onSkip?: () => void;
}) {
  const [name, setName] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const requirement = requirements[0]!;
  return (
    <section className="card stack" data-testid="work-signoff">
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
        <dt>Another visit needed</dt>
        <dd>{summary.anotherVisitNeeded ? "Yes" : "No"}</dd>
      </dl>
      <p className="small">{CONSENT}</p>
      <label>
        Name of the person signing
        <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </label>
      <SignaturePad onChange={setImage} />
      <button className="big" disabled={busy || !name.trim() || !image} onClick={() => image && onSign({ requirementKey: requirement.key, signerName: name.trim(), image })}>
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
