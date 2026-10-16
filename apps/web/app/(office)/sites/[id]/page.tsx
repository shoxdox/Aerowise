"use client";

import { CHLORINATION_LABELS, DISPOSAL_TYPE_LABELS, humanize, SAFETY_FLAGS, SITE_USE_CATEGORIES, SITE_USE_CATEGORY_LABELS, SYSTEM_CATEGORIES, SYSTEM_CATEGORY_LABELS, type SiteDetail, type SystemCategory } from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { SAFETY_FLAG_LABELS, SafetyBadges } from "@/components/SafetyBadges";
import { ComplianceTimeline } from "@/components/ComplianceTimeline";
import { SiteOverview } from "@/components/SiteOverview";
import { SiteAuthority } from "@/components/SiteAuthority";
import { SiteContracts } from "@/components/SiteContracts";
import { PumpingHistory } from "@/components/PumpingHistory";
import { SiteLabTests } from "@/components/SiteLabTests";
import { SiteServiceRequests } from "@/components/SiteServiceRequests";
import { SiteWorkOrders } from "@/components/SiteWorkOrders";
import { SystemMonitoring } from "@/components/SystemMonitoring";
import { LoadState } from "@/components/LoadState";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, formValues } from "@/lib/api";
import { day, phone, plural } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";
import { usePageTitle } from "@/lib/title";

const FIELDS = { addressLine1: "Address", postalCode: "ZIP", permitIntervalMonths: "Inspection interval", permitIntervalNote: "Where it says so", lat: "Latitude", lng: "Longitude" };

