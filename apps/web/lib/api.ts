"use client";

/** One field the API refused, as `/options/1/name` and the validator's own words. */
export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The fields a 400 named; empty for every other refusal. */
    readonly issues: ApiIssue[] = [],
  ) {
    super(message);
  }
}

/** Calls the API through the same-origin /api proxy. Sends to the matching sign-in page on 401. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
    signal: init.signal,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Sign-in forms and invitation links show a wrong password themselves.
    const showsOwn401 = path.endsWith("/auth/login") || path.startsWith("/invitations/accept/") || path.startsWith("/auth/password-reset");
    if (res.status === 401 && !showsOwn401 && typeof window !== "undefined") {
      // The platform-admin console has its own sign-in, separate from the office one.
      const login = path.startsWith("/admin/") ? "/admin/login" : "/login";
      window.location.href = `${login}?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    }
    const issues = Array.isArray(data.issues) ? (data.issues as unknown[]).filter((i): i is ApiIssue => typeof (i as ApiIssue)?.path === "string" && typeof (i as ApiIssue)?.message === "string") : [];
    throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText, issues);
  }
  return data as T;
}

/** A problem a form found before sending anything, already in words for the person ("Every line needs a description."). */
export class Refusal extends Error {}

/** Collects non-empty form fields; empty strings become undefined so optional fields stay unset. */
export function formValues(form: HTMLFormElement): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of new FormData(form).entries()) {
    const text = String(value).trim();
    out[key] = text === "" ? undefined : text;
  }
  return out;
}

/** Whether the request may have gone through: no answer, or the server failed partway. */
export const mayHaveSaved = (err: unknown) => !(err instanceof ApiError) || err.status >= 500;

/**
 * `/options/1/name` as "Option 2: Name". Labels name a field by its last key ("name") or full
 * path. A list item is named by its place; a plain nested object ("/customer/…") is left out,
 * since the form shows its fields as one.
 */
export function fieldName(path: string, labels: Record<string, string> = {}): string {
  const parts = path.split("/").filter(Boolean);
  if (labels[path]) return labels[path];
  const named = parts.map((p, i) => {
    if (/^\d+$/.test(p)) return null;
    const next = parts[i + 1];
    const word = labels[p] ?? words(p);
    // A list item is named by its place: "lines/2" is the third line.
    if (next !== undefined && /^\d+$/.test(next)) return `${singular(word)} ${Number(next) + 1}`;
    return next === undefined ? word : null;
  });
  return named.filter(Boolean).join(": ");
}

const words = (key: string) => {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return spaced[0]?.toUpperCase() + spaced.slice(1);
};
const singular = (word: string) => (/ies$/.test(word) ? word.replace(/ies$/, "y") : word.replace(/s$/, ""));

/** The validator's wording as an instruction ("Too small: expected string to have >=1 characters" → "is required"), or null when it is already the API's own sentence. */
function plainIssue(message: string): string | null {
  let m: RegExpMatchArray | null;
  if (/expected string to have >=1 characters?/.test(message) || /received undefined/.test(message) || message === "Required") return "is required";
  if ((m = message.match(/expected string to have >=(\d+) characters?/))) return `needs at least ${m[1]} characters`;
  if ((m = message.match(/expected string to have <=(\d+) characters?/))) return `can be at most ${m[1]} characters`;
  if ((m = message.match(/expected (?:number|int) to be >=?(-?[\d.]+)/))) return `must be at least ${m[1]}`;
  if ((m = message.match(/expected (?:number|int) to be <=?(-?[\d.]+)/))) return `must be at most ${m[1]}`;
  if ((m = message.match(/expected array to have <=(\d+) items?/))) return `can have at most ${m[1]}`;
  if ((m = message.match(/expected array to have >=(\d+) items?/))) return `needs at least ${m[1]}`;
  if (/Invalid email/i.test(message)) return "needs a valid email address";
  if (/Invalid (ISO )?date/i.test(message)) return "needs a date";
  if (/Invalid UUID/i.test(message)) return "needs a choice";
  return null;
}

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

/** Each refused field as "Option 2: Name is required." or "ZIP: Expected a ZIP code." */
export function issueMessages(issues: ApiIssue[], labels: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const name = fieldName(i.path, labels);
    const plain = plainIssue(i.message);
    // The API's own words ("Expected a ZIP code") follow the field's name as they are.
    out[i.path] ??= !name ? sentence(plain ?? i.message) : plain ? `${name} ${plain}.` : `${name}: ${sentence(i.message)}`;
  }
  return out;
}

/**
 * What to tell the person when a request fails: the fields a validation error named, the
 * API's own message, or the fallback when the server could not be reached at all.
 */
export function messageFor(err: unknown, fallback = "Could not save. Check your connection and try again.", labels: Record<string, string> = {}): string {
  if (err instanceof Refusal) return err.message;
  if (err instanceof DOMException && err.name === "AbortError") return "This took too long. Check your connection and try again.";
  if (!(err instanceof ApiError)) return fallback;
  // Two fields refused for the same reason (a customer's ZIP and its site's) read once.
  if (err.issues.length) return [...new Set(Object.values(issueMessages(err.issues, labels)))].join(" ");
  if (err.status >= 500) return "Something went wrong on our side. Try again in a moment.";
  return err.message;
}
