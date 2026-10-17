"use client";

import { humanize, roleHasPermission, VOLUME_UNITS, WASTE_TYPE_LABELS, type DisposalFacility, type DisposalLoad, type PumpingRecord, type Vehicle } from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, formValues } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { day, gallons, plural, volume, when } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";
import { usePageTitle } from "@/lib/title";

type Revision = { revision: number; current: boolean; summary: string; correctionReason: string | null; recordedByName: string; createdAt: string };
type Detail = DisposalLoad & { revisions: Revision[] };

/** One disposal record: its pump-outs, manifest photos and every revision. Corrections add a revision. */
export default function DisposalRecordPage() {
  const { id } = useParams<{ id: string }>();
  const me = useSession();
  const on = useFeature("pumping");
  const office = canEdit(me) && roleHasPermission(me.role, "work:write");
  const recordLoad = useLoad<Detail>(`/disposal/loads/${id}`);
  const { data: l, reload } = recordLoad;
  const [unloadedOffset, setUnloadedOffset] = useState(0);
  const unloaded = useLoad<{ items: PumpingRecord[]; nextOffset: number | null }>(office ? `/pumping-records?unloaded=true&limit=50&offset=${unloadedOffset}` : null);
  const vehicles = useLoad<{ items: Vehicle[] }>(office ? "/vehicles" : null);
  const facilities = useLoad<{ items: DisposalFacility[] }>(office ? "/disposal-facilities" : null);
  const [correcting, setCorrecting] = useState(false);
  // The pump-out being taken out of the load: its reason is asked on its own row.
  const [removing, setRemoving] = useState<string | null>(null);
  usePageTitle(l ? `${day(l.deliveredOn)} · ${l.facilityName}` : null);
  const acting = useSubmit(
    async (path: string, body: unknown) => {
      await api(path, { method: "POST", body });
      await Promise.all([reload(), unloaded.reload()]);
      return true;
    },
    { fallback: "Could not save." },
  );
  const act = async (path: string, body: unknown) => (await acting.run(path, body)) === true;
  const problem = acting.error;

  async function correct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    const ok = await act(`/disposal/loads/${id}/correct`, {
      vehicleId: v.vehicleId ?? null,
      facilityId: v.facilityId,
      deliveredOn: v.deliveredOn,
      manifestReference: v.manifestReference ?? null,
      total: Number(v.total),
      unit: v.unit,
      notes: v.notes ?? null,
      reason: v.reason,
    });
    if (ok) setCorrecting(false);
  }

  async function remove(p: PumpingRecord, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { reason } = formValues(event.currentTarget);
    if (await act(`/disposal/loads/${id}/items/remove`, { pumpingGroupId: p.groupId, reason })) setRemoving(null);
  }

  if (!l) return <LoadState load={recordLoad} label="disposal record" back={{ href: "/disposal", label: "Disposal records" }} />;
  const editable = office && on;
  return (
    <div className="stack">
      <LoadState load={recordLoad} label="disposal record" back={{ href: "/disposal", label: "Disposal records" }} />
      <p>
        <Link href="/disposal">← Disposal records</Link>
      </p>
      <h1>
        {day(l.deliveredOn)} · {l.facilityName}
      </h1>
      <p className="muted">
        {volume(l.enteredTotal, l.enteredUnit)} · {l.vehicleName ?? "no truck named"} ·{" "}
        {l.manifestReference ? `manifest/reference ${l.manifestReference}` : "no manifest/reference number"} · recorded by {l.recordedByName}
        {l.revision > 1 && ` · revision ${l.revision}`}
      </p>
      {l.notes && <p style={{ whiteSpace: "pre-wrap" }}>{l.notes}</p>}
      {l.volumesDiffer && (
        <p className="banner warn" role="status">
          The pump-outs in this load add up to {gallons(l.itemsMilligallons)}, which differs from the load total of {gallons(l.totalMilligallons)}.
        </p>
      )}
      <FormError error={problem} />

      <section className="stack">
        <h2>Pump-outs</h2>
        {l.items.length === 0 ? (
          <p className="muted">No pump-outs in this load.</p>
        ) : (
          <div className="table-scroll">
            <table className="compact stack" data-testid="load-items">
              <thead>
                <tr>
                  <th>Pumped</th>
                  <th>Site</th>
                  <th>Waste</th>
                  <th className="num">Volume</th>
                  <th>Technician</th>
                  {editable && <th />}
                </tr>
              </thead>
              <tbody>
                {l.items.map((p) => (
                  <tr key={p.groupId}>
                    <td data-label="Pumped">{day(p.serviceDate)}</td>
                    <td data-label="Site">
                      <Link href={`/sites/${p.siteId}`}>{p.siteAddress}</Link>
                      <div className="muted small">
                        {p.customerName} · <Link href={`/work/${p.workOrderId}`}>{p.workOrderLabel}</Link>
                      </div>
                    </td>
                    <td data-label="Waste">{WASTE_TYPE_LABELS[p.wasteType]}</td>
                    <td data-label="Volume" className="num">
                      {volume(p.enteredVolume, p.enteredUnit)}
                    </td>
                    <td data-label="Technician">{p.technicianName}</td>
                    {editable && (
                      <td className="actions">
                        {removing === p.groupId ? (
                          <form className="stack" onSubmit={(e) => void remove(p, e)}>
                            <label>
                              Why is it not in this load?
                              <input name="reason" required maxLength={2000} autoFocus />
                            </label>
                            <div className="row">
                              <SubmitButton className="danger" busy={acting.busy}>
                                Take it out
                              </SubmitButton>
                              <button type="button" className="link" onClick={() => setRemoving(null)}>
                                Keep it
                              </button>
                            </div>
                          </form>
                        ) : (
                          <button type="button" className="link danger" onClick={() => setRemoving(p.groupId)}>
                            Take out
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <LoadState load={unloaded} label="available pump-outs" />
        <LoadState load={vehicles} label="vehicles" />
        <LoadState load={facilities} label="facilities" />
        {unloaded.data && editable && <p className="muted small">Pump-outs you can add: {unloaded.data.nextOffset !== null ? `${unloaded.data.items.length}+` : unloaded.data.items.length}</p>}
        {unloaded.data && (unloadedOffset > 0 || unloaded.data.nextOffset !== null) && <nav className="row" aria-label="Available pump-out pages"><span>{plural(unloaded.data.items.length, "pump-out")} on this page; more available</span><button className="secondary" disabled={unloadedOffset === 0} onClick={() => setUnloadedOffset(Math.max(0, unloadedOffset - 50))}>Previous pump-outs</button><button className="secondary" disabled={unloaded.data.nextOffset === null} onClick={() => setUnloadedOffset(unloaded.data!.nextOffset!)}>Next pump-outs</button></nav>}
        {editable && unloaded.data && unloaded.data.items.length > 0 && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const v = formValues(e.currentTarget);
              if (v.pumpingGroupId) void act(`/disposal/loads/${id}/items`, { pumpingGroupId: v.pumpingGroupId });
            }}
          >
            <select name="pumpingGroupId" aria-label="Pump-out to add" defaultValue="">
              <option value="" disabled>
                Add a pump-out in no load
              </option>
              {unloaded.data.items.map((p) => (
                <option key={p.groupId} value={p.groupId}>
                  {day(p.serviceDate)} · {p.siteAddress} · {volume(p.enteredVolume, p.enteredUnit)}
                </option>
              ))}
            </select>
            <SubmitButton className="secondary" busy={acting.busy}>
              Add
            </SubmitButton>
          </form>
        )}
      </section>

      <section className="stack">
        <h2>Manifest photos</h2>
        {l.photos.length === 0 ? (
          <p className="muted">No photos.</p>
        ) : (
          <div className="row">
            {l.photos.map((ph) => (
              <a key={ph.id} href={ph.url} target="_blank" rel="noreferrer">
                <img src={ph.url} alt="Manifest photo" style={{ maxWidth: 220, maxHeight: 220 }} />
              </a>
            ))}
          </div>
        )}
      </section>

      {editable && !correcting && (
        <div className="row">
          <button type="button" className="secondary" onClick={() => setCorrecting(true)}>
            Correct this record
          </button>
        </div>
      )}
      {editable && correcting && (
        <form className="card stack" onSubmit={correct} data-testid="correct-load">
          <h2>Correct this record</h2>
          <p className="muted small">The record keeps its pump-outs and photos; the earlier version stays in the history below.</p>
          <div className="grid">
            <label>
              Facility
              <select name="facilityId" required defaultValue={l.facilityId}>
                {facilities.data?.items.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Truck
              <select name="vehicleId" defaultValue={l.vehicleId ?? ""}>
                <option value="">Not named</option>
                {vehicles.data?.items.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Delivered on
              <input name="deliveredOn" type="date" required defaultValue={l.deliveredOn} />
            </label>
            <label>
              Manifest/reference number
              <input name="manifestReference" maxLength={200} defaultValue={l.manifestReference ?? ""} />
            </label>
            <label>
              Total delivered
              <input name="total" type="number" min="0.1" step="0.1" required defaultValue={l.enteredTotal} />
            </label>
            <label>
              Unit
              <select name="unit" defaultValue={l.enteredUnit}>
                {VOLUME_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {humanize(u)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Notes
            <input name="notes" maxLength={2000} defaultValue={l.notes ?? ""} />
          </label>
          <label>
            Reason for the correction
            <input name="reason" required minLength={3} maxLength={2000} />
          </label>
          <div className="row">
            <SubmitButton busy={acting.busy}>Save correction</SubmitButton>
            <button type="button" className="secondary" onClick={() => setCorrecting(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <section className="stack">
        <h2>History</h2>
        <ol className="timeline" data-testid="load-revisions">
          {l.revisions.map((r) => (
            <li key={r.revision}>
              <strong>Revision {r.revision}</strong>
              {r.current && <Badge>Current</Badge>} · {r.summary}
              {r.correctionReason && <div className="muted small">Reason: {r.correctionReason}</div>}
              <div className="muted small">
                {r.recordedByName} · {when(r.createdAt)}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
