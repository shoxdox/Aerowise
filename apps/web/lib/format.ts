import { formatDate, invoiceNumberLabel } from "@aerowise/domain";

// Every date, count and number the office screens show goes through here, so the same thing
// reads the same way on every screen (and dates follow the company's clock, not the device's).

export const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Formats a YYYY-MM-DD calendar date without letting the browser's timezone shift it. */
export function day(date: string, opts?: Intl.DateTimeFormatOptions) {
  if (!opts) return formatDate(date);
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

/** "Jun 12, 2026 to Jun 11, 2027" for a pair of calendar dates. */
export const dateRange = (from: string, to: string) => `${day(from)} to ${day(to)}`;

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

/** "1 stop", "3 stops", "2 inspections, 1 work visit": the count and the word that agrees with it. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A number with no trailing ".0": "1,050" or "1,050.5". */
export const quantity = (n: number, maxDecimals = 3) => n.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });

/** A volume as recorded, in whole units when it is whole: "1,050 gallons", "500.5 liters". */
export const volume = (amount: number, unit: string) => `${quantity(amount, 1)} ${unit}`;

/** Thousandths of a gallon as "1,050 gallons" (or "1,050.5 gallons"). */
export const gallons = (milligallons: number) => volume(Math.round(milligallons / 100) / 10, "gallons");

/** A phone number as "(512) 555-0199", however it was typed or stored; anything else as it is. */
export function phone(raw: string | null | undefined): string {
  if (!raw) return "—";
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : raw;
}

/** An invoice's name everywhere: "INV-1003", or "Draft" before it is issued. */
export const invoiceLabel = (number: number | null) => invoiceNumberLabel(number);

/** A license or MP number with one "MP" in front, however it was entered ("MP0099123" stays as it is). */
export const mpNumber = (number: string) => (/^mp[\s-]?/i.test(number.trim()) ? number.trim() : `MP ${number.trim()}`);