export default function SitePage() {
  const { id } = useParams<{ id: string }>();
  const editable = canEdit(useSession());
  const recordLoad = useLoad<SiteDetail>(`/sites/${id}`);
  const { data: site, reload } = recordLoad;
  const [editing, setEditing] = useState<"site" | "system" | null>(null);
  usePageTitle(site ? `${site.addressLine1}, ${site.city}` : null);
  const saving = useSubmit(
    async (path: string, method: "POST" | "PATCH", body: object) => {
      await api(path, { method, body });
      setEditing(null);
      await reload();
    },
    { fallback: "Could not save.", labels: FIELDS },
  );
  const save = (path: string, method: "POST" | "PATCH", body: object) => saving.run(path, method, body);
  const formError = saving.error;

  if (!site) return <LoadState load={recordLoad} label="site" back={{ href: "/sites", label: "Sites" }} />;

  function onSaveSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    const flags = new FormData(event.currentTarget).getAll("safetyFlags").map(String);
    // Typed coordinates pin the site; clearing a pin hands it back to the address lookup.
    const pin = v.lat && v.lng ? { lat: Number(v.lat), lng: Number(v.lng) } : site!.locationSource === "manual" ? { lat: null, lng: null } : {};
    void save(`/sites/${id}`, "PATCH", {
      ...pin,
      addressLine1: v.addressLine1,
      city: v.city,
      postalCode: v.postalCode ?? null,
      county: v.county ?? null,
      permitNumber: v.permitNumber ?? null,
      permitIntervalMonths: v.permitIntervalMonths ? Number(v.permitIntervalMonths) : null,
      permitIntervalNote: v.permitIntervalNote ?? null,
      customerType: v.customerType,
      useCategory: v.useCategory || null,
      gateCode: v.gateCode ?? null,
      accessNotes: v.accessNotes ?? null,
      schedulingNotes: v.schedulingNotes ?? null,
      safetyFlags: flags,
    });
  }

  function onAddSystem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    void save(`/sites/${id}/systems`, "POST", {
      manufacturer: v.manufacturer,
      model: v.model,
      serial: v.serial,
      installedAt: v.installedAt,
      disposalType: v.disposalType,
      chlorinationMethod: v.chlorinationMethod,
      systemType: "aerobic",
      systemCategory: v.systemCategory || null,
    });
  }

  const mapsUrl =
    site.lat !== null && site.lng !== null
      ? `https://www.google.com/maps/search/?api=1&query=${site.lat},${site.lng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${site.addressLine1}, ${site.city}, ${site.state}`)}`;

  return (
    <div className="stack">
      <LoadState load={recordLoad} label="site" back={{ href: "/sites", label: "Sites" }} />
      <p>
        <Link href={`/customers/${site.customer.id}`}>← {site.customer.displayName}</Link>
      </p>
      <div className="row">
        <h1>
          {site.addressLine1}, {site.city}
        </h1>
        <SafetyBadges flags={site.safetyFlags} />
        <span className="spacer" />
        <a href={mapsUrl} target="_blank" rel="noreferrer">
          Map
        </a>
        {editable && (
          <button className="secondary" onClick={() => setEditing(editing === "site" ? null : "site")}>
            Edit
          </button>
        )}
      </div>

      <SiteOverview site={site} />

      {editing === "site" ? (
        <form className="card grid" onSubmit={onSaveSite}>
          <label className="wide">
            Address
            <input name="addressLine1" defaultValue={site.addressLine1} required />
          </label>
          <label>
            City
            <input name="city" defaultValue={site.city} required />
          </label>
          <label>
            ZIP
            <input name="postalCode" defaultValue={site.postalCode ?? ""} />
          </label>
          <label>
            County
            <input name="county" defaultValue={site.county ?? ""} />
          </label>
          <label>
            Permit number
            <input name="permitNumber" defaultValue={site.permitNumber ?? ""} />
          </label>
          <label>
            Inspection interval from the permit or contract (months)
            <input name="permitIntervalMonths" type="number" min={1} max={24} defaultValue={site.permitIntervalMonths ?? ""} placeholder="The authority's own" />
          </label>
          <label className="wide">
            Where it says so
            <input name="permitIntervalNote" defaultValue={site.permitIntervalNote ?? ""} placeholder="For example: permit 12-3456, page 2" />
            <span className="muted small">
              Used only where the authority lets the site&apos;s own permit or contract set the interval (Hays County; Montgomery County food establishments).
            </span>
          </label>
          <label>
            System use
            <select name="customerType" defaultValue={site.customerType}>
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
            </select>
          </label>
          <label>
            What the system serves
            <select name="useCategory" defaultValue={site.useCategory ?? ""}>
              <option value="">Not recorded</option>
              {SITE_USE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {SITE_USE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Gate code
            <input name="gateCode" defaultValue={site.gateCode ?? ""} />
          </label>
          <label>
            Latitude
            <input name="lat" inputMode="decimal" defaultValue={site.locationSource === "manual" ? String(site.lat) : ""} placeholder="Found from the address" />
          </label>
          <label>
            Longitude
            <input name="lng" inputMode="decimal" defaultValue={site.locationSource === "manual" ? String(site.lng) : ""} placeholder="Found from the address" />
          </label>
          <fieldset className="wide">
            <legend>Safety and access</legend>
            {SAFETY_FLAGS.map((f) => (
              <label key={f} className="check">
                <input type="checkbox" name="safetyFlags" value={f} defaultChecked={site.safetyFlags.includes(f)} />
                {SAFETY_FLAG_LABELS[f]}
              </label>
            ))}
          </fieldset>
          <label className="wide">
            Access notes
            <textarea name="accessNotes" defaultValue={site.accessNotes ?? ""} rows={2} />
          </label>
          <label className="wide">
            Scheduling requirements
            <textarea name="schedulingNotes" defaultValue={site.schedulingNotes ?? ""} rows={2} />
          </label>
          <FormError error={formError} className="wide" />
          <div className="wide">
            <SubmitButton busy={saving.busy}>Save</SubmitButton>
          </div>
        </form>
      ) : (
        <dl className="card details">
          <dt>Permit</dt>
          <dd>{site.permitNumber ?? "Not recorded"}</dd>
          {site.permitIntervalMonths !== null && (
            <>
              <dt>Recorded interval</dt>
              <dd>
                Every {plural(site.permitIntervalMonths, "month")} ({site.permitIntervalNote})
              </dd>
            </>
          )}
          <dt>County</dt>
          <dd>{site.county ?? "—"}</dd>
          <dt>System use</dt>
          <dd>
            {site.customerType === "commercial" ? "Commercial" : "Residential"}
            {site.useCategory && ` (${SITE_USE_CATEGORY_LABELS[site.useCategory]})`}
          </dd>
          <dt>Gate code</dt>
          <dd>{site.gateCode ?? "—"}</dd>
          <dt>Location</dt>
          <dd>
            {site.lat !== null
              ? site.locationSource === "manual"
                ? "Placed by hand"
                : "Found from the address"
              : site.geocodeStatus === "not_found"
                ? "Address not found on the map. Correct it, or enter latitude and longitude."
                : "Being looked up"}
          </dd>
          <dt>Access notes</dt>
          <dd>{site.accessNotes ?? "—"}</dd>
          <dt>Scheduling</dt>
          <dd>{site.schedulingNotes ?? "—"}</dd>
        </dl>
      )}

      <SiteAuthority siteId={site.id} county={site.county} editable={editable} />
      <SiteContracts siteId={site.id} editable={editable} />
      <SiteLabTests siteId={site.id} editable={editable} />
      <SiteServiceRequests siteId={site.id} editable={editable} />
      <SiteWorkOrders siteId={site.id} editable={editable} />
      <PumpingHistory siteId={site.id} />
      <ComplianceTimeline siteId={site.id} editable={editable} />

      <section className="stack">
        <div className="row">
          <h2>Wastewater systems</h2>
          <span className="spacer" />
          {editable && (
            <button className="secondary" onClick={() => setEditing(editing === "system" ? null : "system")}>
              Add system
            </button>
          )}
        </div>
        {editing === "system" && (
          <form className="card grid" onSubmit={onAddSystem}>
            <label>
              Kind of system
              <select name="systemCategory" defaultValue="aerobic">
                {SYSTEM_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {SYSTEM_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Manufacturer
              <input name="manufacturer" />
            </label>
            <label>
              Model
              <input name="model" />
            </label>
            <label>
              Serial
              <input name="serial" />
            </label>
            <label>
              Installed
              <input name="installedAt" type="date" />
            </label>
            <label>
              Disposal
              <select name="disposalType" defaultValue="">
                <option value="">—</option>
                <option value="spray">Spray</option>
                <option value="drip">Drip</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Chlorination
              <select name="chlorinationMethod" defaultValue="">
                <option value="">—</option>
                <option value="tablet">Tablet</option>
                <option value="liquid">Liquid</option>
                <option value="none">None</option>
              </select>
            </label>
            <FormError error={formError} className="wide" />
            <div className="wide">
              <SubmitButton busy={saving.busy}>Add system</SubmitButton>
            </div>
          </form>
        )}
        {editing === null && <FormError error={formError} />}
        {site.systems.length === 0 && <p className="muted">No systems recorded.</p>}
        {site.systems.map((s) => (
          <dl key={s.id} className="card details" data-testid="system">
            <dt>Kind of system</dt>
            <dd>
              {editable ? (
                <select
                  aria-label="Kind of system"
                  value={s.systemCategory ?? ""}
                  disabled={saving.busy}
                  onChange={(e) => void save(`/systems/${s.id}`, "PATCH", { systemCategory: (e.target.value || null) as SystemCategory | null })}
                >
                  <option value="">Not recorded</option>
                  {SYSTEM_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {SYSTEM_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              ) : s.systemCategory ? (
                SYSTEM_CATEGORY_LABELS[s.systemCategory]
              ) : (
                "Not recorded"
              )}
            </dd>
            <dt>Unit</dt>
            <dd>{[s.manufacturer, s.model].filter(Boolean).join(" ") || "Unknown"}</dd>
            <dt>Serial</dt>
            <dd>{s.serial ?? "—"}</dd>
            <dt>Installed</dt>
            <dd>{s.installedAt ? day(s.installedAt) : "—"}</dd>
            <dt>Disposal</dt>
            <dd>{s.disposalType ? (DISPOSAL_TYPE_LABELS[s.disposalType] ?? humanize(s.disposalType)) : "—"}</dd>
            <dt>Chlorination</dt>
            <dd>{s.chlorinationMethod ? (CHLORINATION_LABELS[s.chlorinationMethod] ?? humanize(s.chlorinationMethod)) : "—"}</dd>
          </dl>
        ))}
      </section>

      <details className="card"><summary>Electronic monitoring records</summary><SystemMonitoring siteId={site.id} systems={site.systems} editable={editable} /></details>

      <details className="card"><summary>Site contacts ({site.contacts.length})</summary><section className="stack">
        <h2>Contacts</h2>
        {site.contacts.map((c) => (
          <p key={c.id}>
            {c.name} {c.phone && <a href={`tel:${c.phone}`}>{phone(c.phone)}</a>}
          </p>
        ))}
      </section></details>
    </div>
  );
}
