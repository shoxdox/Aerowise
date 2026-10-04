import type { Stop } from "@aerowise/domain";
import { SafetyBadges } from "@/components/SafetyBadges";
import type { LocalInspection } from "@/lib/offline/db";
import { day } from "@/lib/format";
import { stopStatus } from "./StopList";

export function StopDetail({ stop, inspection, canStart, onStart }: { stop: Stop; inspection: LocalInspection | undefined; canStart: boolean; onStart: () => void }) {
  const { site, customer, system } = stop;
  const address = [site.addressLine1, site.addressLine2, `${site.city}, ${site.state} ${site.postalCode ?? ""}`].filter(Boolean).join(", ");
  const mapsUrl = site.lat !== null && site.lng !== null ? `https://maps.google.com/?q=${site.lat},${site.lng}` : `https://maps.google.com/?q=${encodeURIComponent(address)}`;
  const status = stopStatus(stop, inspection);
  const finished = status.label.startsWith("Done");
  return (
    <div className="stack">
      <div>
        <h1>{customer.displayName}</h1>
        <p className="muted">{address}</p>
        <SafetyBadges flags={site.safetyFlags} />
      </div>
      <div className="row">
        <a className="button secondary" href={mapsUrl} target="_blank" rel="noreferrer">
          Directions
        </a>
        {customer.phone && (
          <a className="button secondary" href={`tel:${customer.phone}`}>
            Call {customer.phone}
          </a>
        )}
      </div>
      <dl className="details card">
        {site.gateCode && (
          <>
            <dt>Gate code</dt>
            <dd>
              <strong>{site.gateCode}</strong>
            </dd>
          </>
        )}
        {site.accessNotes && (
          <>
            <dt>Access</dt>
            <dd>{site.accessNotes}</dd>
          </>
        )}
        {site.schedulingNotes && (
          <>
            <dt>Scheduling</dt>
            <dd>{site.schedulingNotes}</dd>
          </>
        )}
        {system && (
          <>
            <dt>System</dt>
            <dd>{[system.manufacturer, system.model, system.disposalType, system.chlorinationMethod].filter(Boolean).join(" · ") || "Unknown"}</dd>
          </>
        )}
        {site.permitNumber && (
          <>
            <dt>Permit</dt>
            <dd>{site.permitNumber}</dd>
          </>
        )}
        {stop.obligation && (
          <>
            <dt>Due</dt>
            <dd>{day(stop.obligation.dueOn)}</dd>
          </>
        )}
        {stop.notes && (
          <>
            <dt>Office notes</dt>
            <dd>{stop.notes}</dd>
          </>
        )}
      </dl>
      {finished ? (
        <p className={`badge ${status.tone}`}>{status.label}</p>
      ) : (
        <button className="big" onClick={onStart} disabled={!canStart}>
          {inspection ? "Continue inspection" : "Arrive and start inspection"}
        </button>
      )}
      {!canStart && <p className="muted small">The inspection form has not been downloaded yet. Open the app once with signal.</p>}
    </div>
  );
}
