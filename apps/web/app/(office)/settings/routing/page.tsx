"use client";

import type { RoutingSettings } from "@aerowise/domain";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { useSession } from "@/lib/session";

export default function RoutingSettingsPage() {
  const { role } = useSession();
  const owner = role === "owner";
  const canSchedule = role === "owner" || role === "office";
  const { data, error, reload } = useLoad<RoutingSettings>("/routing/settings");
  const [message, setMessage] = useState<string | null>(null);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  async function send(action: () => Promise<unknown>, done: string) {
    setMessage(null);
    try {
      await action();
      await reload();
      setMessage(done);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  function saveStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    const coords = v.lat && v.lng ? { lat: Number(v.lat), lng: Number(v.lng) } : {};
    void send(
      () => api("/routing/settings", { method: "PATCH", body: { start: { addressLine1: v.addressLine1, city: v.city, state: v.state ?? "TX", postalCode: v.postalCode ?? null, ...coords } } }),
      "Start saved",
    );
  }

  function saveDay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    void send(
      () =>
        api("/routing/settings", {
          method: "PATCH",
          body: {
            returnToStart: v.returnToStart === "on",
            stopMinutes: Number(v.stopMinutes),
            dayMinutes: Math.round(Number(v.dayHours) * 60),
            speedMph: Number(v.speedMph),
          },
        }),
      "Saved",
    );
  }

  const s = data.sites;
  return (
    <div className="stack">
      <p>
        <Link href="/schedule">← Schedule</Link>
      </p>
      <h1>Route settings</h1>
      {message && <p className="muted">{message}</p>}

      <section className="card stack">
        <h2>Where the day starts</h2>
        <p className="muted small">Technicians leave from here in the morning: the yard or the office. Without it, a route starts at its first stop.</p>
        {data.start ? (
          <p>
            <strong>{data.start.address}</strong>{" "}
            <span className="muted small">
              ({data.start.lat.toFixed(5)}, {data.start.lng.toFixed(5)})
            </span>
          </p>
        ) : (
          <p className="muted">Not set.</p>
        )}
        {owner && (
          <form className="stack" onSubmit={saveStart}>
            <div className="row">
              <label>
                Street
                <input name="addressLine1" required />
              </label>
              <label>
                City
                <input name="city" required />
              </label>
              <label>
                State
                <input name="state" defaultValue="TX" maxLength={2} size={3} />
              </label>
              <label>
                ZIP
                <input name="postalCode" size={6} />
              </label>
            </div>
            <details>
              <summary className="small">Enter coordinates instead of looking the address up</summary>
              <div className="row">
                <label>
                  Latitude
                  <input name="lat" inputMode="decimal" />
                </label>
                <label>
                  Longitude
                  <input name="lng" inputMode="decimal" />
                </label>
              </div>
            </details>
            <div className="row">
              <button type="submit">Save start</button>
              {data.start && (
                <button type="button" className="secondary" onClick={() => void send(() => api("/routing/settings", { method: "PATCH", body: { start: null } }), "Start removed")}>
                  Remove start
                </button>
              )}
            </div>
          </form>
        )}
      </section>

      <section className="card stack">
        <h2>Travel estimates</h2>
        <p className="muted small">
          Driving is estimated from straight-line distance, stretched 30% for roads, at your average speed. A day is flagged when driving plus time on site runs past a working day.
        </p>
        <form className="stack" onSubmit={saveDay}>
          <div className="row">
            <label>
              Minutes on site per stop
              <input name="stopMinutes" type="number" min={0} max={480} defaultValue={data.stopMinutes} disabled={!owner} />
            </label>
            <label>
              Working day (hours)
              <input name="dayHours" type="number" min={1} max={24} step={0.5} defaultValue={data.dayMinutes / 60} disabled={!owner} />
            </label>
            <label>
              Average speed (mph)
              <input name="speedMph" type="number" min={5} max={80} defaultValue={data.speedMph} disabled={!owner} />
            </label>
          </div>
          <label className="check">
            <input name="returnToStart" type="checkbox" defaultChecked={data.returnToStart} disabled={!owner} />
            Routes end back at the start
          </label>
          {owner && (
            <div>
              <button type="submit">Save</button>
            </div>
          )}
        </form>
      </section>

      <section className="card stack">
        <h2>Sites on the map</h2>
        {data.geocoder === "test" && <p className="restriction small">This server uses the built-in test geocoder: sites get made-up locations near central Texas.</p>}
        {data.geocoder === "off" && <p className="muted small">Finding addresses is turned off on this server. Enter coordinates on each site.</p>}
        <div className="tiles">
          <div className="card tight">
            <strong>{s.located}</strong>
            <div className="muted small">on the map</div>
          </div>
          <div className="card tight">
            <strong>{s.pending}</strong>
            <div className="muted small">being looked up</div>
          </div>
          <div className="card tight">
            <strong>{s.notFound}</strong>
            <div className="muted small">address not found</div>
          </div>
        </div>
        {s.notFound > 0 && <p className="small muted">Fix the address on the site, or enter its latitude and longitude there.</p>}
        {canSchedule && data.geocoder !== "off" && s.pending + s.notFound > 0 && (
          <div>
            <button className="secondary" onClick={() => void send(() => api("/routing/locate-sites", { method: "POST", body: { retryNotFound: true } }), "Looking up sites")}>
              Look up sites again
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
