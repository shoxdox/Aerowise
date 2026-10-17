"use client";

import { FACILITY_KIND_LABELS, FACILITY_KINDS, roleHasPermission, type DisposalFacility, type PumpingSettings, type Vehicle } from "@aerowise/domain";
import { type FormEvent } from "react";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, formValues } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { plural, quantity } from "@/lib/format";
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
  const saving = useSubmit(
    async (path: string, method: "POST" | "PATCH", body: object) => {
      await api(path, { method, body });
      await Promise.all([vehicles.reload(), facilities.reload(), grace.reload()]);
      return true;
    },
    { fallback: "Could not save." },
  );
  const save = async (path: string, method: "POST" | "PATCH", body: object) => (await saving.run(path, method, body)) === true;
  const problem = saving.error;

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

  return (
    <div className="stack">
      <h1>Trucks and facilities</h1>
      <FormError error={problem} />
      {!on && <p className="muted small">Pumping is not switched on for this deployment; existing trucks and facilities stay readable.</p>}

      {grace.data && (
        <section className="stack" data-testid="disposal-grace">
          <h2>Disposal reminder</h2>
          {owner && on ? (
            <form className="row" onSubmit={(e) => void setGrace(e)} key={grace.data.disposalOverdueDays}>
              <label>
                Show &quot;Disposal not recorded&quot; once a pump-out is more than this many days old without a disposal record
                <input name="days" type="number" min={1} max={60} step={1} required defaultValue={grace.data.disposalOverdueDays} />
              </label>
              <SubmitButton className="secondary" busy={saving.busy}>
                Save
              </SubmitButton>
            </form>
          ) : (
            <p className="muted">
              The inbox shows &quot;Disposal not recorded&quot; once a pump-out is more than {plural(grace.data.disposalOverdueDays, "day")} old
              without a disposal record.
            </p>
          )}
        </section>
      )}

      <section className="stack">
        <h2>Trucks</h2>
        {!vehicles.data ? (
          <LoadState load={vehicles} label="trucks" />
        ) : vehicles.data.items.length === 0 ? (
          <p className="muted">No trucks yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="compact stack" data-testid="vehicles">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Plate</th>
                  <th className="num">Capacity</th>
                  <th>Registration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {vehicles.data.items.map((t) => (
                  <tr key={t.id} className={t.active ? undefined : "muted"}>
                    <td data-label="Name">
                      {t.name} {!t.active && <Badge tone="struck">Off</Badge>}
                    </td>
                    <td data-label="Plate">{t.plate ?? ""}</td>
                    <td data-label="Capacity" className="num">
                      {t.capacityGallons ? `${quantity(t.capacityGallons)} gal` : ""}
                    </td>
                    <td data-label="Registration">{t.registrationReference ?? ""}</td>
                    <td className={editable ? "actions" : undefined}>
                      {editable && (
                        <button type="button" className={t.active ? "link danger" : "link"} disabled={saving.busy} onClick={() => void save(`/vehicles/${t.id}`, "PATCH", { active: !t.active })}>
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
              <SubmitButton busy={saving.busy}>Add truck</SubmitButton>
            </div>
          </form>
        )}
      </section>

      <section className="stack">
        <h2>Disposal facilities</h2>
        <p className="muted small">Entered by the company. Aerowise ships no facility list and does not check a facility&apos;s permits.</p>
        {!facilities.data ? (
          <LoadState load={facilities} label="facilities" />
        ) : facilities.data.items.length === 0 ? (
          <p className="muted">No facilities yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="compact stack" data-testid="facilities">
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
                    <td data-label="Name">
                      {f.name} {!f.active && <Badge tone="struck">Off</Badge>}
                    </td>
                    <td data-label="Kind">{FACILITY_KIND_LABELS[f.kind]}</td>
                    <td data-label="Address">{[f.addressLine1, f.city, f.state, f.postalCode].filter(Boolean).join(", ")}</td>
                    <td data-label="Permit or registration">{f.permitOrRegistrationNumber ?? ""}</td>
                    <td className={editable ? "actions" : undefined}>
                      {editable && (
                        <button type="button" className={f.active ? "link danger" : "link"} disabled={saving.busy} onClick={() => void save(`/disposal-facilities/${f.id}`, "PATCH", { active: !f.active })}>
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
              <SubmitButton busy={saving.busy}>Add facility</SubmitButton>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
