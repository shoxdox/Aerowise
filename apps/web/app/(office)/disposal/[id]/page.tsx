"use client";

import { formatEntered, formatGallons, roleHasPermission, VOLUME_UNITS, WASTE_TYPE_LABELS, type DisposalFacility, type DisposalLoad, type PumpingRecord, type Vehicle } from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { day } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

type Revision = { revision: number; current: boolean; summary: string; correctionReason: string | null; recordedByName: string; createdAt: string };
type Detail = DisposalLoad & { revisions: Revision[] };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** One disposal record: its pump-outs, manifest photos and every revision. Corrections add a revision. */
export default function DisposalRecordPage() {
  const { id } = useParams<{ id: string }>();
  const me = useSession();
  const on = useFeature("pumping");
  const office = canEdit(me) && roleHasPermission(me.role, "work:write");
  const { data: l, error, reload } = useLoad<Detail>(`/disposal/loads/${id}`);
  const unloaded = useLoad<{ items: PumpingRecord[] }>(office ? "/pumping-records?unloaded=true&limit=200" : null);
  const vehicles = useLoad<{ items: Vehicle[] }>(office ? "/vehicles" : null);
  const facilities = useLoad<{ items: DisposalFacility[] }>(office ? "/disposal-facilities" : null);
  const [correcting, setCorrecting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function act(path: string, body: unknown) {
    setProblem(null);
    try {
      await api(path, { method: "POST", body });
      await Promise.all([reload(), unloaded.reload()]);
      return true;
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save");
      return false;
    }
  }

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

  async function remove(p: PumpingRecord) {
    const reason = window.prompt(`Why is the pump-out at ${p.siteAddress} not in this load?`);
    if (!reason) return;
    await act(`/disposal/loads/${id}/items/remove`, { pumpingGroupId: p.groupId, reason });
  }

  if (error) return <p className="error">{error}</p>;
  if (!l) return <p className="muted">Loading…</p>;
  const editable = office && on;
  return (
    <div className="stack">
      <p>
        <Link href="/disposal">Disposal records</Link>
      </p>
      <h1>
        {day(l.deliveredOn)} · {l.facilityName}
      </h1>
      <p className="muted">
        {formatEntered(l.enteredTotal, l.enteredUnit)} · {l.vehicleName ? `truck ${l.vehicleName}` : "no truck named"} ·{" "}
        {l.manifestReference ? `manifest/reference ${l.manifestReference}` : "no manifest/reference number"} · recorded by {l.recordedByName}
        {l.revision > 1 && ` · revision ${l.revision}`}
      </p>
      {l.notes && <p style={{ whiteSpace: "pre-wrap" }}>{l.notes}</p>}
      {l.volumesDiffer && (
        <p className="banner warn" role="status">
          The pump-outs in this load add up to {formatGallons(l.itemsMilligallons)}, which differs from the load total of {formatGallons(l.totalMilligallons)}.
        </p>
      )}
      {problem && <p className="error">{problem}</p>}

      <section className="stack">
        <h2>Pump-outs</h2>
        {l.items.length === 0 ? (
          <p className="muted">No pump-outs in this load.</p>
        ) : (
          <div className="table-scroll">
            <table className="compact" data-testid="load-items">
              <thead>
                <tr>
                  <th>Pumped</th>
                  <th>Site</th>
                  <th>Waste</th>
                  <th>Volume</th>
                  <th>Technician</th>
                  {editable && <th />}
                </tr>
              </thead>
              <tbody>
                {l.items.map((p) => (
                  <tr key={p.groupId}>
                    <td>{day(p.serviceDate)}</td>
                    <td>
                      <Link href={`/sites/${p.siteId}`}>{p.siteAddress}</Link>
                      <div className="muted small">
                        {p.customerName} · <Link href={`/work/${p.workOrderId}`}>{p.workOrderLabel}</Link>
                      </div>
                    </td>
                    <td>{WASTE_TYPE_LABELS[p.wasteType]}</td>
                    <td>{formatEntered(p.enteredVolume, p.enteredUnit)}</td>
                    <td>{p.technicianName}</td>
                    {editable && (
                      <td>
                        <button type="button" className="link" onClick={() => void remove(p)}>
                          Take out
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
                  {p.serviceDate} · {p.siteAddress} · {formatEntered(p.enteredVolume, p.enteredUnit)}
                </option>
              ))}
            </select>
            <button type="submit" className="secondary">
              Add
            </button>
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
                    {u}
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
            <button type="submit">Save correction</button>
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
              {r.current && <span className="badge">current</span>} · {r.summary}
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
