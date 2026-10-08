"use client";

import { formatEntered, formatGallons, VOLUME_UNITS, WASTE_TYPE_LABELS, WASTE_TYPES, type PumpingFieldData, type PumpOutInput, type VolumeUnit, type WasteType } from "@aerowise/domain";
import { useEffect, useState, type ChangeEvent } from "react";
import { preparePhoto } from "@/lib/offline/data";
import { saveOrReport, STORAGE_FULL_MESSAGE, useStorageFull } from "@/lib/offline/storage";
import type { LocalLoad, WorkBlob, WorkStore } from "@/lib/offline/work";

// SW-6 on the phone: the pump-out recorded with a pumping visit, and the disposal record for a
// truck load delivered to a facility. Both are saved on the phone first and sent when there is
// signal. Wording: "Disposal record" and "Manifest/reference number"; nothing here says a load is
// compliant or that a facility accepted it.

/** The pump-out part of a pumping visit's form. */
export function PumpOutSection({
  value,
  vehicles,
  problem,
  onChange,
}: {
  value: PumpOutInput | null | undefined;
  vehicles: PumpingFieldData["vehicles"];
  problem: string | null;
  onChange: (next: PumpOutInput | null) => void;
}) {
  const [volume, setVolume] = useState(value?.volume !== undefined ? String(value.volume) : "");
  const set = (patch: Partial<PumpOutInput>) => {
    const base: PumpOutInput = value ?? { clientId: crypto.randomUUID(), volume: 0, unit: "gallons", wasteType: "septage", tanks: [], vehicleId: vehicles.find((v) => v.active)?.id ?? null };
    onChange({ ...base, ...patch });
  };
  function setVolumeText(e: ChangeEvent<HTMLInputElement>) {
    setVolume(e.target.value);
    const n = Math.round(Number(e.target.value) * 10) / 10;
    if (e.target.value === "" || !Number.isFinite(n) || n <= 0) onChange(value ? { ...value, volume: 0 } : null);
    else set({ volume: n });
  }
  return (
    <section className={`card stack ${problem ? "has-problem" : ""}`} data-testid="pump-out">
      <h2>Pump-out</h2>
      <div className="row">
        <label>
          Volume pumped<span className="req"> *</span>
          <input type="number" inputMode="decimal" min="0.1" step="0.1" value={volume} onChange={setVolumeText} aria-label="Volume pumped" />
        </label>
        <label>
          Unit
          <select value={value?.unit ?? "gallons"} onChange={(e) => set({ unit: e.target.value as VolumeUnit })} aria-label="Volume unit">
            {VOLUME_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Waste
        <select value={value?.wasteType ?? "septage"} onChange={(e) => set({ wasteType: e.target.value as WasteType })} aria-label="Waste">
          {WASTE_TYPES.map((w) => (
            <option key={w} value={w}>
              {WASTE_TYPE_LABELS[w]}
            </option>
          ))}
        </select>
      </label>
      {value?.wasteType === "other" && (
        <label>
          What kind of waste
          <input value={value.wasteTypeNote ?? ""} maxLength={500} onChange={(e) => set({ wasteTypeNote: e.target.value })} />
        </label>
      )}
      {vehicles.length > 0 && (
        <label>
          Truck
          <select value={value?.vehicleId ?? ""} onChange={(e) => set({ vehicleId: e.target.value || null })} aria-label="Truck">
            <option value="">Not named</option>
            {vehicles
              .filter((v) => v.active || v.id === value?.vehicleId)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {problem && <p className="error small">{problem}</p>}
    </section>
  );
}

/** The pump-out as the server checks it: a positive volume, or nothing. */
export const sendablePumpOut = (p: PumpOutInput | null | undefined) => (p && p.volume > 0 ? p : null);

/** Recording a disposal: which of the technician's pump-outs went in the load, where, and the manifest. */
export function DisposalScreen({ store, field, onDone }: { store: WorkStore; field: PumpingFieldData | undefined; onDone: () => void }) {
  const [loads, setLoads] = useState<LocalLoad[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [facilityId, setFacilityId] = useState("");
  // The truck the load is on; a load carries only pump-outs recorded on that truck.
  const [chosenTruck, setChosenTruck] = useState<string | null>(null);
  const [deliveredOn, setDeliveredOn] = useState(new Date().toLocaleDateString("en-CA"));
  const [manifest, setManifest] = useState("");
  const [total, setTotal] = useState("");
  const [unit, setUnit] = useState<VolumeUnit>("gallons");
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<{ blob: Blob; contentType: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // No room for a manifest photo until waiting items are sent; a load already saved is kept.
  const storageFull = useStorageFull();
  useEffect(() => {
    if (!storageFull) setProblem((p) => (p === STORAGE_FULL_MESSAGE ? null : p));
  }, [storageFull]);

  useEffect(() => {
    void store.allLoads().then(setLoads);
  }, [store]);

  if (!field) return <p className="muted">Trucks and facilities are not on this phone yet. Open the app once with signal.</p>;
  // Pump-outs already in a load saved on this phone are not offered again.
  const onPhone = new Set(loads.flatMap((l) => l.pumpingGroupIds));
  const waiting = field.unloaded.filter((p) => !onPhone.has(p.groupId));
  const vehicleId = chosenTruck ?? waiting[0]?.vehicleId ?? "";
  const unloaded = waiting.filter((p) => (p.vehicleId ?? "") === vehicleId);
  const trucks = [...new Set(waiting.map((p) => p.vehicleId ?? ""))];
  const truckName = (id: string) => (id ? (field.vehicles.find((v) => v.id === id)?.name ?? "Truck") : "No truck named");
  const picks = unloaded.filter((p) => picked.has(p.groupId));
  const pickedVolume = picks.reduce((sum, p) => sum + p.volumeMilligallons, 0);

  async function addPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setPhoto(await preparePhoto(file));
    } catch (err) {
      setProblem((err as Error).message);
    }
  }

  async function save() {
    const amount = Math.round(Number(total) * 10) / 10;
    const facility = field!.facilities.find((f) => f.id === facilityId);
    if (picks.length === 0) return setProblem("Tick the pump-outs in this load");
    if (!facility) return setProblem("Pick the facility");
    if (!Number.isFinite(amount) || amount <= 0) return setProblem("Enter the total delivered");
    setBusy(true);
    setProblem(null);
    const photoClientId = crypto.randomUUID();
    const capturedAt = new Date().toISOString();
    const load: LocalLoad = {
      clientId: crypto.randomUUID(),
      vehicleId: vehicleId || null,
      facilityId,
      facilityName: facility.name,
      deliveredOn,
      manifestReference: manifest.trim() || null,
      total: amount,
      unit,
      notes: notes.trim() || null,
      pumpingGroupIds: picks.map((p) => p.groupId),
      createdAt: capturedAt,
      photos: photo ? [{ clientId: photoClientId, capturedAt, uploaded: false }] : [],
      groupId: null,
    };
    try {
      // A load that does not fit is not saved at all; what was typed stays on screen to save again.
      await saveOrReport(() => store.saveLoad(load, photo ? { photo: { clientId: photoClientId, recordClientId: load.clientId, blob: photo.blob, contentType: photo.contentType } satisfies WorkBlob } : {}));
      onDone();
    } catch (err) {
      setProblem((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="stack" data-testid="record-disposal">
      <h1>Record disposal</h1>
      <p className="muted small">Your pump-outs show here once their visit has reached the office.</p>
      {trucks.length > 1 && (
        <label>
          Truck
          <select
            value={vehicleId}
            onChange={(e) => {
              setChosenTruck(e.target.value);
              setPicked(new Set());
            }}
            aria-label="Truck"
          >
            {trucks.map((t) => (
              <option key={t} value={t}>
                {truckName(t)}
              </option>
            ))}
          </select>
        </label>
      )}
      {trucks.length === 1 && <p className="muted small">On {truckName(vehicleId)}.</p>}
      {unloaded.length === 0 ? (
        <p className="muted">No pump-outs waiting for a disposal record.</p>
      ) : (
        <section className="card stack">
          <h2>Pump-outs in this load</h2>
          {unloaded.map((p) => (
            <label key={p.groupId} className="row">
              <input
                type="checkbox"
                checked={picked.has(p.groupId)}
                onChange={() => {
                  const next = new Set(picked);
                  if (next.has(p.groupId)) next.delete(p.groupId);
                  else next.add(p.groupId);
                  setPicked(next);
                }}
              />
              <span>
                {p.siteAddress} · {formatEntered(p.enteredVolume, p.enteredUnit)}
                <span className="muted small"> · {p.serviceDate}</span>
              </span>
            </label>
          ))}
          {picks.length > 0 && <p className="muted small">{formatGallons(pickedVolume)} recorded on the ticked pump-outs.</p>}
        </section>
      )}
      {unloaded.length > 0 && (
        <section className="card stack">
          <label>
            Facility
            <select value={facilityId} onChange={(e) => setFacilityId(e.target.value)}>
              <option value="">Pick a facility</option>
              {field.facilities
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
            <input type="date" value={deliveredOn} onChange={(e) => setDeliveredOn(e.target.value)} />
          </label>
          <div className="row">
            <label>
              Total delivered
              <input type="number" inputMode="decimal" min="0.1" step="0.1" value={total} onChange={(e) => setTotal(e.target.value)} aria-label="Total delivered" />
            </label>
            <label>
              Unit
              <select value={unit} onChange={(e) => setUnit(e.target.value as VolumeUnit)} aria-label="Total unit">
                {VOLUME_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Manifest/reference number
            <input value={manifest} maxLength={200} onChange={(e) => setManifest(e.target.value)} />
          </label>
          <label>
            Notes
            <input value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <label className={`button secondary photo-button${storageFull ? " disabled" : ""}`} aria-disabled={storageFull}>
            {photo ? "Retake manifest photo" : "Add manifest photo"}
            <input type="file" accept="image/*" capture="environment" hidden disabled={storageFull} onChange={(e) => void addPhoto(e)} aria-label="Add manifest photo" />
          </label>
          {photo && (
            <p className="muted small">
              Manifest photo added.
              {storageFull && (
                <>
                  {" "}
                  <button type="button" className="link" onClick={() => setPhoto(null)}>
                    Save without it
                  </button>
                </>
              )}
            </p>
          )}
          {storageFull && (
            <p className="error" role="alert" data-testid="storage-full">
              {STORAGE_FULL_MESSAGE}
            </p>
          )}
          {problem && problem !== STORAGE_FULL_MESSAGE && <p className="error">{problem}</p>}
          <button className="big" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save disposal record"}
          </button>
        </section>
      )}
      {loads.length > 0 && (
        <section className="stack">
          <h2>Recorded on this phone</h2>
          {loads.map((l) => (
            <p key={l.clientId} className="card tight small">
              {l.deliveredOn} · {l.facilityName} · {formatEntered(l.total, l.unit)} · {l.pumpingGroupIds.length} pump-out{l.pumpingGroupIds.length === 1 ? "" : "s"}
              {l.groupId && l.photos.every((p) => p.uploaded) ? " · with the office" : " · not sent yet"}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
