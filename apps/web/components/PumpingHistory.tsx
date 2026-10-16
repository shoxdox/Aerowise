"use client";

import { humanize, roleHasPermission, VOLUME_UNITS, WASTE_TYPE_LABELS, WASTE_TYPES, type PumpingRecord } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { day, plural, volume } from "@/lib/format";
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
  const correction = useSubmit(
    async (v: Record<string, string | undefined>) => {
      const p = data?.items.find((x) => x.groupId === correcting);
      if (!p) return;
      await api(`/pumping-records/${p.groupId}/correct`, {
        method: "POST",
        body: { volume: Number(v.volume), unit: v.unit, wasteType: v.wasteType, wasteTypeNote: v.wasteTypeNote ?? null, tanks: p.tanks, vehicleId: p.vehicleId, serviceDate: v.serviceDate, reason: v.reason },
      });
      setCorrecting(null);
      await reload();
    },
    { fallback: "Could not save the correction." },
  );
  const problem = correction.error;
  if (!data) return <LoadState load={recordLoad} label="pumping history" />;
  if (!on && data.items.length === 0) return null;

  return (
    <details className="card"><summary>Pumping and disposal history ({data.nextOffset !== null ? `${data.items.length}+ pump-outs` : plural(data.items.length, "pump-out")})</summary><section className="stack" data-testid="pumping-history"><LoadState load={recordLoad} label="pumping history" />
      <h2>{siteId ? "Pumping history" : "Pump-outs"}</h2>
      <FormError error={problem} />
      {data.items.length === 0 ? (
        <p className="muted">No pump-outs recorded.</p>
      ) : (
        <div className="table-scroll">
          <table className="compact stack">
            <thead>
              <tr>
                <th>Pumped</th>
                <th>Waste</th>
                <th className="num">Volume</th>
                <th>Tanks</th>
                <th>Technician</th>
                <th>Disposal</th>
                {office && on && <th />}
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.groupId}>
                  <td data-label="Pumped">
                    {day(p.serviceDate)}
                    {siteId && (
                      <div className="muted small">
                        <Link href={`/work/${p.workOrderId}`}>{p.workOrderLabel}</Link>
                      </div>
                    )}
                    {p.revision > 1 && <Badge>Corrected</Badge>}
                  </td>
                  <td data-label="Waste">
                    {WASTE_TYPE_LABELS[p.wasteType]}
                    {p.wasteTypeNote && <div className="muted small">{p.wasteTypeNote}</div>}
                  </td>
                  <td data-label="Volume" className="num">
                    {volume(p.enteredVolume, p.enteredUnit)}
                  </td>
                  <td data-label="Tanks">{p.tanks.map((t) => t.label).join(", ")}</td>
                  <td data-label="Technician">{p.technicianName}</td>
                  <td data-label="Disposal">{p.loadGroupId ? <Link href={`/disposal/${p.loadGroupId}`}>Recorded</Link> : <span className="muted">Not yet</span>}</td>
                  {office && on && (
                    <td className="actions">
                      {correcting === p.groupId ? (
                        <form className="stack" onSubmit={correction.form}>
                          <div className="row">
                            <input name="volume" type="number" min="0.1" step="0.1" required defaultValue={p.enteredVolume} aria-label="Volume" />
                            <select name="unit" defaultValue={p.enteredUnit} aria-label="Unit">
                              {VOLUME_UNITS.map((u) => (
                                <option key={u} value={u}>
                                  {humanize(u)}
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
                            <SubmitButton busy={correction.busy}>Save</SubmitButton>
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
      {(offset > 0 || data.nextOffset !== null) && (
        <nav className="row" aria-label="Pumping history pages">
          <span className="muted small">
            Showing {offset + 1}–{offset + data.items.length}
            {data.nextOffset !== null ? "; more available" : ""}
          </span>
          <button className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
            Previous
          </button>
          <button className="secondary" disabled={data.nextOffset === null} onClick={() => setOffset(data.nextOffset!)}>
            Next
          </button>
        </nav>
      )}
    </section></details>
  );
}
