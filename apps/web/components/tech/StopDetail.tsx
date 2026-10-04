import { formatPhone, type SmsQueueResult, type Stop } from "@aerowise/domain";
import { useState } from "react";
import { SafetyBadges } from "@/components/SafetyBadges";
import { api, ApiError } from "@/lib/api";
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
      {!finished && <OnTheWay stop={stop} />}
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

const OUTCOME_TEXT: Record<SmsQueueResult["outcome"], string> = {
  queued: "Customer texted that you are on the way",
  off: "Texting is turned off, so no text was sent",
  no_phone: "No text sent: the customer has no mobile number on file",
  no_consent: "No text sent: the customer has not agreed to texts",
  opted_out: "No text sent: the customer replied STOP",
};

/** Tells the customer the technician is heading over. Needs signal; one text per visit. */
function OnTheWay({ stop }: { stop: Stop }) {
  const [result, setResult] = useState<string | null>(stop.onTheWayAt ? `On the way since ${new Date(stop.onTheWayAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : null);
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    try {
      const r = await api<SmsQueueResult>(`/jobs/${stop.jobId}/on-the-way`, { method: "POST", body: {} });
      setResult(r.outcome === "queued" && r.to ? `${OUTCOME_TEXT.queued} (${formatPhone(r.to)}).` : `${OUTCOME_TEXT[r.outcome]}.`);
    } catch (err) {
      setResult(err instanceof ApiError ? err.message : "No signal. Try again when you have one.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <button className="secondary" onClick={() => void send()} disabled={busy}>
        On my way
      </button>
      {result && (
        <p className="muted small" role="status" data-testid="on-the-way">
          {result}
        </p>
      )}
    </div>
  );
}
