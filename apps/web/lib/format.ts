export const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Formats a YYYY-MM-DD calendar date without letting the browser's timezone shift it. */
export function day(date: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

/** A moment in time, in the browser's timezone. */
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");

/** A length of time in minutes, as "25 min" or "3h 05m". */
export function duration(minutes: number) {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
