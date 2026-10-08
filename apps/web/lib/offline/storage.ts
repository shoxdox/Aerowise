"use client";

import { useSyncExternalStore } from "react";

// Phone storage running out. A save that does not fit fails as a whole (one IndexedDB
// transaction), so everything saved before it, and everything queued to send, stays as it was.
// The phone then says so plainly and takes no new photos until sending has made room.

export const STORAGE_FULL_MESSAGE = "Phone storage full: send waiting items first.";

/** True for the browser's "no room left" error, however the save reported it. */
export function isQuotaError(err: unknown): boolean {
  // A transaction that runs out of room aborts with this as its error.
  return !!err && typeof err === "object" && (err as { name?: unknown }).name === "QuotaExceededError";
}

let full = false;
const listeners = new Set<() => void>();
const set = (next: boolean) => {
  if (full === next) return;
  full = next;
  for (const l of listeners) l();
};

/** A save did not fit. */
export const markStorageFull = () => set(true);
/** Something was sent (and its photo dropped from the phone), so there may be room again. */
export const storageMayHaveRoom = () => set(false);
export const isStorageFull = () => full;

export function useStorageFull(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => full,
    () => false,
  );
}

/**
 * Runs a save; a quota error marks storage full and is rethrown with the plain message, so the
 * caller can undo what it showed and say why.
 */
export async function saveOrReport<T>(save: () => Promise<T>): Promise<T> {
  try {
    return await save();
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    markStorageFull();
    throw new Error(STORAGE_FULL_MESSAGE, { cause: err });
  }
}

let asked = false;
/** Asks the browser to keep this app's data when the phone runs low, rather than clear it. */
export function requestPersistentStorage() {
  if (asked || typeof navigator === "undefined" || !navigator.storage?.persist) return;
  asked = true;
  void navigator.storage.persist().catch(() => {});
}
