"use client";

import { FACILITY_KIND_LABELS, FACILITY_KINDS, roleHasPermission, type DisposalFacility, type PumpingSettings, type Vehicle } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { canEdit, useSession } from "@/lib/session";

/** SW-6: the company's pump trucks and the disposal facilities it delivers to, entered by hand. */
export default function TrucksPage() {
  const me = useSession();
  const on = useFeature("pumping");
  const editable = canEdit(me) && roleHasPermission(me.role, "work:write");
  const vehicles = useLoad<{ items: Vehicle[] }>("/vehicles");
  const facilities = useLoad<{ items: DisposalFacility[] }>("/disposal-facilities");
  const grace = useLoad<PumpingSettings>("/pumping/settings");
  // Only the owner sets the company's grace days, as with the other company settings.
  const owner = canEdit(me) && roleHasPermission(me.role, "org:manage");
  const [problem, setProblem] = useState<string | null>(null);

  async function save(path: string, method: "POST" | "PATCH", body: object) {
    setProblem(null);
    try {
      await api(path, { method, body });
      await Promise.all([vehicles.reload(), facilities.reload(), grace.reload()]);
      return true;
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save");
      return false;
    }
  }

  async function addTruck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const v = formValues(form);
    const ok = await save("/vehicles", "POST", {
      name: v.name,
      plate: v.plate ?? null,
      capacityGallons: v.capacity ? Number(v.capacity) : null,
      registrationReference: v.registration ?? null,
    });
    if (ok) form.reset();
  }

  async function addFacility(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const v = formValues(form);
    const ok = await save("/disposal-facilities", "POST", {
      name: v.name,
      kind: v.kind ?? "other",
      addressLine1: v.addressLine1 ?? null,
      city: v.city ?? null,
      state: v.state ?? null,
      postalCode: v.postalCode ?? null,
      permitOrRegistrationNumber: v.permit ?? null,
      notes: v.notes ?? null,
    });
    if (ok) form.reset();
  }

  async function setGrace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    await save("/pumping/settings", "PATCH", { disposalOverdueDays: Number(v.days) });
  }

  const error = vehicles.error ?? facilities.error;
  if (error) return <p className="error">{error}</p>;
  return (
    <div className="stack">
      <h1>Trucks and facilities</h1>
      {problem && <p className="error">{problem}</p>}
      {!on && <p className="muted small">Pumping is not switched on for this deployment; existing trucks and facilities stay readable.</p>}

      {grace.data && (
        <section className="stack" data-testid="disposal-grace">
          <h2>Disposal reminder</h2>
          {owner && on ? (
            <form className="row" onSubmit={(e) => void setGrace(e)} key={grace.data.disposalOverdueDays}>
              <label>
                Days after a pump-out before the inbox shows &quot;Disposal not recorded&quot;
                <input name="days" type="number" min={1} max={60} step={1} required defaultValue={grace.data.disposalOverdueDays} />
              </label>
              <button type="submit" className="secondary">
                Save
              </button>
            </form>
          ) : (
            <p className="muted">
              The inbox shows &quot;Disposal not recorded&quot; {grace.data.disposalOverdueDays} day{grace.data.disposalOverdueDays === 1 ? "" : "s"} after a pump-out with no disposal
              record.
            </p>
          )}
        </section>
      )}

      <section className="stack">
        <h2>Trucks</h2>
        {!vehicles.data ? (
          <p className="muted">Loading…</p>
        ) : vehicles.data.items.length === 0 ? (
          <p className="muted">No trucks yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="compact" data-testid="vehicles">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Plate</th>
                  <th>Capacity</th>
                  <th>Registration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {vehicles.data.items.map((t) => (
                  <tr key={t.id} className={t.active ? undefined : "muted"}>
                    <td>
                      {t.name}
                      {!t.active && <span className="badge cancelled">off</span>}
                    </td>
                    <td>{t.plate ?? ""}</td>
                    <td>{t.capacityGallons ? `${t.capacityGallons.toLocaleString("en-US")} gal` : ""}</td>
                    <td>{t.registrationReference ?? ""}</td>
                    <td>
                      {editable && (
                        <button type="button" className="link" onClick={() => void save(`/vehicles/${t.id}`, "PATCH", { active: !t.active })}>
                          {t.active ? "Switch off" : "Switch on"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editable && on && (
          <form className="card stack" onSubmit={addTruck}>
            <h3>Add a truck</h3>
            <div className="grid">
              <label>
                Name
                <input name="name" required maxLength={100} />
              </label>
              <label>
                Plate
                <input name="plate" maxLength={30} />
              </label>
              <label>
                Capacity (gallons)
                <input name="capacity" type="number" min={1} max={100000} step={1} />
              </label>
              <label>
                Registration or permit reference
                <input name="registration" maxLength={200} />
              </label>
            </div>
            <div className="row">
              <button type="submit">Add truck</button>
            </div>
          </form>
        )}
      </section>

      <section className="stack">
        <h2>Disposal facilities</h2>
        <p className="muted small">Entered by the company. Aerowise ships no facility list and does not check a facility&apos;s permits.</p>
        {!facilities.data ? (
          <p className="muted">Loading…</p>
        ) : facilities.data.items.length === 0 ? (
          <p className="muted">No facilities yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="compact" data-testid="facilities">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Address</th>
                  <th>Permit or registration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {facilities.data.items.map((f) => (
                  <tr key={f.id} className={f.active ? undefined : "muted"}>
                    <td>
                      {f.name}
                      {!f.active && <span className="badge cancelled">off</span>}
                    </td>
                    <td>{FACILITY_KIND_LABELS[f.kind]}</td>
                    <td>{[f.addressLine1, f.city, f.state, f.postalCode].filter(Boolean).join(", ")}</td>
                    <td>{f.permitOrRegistrationNumber ?? ""}</td>
                    <td>
                      {editable && (
                        <button type="button" className="link" onClick={() => void save(`/disposal-facilities/${f.id}`, "PATCH", { active: !f.active })}>
                          {f.active ? "Switch off" : "Switch on"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editable && on && (
          <form className="card stack" onSubmit={addFacility}>
            <h3>Add a facility</h3>
            <div className="grid">
              <label>
                Name
                <input name="name" required maxLength={200} />
              </label>
              <label>
                Kind
                <select name="kind" defaultValue="wastewater_treatment_plant">
                  {FACILITY_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {FACILITY_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Street
                <input name="addressLine1" maxLength={200} />
              </label>
              <label>
                City
                <input name="city" maxLength={100} />
              </label>
              <label>
                State
                <input name="state" maxLength={50} />
              </label>
              <label>
                ZIP
                <input name="postalCode" maxLength={20} />
              </label>
              <label>
                Permit or registration number
                <input name="permit" maxLength={200} />
              </label>
            </div>
            <label>
              Notes
              <input name="notes" maxLength={2000} />
            </label>
            <div className="row">
              <button type="submit">Add facility</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
