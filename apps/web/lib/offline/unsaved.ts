"use client";

import type { InspectionValues, PumpOutInput } from "@aerowise/domain";
import { storeFor, unsavedPrefixFor, type KnownTenant, type LocalInspection, type Tenant } from "./db";
import { isQuotaError } from "./storage";
import { workStoreFor } from "./work";

// The last edits an open form had not yet saved on the phone when the page was put away.
//
// A form saves to IndexedDB, which is asynchronous: a save started as the page goes (Back,
// reload, pull-to-refresh, the phone killing a background tab) may never finish. So when the
// page is hidden, the form also writes its latest answers to localStorage, which is written at
// once, and the next start of the app puts them back into the phone's copy before anything reads
// it. Only answers are kept here, never photos or the customer's details.

export type UnsavedEdit =
  | { kind: "inspection"; jobId: string; clientId: string; values: InspectionValues; issues: LocalInspection["issues"]; accessIssue: string | null }
  | { kind: "work"; jobId: string; clientId: string; values: InspectionValues; finalVisit: boolean; pumpOut?: PumpOutInput | null };

/** `form` and `version` say which open form wrote it and after how many edits, so its own later save can clear it. */
type Mirror = UnsavedEdit & { form: string; version: number };

const keyOf = (t: Tenant, kind: UnsavedEdit["kind"], clientId: string) => `${unsavedPrefixFor(t)}${kind}:${clientId}`;

/** Writes the form's latest answers, synchronously. Private mode or a full disk: nothing more can be done. */
export function mirrorUnsaved(t: Tenant, edit: UnsavedEdit, form: string, version: number) {
  try {
    localStorage.setItem(keyOf(t, edit.kind, edit.clientId), JSON.stringify({ ...edit, form, version } satisfies Mirror));
  } catch {
    // The IndexedDB save that was started may still finish.
  }
}

/**
 * The form has saved its edits up to `version` on the phone: its copy here is no longer needed. A
 * copy another form wrote is older than this save (that form was closed before this one opened),
 * so it goes too, rather than being put back over these answers at the next start.
 */
export function clearUnsaved(t: Tenant, kind: UnsavedEdit["kind"], clientId: string, form: string, version: number) {
  try {
    const key = keyOf(t, kind, clientId);
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const m = JSON.parse(raw) as Mirror;
    if (m.form !== form || m.version <= version) localStorage.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

function mirrorsOf(t: Tenant): [string, Mirror][] {
  try {
    const prefix = unsavedPrefixFor(t);
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(prefix))
      .flatMap((k) => {
        try {
          return [[k, JSON.parse(localStorage.getItem(k) ?? "null") as Mirror] as [string, Mirror]];
        } catch {
          return [];
        }
      })
      .filter(([, m]) => m && (m.kind === "inspection" || m.kind === "work"));
  } catch {
    return [];
  }
}

/**
 * Puts a sign-in's unsaved answers back into its records on the phone (and queues them to send),
 * before the app or a sign-out reads them. A record that was finished or held since keeps what it
 * has. A copy that does not fit on a full phone stays here for the next start.
 */
export async function restoreUnsaved(t: KnownTenant) {
  for (const [key, m] of mirrorsOf(t)) {
    try {
      if (m.kind === "inspection") {
        const store = storeFor(t);
        const stored = await store.getInspection(m.jobId);
        if (stored && stored.clientId === m.clientId && stored.status === "draft" && !stored.held) await store.saveInspection({ ...stored, values: m.values, issues: m.issues, accessIssue: m.accessIssue });
      } else {
        const store = workStoreFor(t);
        const stored = (await store.allRecords()).find((r) => r.clientId === m.clientId);
        if (stored?.status === "draft" && !stored.held && !stored.resolved) await store.saveWork({ ...stored, values: m.values, finalVisit: m.finalVisit, ...(m.pumpOut !== undefined ? { pumpOut: m.pumpOut } : {}) });
      }
    } catch (err) {
      if (isQuotaError(err)) continue;
    }
    try {
      localStorage.removeItem(key);
    } catch {
      // Read only: it is tried again next time, which changes nothing already saved.
    }
  }
}

// Open forms register how to save what they have not saved yet, so a Sign out (or a locked screen)
// counts and keeps every answer on screen before it decides what stays on the phone.
const flushers = new Set<() => Promise<void>>();

export function onFlushUnsaved(flush: () => Promise<void>) {
  flushers.add(flush);
  return () => void flushers.delete(flush);
}

export async function flushUnsaved() {
  await Promise.all([...flushers].map((f) => f().catch(() => {})));
}
