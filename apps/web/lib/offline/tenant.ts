"use client";

import type { Me } from "../session";
import { accessEnded, fetchMe } from "./data";
import {
  activateTenant,
  activeStore,
  adoptLegacyStore,
  forgetTenant,
  keepOnlyQueued,
  knownTenants,
  lastActiveTenant,
  markSignedOut,
  pendingFor,
  rememberTenant,
  sameTenant,
  type KnownTenant,
} from "./db";
import { restoreUnsaved } from "./unsaved";
import { keepOnlyQueuedWork } from "./work";

// Which sign-in the technician app opens as, and when a sign-in's data leaves the phone.
//
// Queued work is removed from the phone only when that can lose nothing: the server says the
// company's access has definitely ended (a demo that was ended, ran out or was removed by
// the nightly reset). No signal, a timeout or a server error never removes anything: the route
// stays readable and queued inspections and photos wait.
//
// Signed out (the technician tapped Sign out, or the server refused the session: it expired, or
// the person was deactivated), nothing of the sign-in stays readable. With nothing waiting to
// send its data leaves the phone; otherwise only what the waiting changes need is kept, and the
// app shows a locked screen until the same person signs in again. The same goes for another
// person's data while someone else is signed in on the phone.

/** A demo company that ended, and what it had waiting on this phone when it was removed. */
export interface EndedAccess {
  organizationName: string;
  discarded: number;
}

export type TechSession =
  /** Signed in: `others` are other sign-ins whose changes still wait on this phone. */
  | { kind: "signed_in"; me: Me; others: { tenant: KnownTenant; pending: number }[]; ended: EndedAccess[] }
  /** No signal or a server error just now: the saved copy of the last sign-in. */
  | { kind: "cached"; reason: "offline" | "error"; me: Me | undefined }
  /** Signed out with changes still on the phone: they wait for this person; nothing else shows. */
  | { kind: "locked"; tenant: KnownTenant; pending: number }
  /** The last sign-in's company has ended; its data is gone from this phone. */
  | { kind: "ended"; ended: EndedAccess }
  /** Nothing saved on this phone to show. */
  | { kind: "none"; reason: "offline" | "signed_out" | "other_account" | "error" };

/** Removes one sign-in's data if, and only if, the server says its company has ended. */
export async function discardIfEnded(t: KnownTenant): Promise<EndedAccess | null> {
  if ((await accessEnded(t.organizationId, t.demoTicket)) !== true) return null;
  const discarded = await pendingFor(t);
  await forgetTenant(t);
  return { organizationName: t.organizationName, discarded };
}

/**
 * The phone is signed out of this sign-in: with nothing waiting to send, its data leaves the
 * phone; otherwise only what the waiting changes need stays. Returns how many wait.
 */
export async function signOutOnPhone(t: KnownTenant): Promise<number> {
  // Answers a form wrote down as the page went are this person's work too.
  await restoreUnsaved(t);
  const pending = await pendingFor(t);
  if (pending === 0) {
    await forgetTenant(t);
    return 0;
  }
  markSignedOut(t);
  // A database this version cannot rewrite stays as it is; the locked screen shows none of it.
  await Promise.all([keepOnlyQueued(t).catch(() => {}), keepOnlyQueuedWork(t).catch(() => {})]);
  return pending;
}

/** Other sign-ins kept on this phone: removed when ended or when nothing waits to send. */
async function tidyOthers(current: KnownTenant) {
  const others: { tenant: KnownTenant; pending: number }[] = [];
  const ended: EndedAccess[] = [];
  for (const t of knownTenants()) {
    if (sameTenant(t, current)) continue;
    await restoreUnsaved(t);
    if ((await pendingFor(t)) === 0) {
      await forgetTenant(t);
      continue;
    }
    const gone = await discardIfEnded(t);
    if (gone) ended.push(gone);
    else others.push({ tenant: t, pending: await signOutOnPhone(t) });
  }
  return { others, ended };
}

// A Sign out tapped with no signal: the server still has the session, so the next start ends it
// before reading anything as that person. Only a session from before the tap: one signed in since
// on this phone (Sign in on the card, a demo, an invitation) is not the one that was signed out.
const SIGN_OUT_PENDING_KEY = "aerowise-tech:sign-out-pending";

/** Notes the tap, before anything else, so a sign-out the page does not live to finish still happens. */
export function noteSignOut() {
  try {
    localStorage.setItem(SIGN_OUT_PENDING_KEY, new Date().toISOString());
  } catch {
    // Private mode: the session cookie is all there is.
  }
}

function signOutNoted(): string | null {
  try {
    const at = localStorage.getItem(SIGN_OUT_PENDING_KEY);
    return at && !Number.isNaN(Date.parse(at)) ? at : null;
  } catch {
    return null;
  }
}

/**
 * Ends this browser's session on the server, or with `signedInBefore`, only a session signed in
 * before then. True once the server has answered, which also clears a noted sign-out; false when
 * it could not be asked.
 */
export async function endServerSession(signedInBefore?: string): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signedInBefore ? { signedInBefore } : {}),
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    try {
      localStorage.removeItem(SIGN_OUT_PENDING_KEY);
    } catch {
      // Nothing was noted.
    }
    return true;
  } catch {
    return false;
  }
}

/** Signed out on this phone: what waits for this person, or, with nothing, `none` for `reason`. */
const locked = async (t: KnownTenant, reason: "offline" | "signed_out"): Promise<TechSession> => {
  const pending = await signOutOnPhone(t);
  return pending > 0 ? { kind: "locked", tenant: { ...t, signedOut: true }, pending } : { kind: "none", reason };
};

export async function openTechSession(): Promise<TechSession> {
  await adoptLegacyStore();
  const last = lastActiveTenant();
  const signedOutAt = signOutNoted();
  // A Sign out noted with no signal is finished first. Still none: the phone is signed out already, so nothing shows as anyone.
  if (signedOutAt && !(await endServerSession(signedOutAt))) return last ? locked(last, "offline") : { kind: "none", reason: "offline" };
  const res = await fetchMe();
  if (res.ok) {
    const me = res.data;
    const t = rememberTenant({ organizationId: me.organization.id, userId: me.user.id }, {
      organizationName: me.organization.name,
      userName: me.user.name,
      demoTicket: me.demoTicket,
    });
    activateTenant(t);
    await activeStore().kvSet("me", me);
    await restoreUnsaved(t);
    return { kind: "signed_in", me, ...(await tidyOthers(t)) };
  }
  if (!last) return { kind: "none", reason: res.reason };
  // Only a refused sign-in can mean the company ended; with no signal, nobody can say.
  if (res.reason === "signed_out") {
    const ended = await discardIfEnded(last);
    if (ended) return { kind: "ended", ended };
    return locked(last, "signed_out");
  }
  if (last.signedOut || res.reason === "other_account") return locked(last, res.reason === "offline" ? "offline" : "signed_out");
  activateTenant(last);
  await restoreUnsaved(last);
  return { kind: "cached", reason: res.reason, me: await activeStore().kvGet<Me>("me") };
}
