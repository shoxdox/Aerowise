"use client";

import { useState } from "react";
import { visibleFields, type TemplateDefinition, type Stop } from "@aerowise/domain";
import type { LocalInspection } from "@/lib/offline/db";
import { when } from "@/lib/format";
import { PhotoField } from "./PhotoField";

/** A finished record is viewable, without exposing any mutation controls. */
export function InspectionRecap({ stop, inspection, definition, onRefreshPhotos }: { stop: Stop; inspection: LocalInspection; definition: TemplateDefinition; onRefreshPhotos: () => Promise<boolean> }) {
  const [refreshing, setRefreshing] = useState(false);
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  async function refreshPhotos() {
    if (refreshing) return;
    setRefreshing(true);
    const refreshed = await onRefreshPhotos().catch(() => false);
    setPhotoNotice(refreshed ? "Photo links refreshed. A missing file may still need office recovery." : "Photo previews could not refresh. Connect with signal and retry, or ask the office to check the recorded photos.");
    setRefreshing(false);
  }
  const delivered = inspection.server?.status === "completed";
  return <div className="stack" data-testid="inspection-recap">
    <h1>Completed inspection</h1><p className="muted">{stop.customer.displayName} · {stop.site.addressLine1}</p>
    <p className={`card ${delivered ? "ok" : "warn"}`} role="status">{delivered ? "Sent to office. The maintenance provider reviews and signs the report in the office; this delivery status does not establish authority acceptance." : "Finished and saved on this phone · waiting to send to the office."}</p>
    <p className="small">Finished {when(inspection.completedAt)}. This record is read-only.</p>
    <dl className="details card">{visibleFields(definition, inspection.values).map(field => {
      const value = inspection.values[field.key];
      const answer = value == null || value === "" ? "Not recorded" : value === true ? "Yes" : value === false ? "No" : field.type === "select" ? field.options.find(o => o.value === value)?.label ?? String(value) : `${value}${field.type === "number" && field.unit ? ` ${field.unit}` : ""}`;
      return <div key={field.key} style={{ display: "contents" }}><dt>{field.label}</dt><dd style={{ whiteSpace: "pre-wrap" }}>{answer}</dd></div>;
    })}</dl>
    <section className="card stack"><h2>Photos</h2><button type="button" className="secondary" disabled={refreshing} onClick={() => void refreshPhotos()}>{refreshing ? "Refreshing photos…" : "Refresh photo links"}</button>{photoNotice && <p className="muted small" role="status">{photoNotice}</p>}{definition.photos.filter(p => inspection.photos.some(photo => photo.photoKey === p.key)).map(p => <PhotoField key={p.key} label={p.label} photoKey={p.key} minCount={p.minCount} photos={inspection.photos.filter(photo => photo.photoKey === p.key)} disabled readOnly onAdd={() => {}} onRemove={() => {}} />)}</section>
    {inspection.issues.length > 0 && <section className="card"><h2>Issues recorded</h2><ul>{inspection.issues.map(i => <li key={i.clientId}>{i.description || i.type} · {i.severity}</li>)}</ul></section>}
    {inspection.accessIssue && <p className="card">Access problem: {inspection.accessIssue}</p>}
  </div>;
}
