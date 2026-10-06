export const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Formats a YYYY-MM-DD calendar date without letting the browser's timezone shift it. */
export function day(date: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

/**
 * The company's time zone. Due dates and "today" are worked out in it on the server, so moments are
 * shown in it too, whatever zone the device is set to. Set once the session loads; Texas until then.
 */
let zone = "America/Chicago";
export function setDisplayTimeZone(timeZone: string) {
  zone = timeZone;
}

/** A moment in time, in the company's time zone. */
export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: zone }) : "—";

/** The calendar day of a moment, in the company's time zone, as "Oct 6, 2026". */
export const dayOf = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: zone }) : "—";

/** The clock time of a moment, in the company's time zone, as "1:02 PM". */
export const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });

/** Today's date in the company's time zone, as YYYY-MM-DD (not the UTC date, which is tomorrow from 7 PM in Texas). */
export const today = (now: Date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/** A length of time in minutes, as "25 min" or "3h 05m". */
export function duration(minutes: number) {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
