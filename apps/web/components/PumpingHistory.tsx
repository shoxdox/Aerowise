"use client";

import { formatEntered, roleHasPermission, VOLUME_UNITS, WASTE_TYPE_LABELS, WASTE_TYPES, type PumpingRecord } from "@aerowise/domain";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { LoadState } from "@/components/LoadState";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { day } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

/**
 * SW-6: the pump-outs recorded at a site or on a work order, newest first, each at its current
 * revision. The office corrects one by adding a revision with a reason.
 */
export function PumpingHistory({ siteId, workOrderId }: { siteId?: string; workOrderId?: string }) {
  const me = useSession();
  const on = useFeature("pumping");
  const office = canEdit(me) && roleHasPermission(me.role, "work:write");
  const query = siteId ? `siteId=${siteId}` : `workOrderId=${workOrderId}`;
  const [offset, setOffset] = useState(0);
  const recordLoad = useLoad<{ items: PumpingRecord[]; nextOffset: number | null }>(`/pumping-records?${query}&limit=50&offset=${offset}`);
  const { data, reload } = recordLoad;
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (!data) return <LoadState load={recordLoad} label="pumping history" />;
  if (!on && data.items.length === 0) return null;

  async function correct(p: PumpingRecord, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    setProblem(null);
    try {
      await api(`/pumping-records/${p.groupId}/correct`, {
        method: "POST",
        body: { volume: Number(v.volume), unit: v.unit, wasteType: v.wasteType, wasteTypeNote: v.wasteTypeNote ?? null, tanks: p.tanks, vehicleId: p.vehicleId, serviceDate: v.serviceDate, reason: v.reason },
      });
      setCorrecting(null);
      await reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save the correction");
    }
  }

  return (
    <details className="card"><summary>Pumping and disposal history ({data.items.length}{data.nextOffset !== null ? "+" : ""} records on this page)</summary><section className="stack" data-testid="pumping-history"><LoadState load={recordLoad} label="pumping history" />
      <h2>{siteId ? "Pumping history" : "Pump-outs"}</h2>
      {problem && <p className="error">{problem}</p>}
      {data.items.length === 0 ? (
        <p className="muted">No pump-outs recorded.</p>
      ) : (
        <div className="table-scroll">
          <table className="compact">
            <thead>
              <tr>
                <th>Pumped</th>
                <th>Waste</th>
                <th>Volume</th>
                <th>Tanks</th>
                <th>Technician</th>
                <th>Disposal</th>
                {office && on && <th />}
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.groupId}>
                  <td>
                    {day(p.serviceDate)}
                    {siteId && (
                      <div className="muted small">
                        <Link href={`/work/${p.workOrderId}`}>{p.workOrderLabel}</Link>
                      </div>
                    )}
                    {p.revision > 1 && <span className="badge">corrected</span>}
                  </td>
                  <td>
                    {WASTE_TYPE_LABELS[p.wasteType]}
                    {p.wasteTypeNote && <div className="muted small">{p.wasteTypeNote}</div>}
                  </td>
                  <td>{formatEntered(p.enteredVolume, p.enteredUnit)}</td>
                  <td>{p.tanks.map((t) => t.label).join(", ")}</td>
                  <td>{p.technicianName}</td>
                  <td>{p.loadGroupId ? <Link href={`/disposal/${p.loadGroupId}`}>Recorded</Link> : <span className="muted">Not yet</span>}</td>
                  {office && on && (
                    <td>
                      {correcting === p.groupId ? (
                        <form className="stack" onSubmit={(e) => void correct(p, e)}>
                          <div className="row">
                            <input name="volume" type="number" min="0.1" step="0.1" required defaultValue={p.enteredVolume} aria-label="Volume" />
                            <select name="unit" defaultValue={p.enteredUnit} aria-label="Unit">
                              {VOLUME_UNITS.map((u) => (
                                <option key={u} value={u}>
                                  {u}
                                </option>
                              ))}
                            </select>
                            <select name="wasteType" defaultValue={p.wasteType} aria-label="Waste">
                              {WASTE_TYPES.map((w) => (
                                <option key={w} value={w}>
                                  {WASTE_TYPE_LABELS[w]}
                                </option>
                              ))}
                            </select>
                            <input name="serviceDate" type="date" required defaultValue={p.serviceDate} aria-label="Pumped on" />
                          </div>
                          <input name="wasteTypeNote" maxLength={500} defaultValue={p.wasteTypeNote ?? ""} placeholder="Waste note" aria-label="Waste note" />
                          <input name="reason" required minLength={3} maxLength={2000} placeholder="Reason for the correction" aria-label="Reason for the correction" />
                          <div className="row">
                            <button type="submit">Save</button>
                            <button type="button" className="secondary" onClick={() => setCorrecting(null)}>
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <button type="button" className="link" onClick={() => setCorrecting(p.groupId)}>
                          Correct
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
      <nav className="row" aria-label="Pumping history pages"><span className="muted small">Showing records {data.items.length ? offset + 1 : 0}–{offset + data.items.length}{data.nextOffset !== null ? "; more available" : "; end of history"}</span><button className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><button className="secondary" disabled={data.nextOffset === null} onClick={() => setOffset(data.nextOffset!)}>Next</button></nav>
    </section></details>
  );
}
