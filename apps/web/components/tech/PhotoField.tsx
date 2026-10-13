"use client";

import { useId, useRef, type ChangeEvent } from "react";
import type { LocalPhoto } from "@/lib/offline/db";

/** Native file picking remains keyboard operable; edits apply only to a mutable draft. */
export function PhotoField({ label, photoKey, minCount, photos, disabled, readOnly, error, onAdd, onRemove }: {
  label: string; photoKey: string; minCount: number; photos: LocalPhoto[]; disabled: boolean; readOnly?: boolean; error?: string;
  onAdd: (e: ChangeEvent<HTMLInputElement>, replaceId?: string) => void; onRemove: (id: string) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const replace = useRef<string | undefined>(undefined);
  const choose = (replaceId?: string) => { replace.current = replaceId; input.current?.click(); };
  return <div className={`field ${error ? "has-problem" : ""}`} data-photo={photoKey}>
    <span className="field-title" id={`${id}-title`}>{label}{minCount > 0 && <span className="req"> *</span>}</span>
    <span className="muted small">{photos.length} taken{minCount > 0 ? `, ${minCount} needed` : ""}{photos.some(p => !p.uploaded) ? " · some not sent yet" : ""}</span>
    <div className="photo-previews">
      {photos.map((p, i) => <div key={p.clientId} className="photo-preview" data-testid="photo-preview">
        {p.preview || p.url ? <a href={p.url ?? p.preview} target="_blank" rel="noreferrer"><img src={p.preview ?? p.url} alt={`${label}, photo ${i + 1}`} /></a> : <p className="muted small">Preview unavailable on this phone. {p.uploaded ? "The office has the photo." : "The saved photo will send with this visit."}</p>}
        <span className="muted small">{p.uploaded ? "Sent to office" : "Saved photo · waiting to send"}</span>
        {!readOnly && <div className="row"><button type="button" className="secondary" disabled={disabled} onClick={() => choose(p.clientId)} aria-label={`Replace or retake ${label}, photo ${i + 1}`}>Replace / retake</button><button type="button" className="secondary" disabled={disabled} onClick={() => onRemove(p.clientId)} aria-label={`Remove ${label}, photo ${i + 1}`}>Remove</button></div>}
      </div>)}
    </div>
    {!readOnly && <><button type="button" className="secondary photo-button" disabled={disabled} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} onClick={() => choose()}>Add photo: {label}</button><input ref={input} type="file" accept="image/*" capture="environment" multiple hidden disabled={disabled} aria-label={`Add photo: ${label}`} onChange={e => onAdd(e, replace.current)} /></>}
    {error && <span id={`${id}-error`} className="error small">{error}</span>}
  </div>;
}
