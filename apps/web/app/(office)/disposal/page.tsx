"use client";

import {
  humanize,
  roleHasPermission,
  VOLUME_UNITS,
  WASTE_TYPE_LABELS,
  type DisposalFacility,
  type DisposalLoad,
  type PumpingRecord,
} from "@aerowise/domain";
import Link from "next/link";
import { useRef, useState } from "react";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { day, gallons, plural, today as companyToday, volume } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

const PAGE = 50;

/**
 * SW-6: disposal records. Pump-outs in no load yet, the company's disposal records (each a load
 * delivered to a facility), recording one from the office, and the date-range log.
 */
export default function DisposalPage() {
  const me = useSession();
  const on = useFeature("pumping");
  const office = canEdit(me) && roleHasPermission(me.role, "work:write");
  const [offset, setOffset] = useState(0);
  const loads = useLoad<{ items: DisposalLoad[]; nextOffset: number | null }>(`/disposal/loads?limit=${PAGE}&offset=${offset}`);
  const [unloadedOffset, setUnloadedOffset] = useState(0);
  const unloaded = useLoad<{ items: PumpingRecord[]; nextOffset: number | null }>(`/pumping-records?unloaded=true&limit=50&offset=${unloadedOffset}`);
  const facilities = useLoad<{ items: DisposalFacility[] }>(office ? "/disposal-facilities" : null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // The company's date, not the UTC one (tomorrow from 7 PM in Texas).
  const today = companyToday();
  const monthStart = `${today.slice(0, 8)}01`;
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);

  function toggle(groupId: string) {
    const next = new Set(picked);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    setPicked(next);
  }

  // One id per disposal being recorded: a retry after a lost answer records it once.
  const clientId = useRef<string | null>(null);
  const recording = useSubmit(
    async (v: Record<string, string | undefined>, form: HTMLFormElement) => {
      clientId.current ??= crypto.randomUUID();
      await api("/disposal/loads/sync", {
        method: "PUT",
        body: {
          clientId: clientId.current,
          vehicleId: pickedTrucks[0] ?? null,
          facilityId: v.facilityId,
          deliveredOn: v.deliveredOn,
          manifestReference: v.manifestReference ?? null,
          total: Number(v.total),
          unit: v.unit ?? "gallons",
          notes: v.notes ?? null,
          pumpingGroupIds: [...picked],
        },
      });
      clientId.current = null;
      form.reset();
      setPicked(new Set());
      await Promise.all([loads.reload(), unloaded.reload()]);
    },
    { fallback: "Could not record the disposal." },
  );
  const problem = recording.error;

  const pickedRows = (unloaded.data?.items ?? []).filter((p) => picked.has(p.groupId));
  const pickedVolume = pickedRows.reduce((sum, p) => sum + p.volumeMilligallons, 0);
  // A load is on one truck: the truck its pump-outs were recorded on.
  const pickedTrucks = [...new Set(pickedRows.map((p) => p.vehicleId))];

  return (
    <div className="stack">
      <h1>Disposal records</h1>
      <LoadState load={loads} label="disposal records" />
      <LoadState load={unloaded} label="unloaded pump-outs" />
      <LoadState load={facilities} label="disposal facilities" />
      <p className="muted">Where each truck load of pumped waste was delivered, with its manifest or reference number.</p>
      {!on && <p className="muted small">Pumping is not switched on for this deployment; existing records stay readable.</p>}
      <FormError error={problem} />

      <section className="stack">
        <h2>Pump-outs not in a disposal record yet</h2>
        {!unloaded.data ? (
          <LoadState load={unloaded} label="unloaded pump-outs" />
        ) : unloaded.data.items.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <div className="table-scroll">
            <table className="compact stack" data-testid="unloaded-pump-outs">
              <thead>
                <tr>
                  {office && on && <th />}
                  <th>Pumped</th>
                  <th>Site</th>
                  <th>Waste</th>
                  <th className="num">Volume</th>
                  <th>Truck</th>
                  <th>Technician</th>
                </tr>
              </thead>
              <tbody>
                {unloaded.data.items.map((p) => (
                  <tr key={p.groupId}>
                    {office && on && (
                      <td className="actions">
                        <input type="checkbox" checked={picked.has(p.groupId)} onChange={() => toggle(p.groupId)} aria-label={`Include ${p.siteAddress}`} />
                      </td>
                    )}
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
                    <td data-label="Truck">{p.vehicleName ?? ""}</td>
                    <td data-label="Technician">{p.technicianName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {unloaded.data?.nextOffset !== null && unloaded.data?.nextOffset !== undefined && <p className="muted small">Showing the newest 200.</p>}
      </section>

      {unloaded.data && (unloadedOffset > 0 || unloaded.data.nextOffset !== null) && <nav className="row" aria-label="Unloaded pump-out pages"><span>Showing {unloadedOffset + 1}–{unloadedOffset + unloaded.data.items.length}{unloaded.data.nextOffset !== null ? "; more available" : ""}</span><button className="secondary" disabled={unloadedOffset === 0} onClick={() => { setPicked(new Set()); setUnloadedOffset(Math.max(0, unloadedOffset - 50)); }}>Previous pump-outs</button><button className="secondary" disabled={unloaded.data.nextOffset === null} onClick={() => { setPicked(new Set()); setUnloadedOffset(unloaded.data!.nextOffset!); }}>Next pump-outs</button></nav>}
      {office && on && (
        <form className="card stack" onSubmit={recording.form} data-testid="record-disposal">
          <h2>Record a disposal</h2>
          <p className="muted small">
            {picked.size === 0
              ? "Tick the pump-outs the truck delivered."
              : `${plural(picked.size, "pump-out")} ticked, ${gallons(pickedVolume)} recorded, on ${pickedTrucks.length > 1 ? "more than one truck" : (pickedRows[0]?.vehicleName ?? "no named truck")}.`}
          </p>
          {pickedTrucks.length > 1 && <p className="error small">A disposal record is for one truck load. Tick pump-outs from the same truck.</p>}
          <div className="grid">
            <label>
              Facility
              <select name="facilityId" required defaultValue="">
                <option value="" disabled>
                  Pick a facility
                </option>
                {facilities.data?.items
                  .filter((f) => f.active)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Delivered on
              <input name="deliveredOn" type="date" required defaultValue={today} />
            </label>
            <label>
              Manifest/reference number
              <input name="manifestReference" maxLength={200} />
            </label>
            <label>
              Total delivered
              <input name="total" type="number" min="0.1" step="0.1" required />
            </label>
            <label>
              Unit
              <select name="unit" defaultValue="gallons">
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
            <input name="notes" maxLength={2000} />
          </label>
          {facilities.data?.items.length === 0 && (
            <p className="muted small">
              Add a facility under <Link href="/settings/trucks">Trucks and facilities</Link> first.
            </p>
          )}
          <div className="row">
            <SubmitButton busy={recording.busy} disabled={picked.size === 0 || pickedTrucks.length > 1}>
              Record disposal
            </SubmitButton>
          </div>
        </form>
      )}

      <section className="stack">
        <h2>Disposal records</h2>
        {!loads.data ? (
          <LoadState load={loads} label="disposal records" />
        ) : loads.data.items.length === 0 ? (
          <p className="muted">No disposal records yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="compact stack" data-testid="disposal-loads">
              <thead>
                <tr>
                  <th>Delivered</th>
                  <th>Facility</th>
                  <th>Truck</th>
                  <th>Manifest/reference</th>
                  <th className="num">Total</th>
                  <th className="num">Pump-outs</th>
                  <th className="num">Photos</th>
                </tr>
              </thead>
              <tbody>
                {loads.data.items.map((l) => (
                  <tr key={l.groupId}>
                    <td data-label="Delivered">
                      <Link href={`/disposal/${l.groupId}`}>{day(l.deliveredOn)}</Link> {l.revision > 1 && <Badge>Corrected</Badge>}
                    </td>
                    <td data-label="Facility">{l.facilityName}</td>
                    <td data-label="Truck">{l.vehicleName ?? ""}</td>
                    <td data-label="Manifest/reference">{l.manifestReference ?? <span className="muted">None</span>}</td>
                    <td data-label="Total" className="num">
                      {volume(l.enteredTotal, l.enteredUnit)}
                      {l.volumesDiffer && <div className="warn small">Pump-outs add up to {gallons(l.itemsMilligallons)}</div>}
                    </td>
                    <td data-label="Pump-outs" className="num">
                      {l.items.length}
                    </td>
                    <td data-label="Photos" className="num">
                      {l.photos.length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {loads.data && (offset > 0 || loads.data.nextOffset !== null) && (
          <div className="row">
            <button type="button" className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Newer
            </button>
            <button type="button" className="secondary" disabled={loads.data.nextOffset === null} onClick={() => loads.data?.nextOffset != null && setOffset(loads.data.nextOffset)}>
              Older
            </button>
          </div>
        )}
      </section>

      {office && (
        <section className="card stack">
          <h2>Disposal log</h2>
          <p className="muted small">Every disposal record delivered in the range, with the pump-outs in each, for the company&apos;s own records.</p>
          <div className="row">
            <label>
              From
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <a className="button secondary" href={`/api/disposal/log.csv?from=${from}&to=${to}`} data-testid="disposal-log-csv">
              Download CSV
            </a>
            <a className="button secondary" href={`/api/disposal/log.pdf?from=${from}&to=${to}`} data-testid="disposal-log-pdf">
              Download PDF
            </a>
          </div>
        </section>
      )}
    </div>
  );
}
