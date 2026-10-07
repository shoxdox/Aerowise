"use client";

import type { Me } from "../session";
import { accessEnded, fetchMe } from "./data";
import {
  activateTenant,
  activeStore,
  adoptLegacyStore,
  forgetTenant,
  knownTenants,
  lastActiveTenant,
  pendingFor,
  rememberTenant,
  sameTenant,
  type KnownTenant,
} from "./db";

// Which sign-in the technician app opens as, and when a sign-in's data leaves the phone.
//
// Data is removed from the phone only when that can lose nothing: the server says the
// company's access has definitely ended (a demo that was ended or ran out), or another
// person is signed in and that sign-in has nothing waiting to send. No signal, a timeout,
// a server error or an expired session never removes anything: the route stays readable
// and queued inspections and photos wait for the same person to sign in again.

/** A demo company that ended, and what it had waiting on this phone when it was removed. */
export interface EndedAccess {
  organizationName: string;
  discarded: number;
}

export type TechSession =
  /** Signed in: `others` are other sign-ins whose changes still wait on this phone. */
  | { kind: "signed_in"; me: Me; others: { tenant: KnownTenant; pending: number }[]; ended: EndedAccess[] }
  /** Not confirmed by the server just now: the saved copy of the last sign-in. */
  | { kind: "cached"; reason: "offline" | "signed_out" | "other_account" | "error"; me: Me | undefined }
  /** The last sign-in's company has ended; its data is gone from this phone. */
  | { kind: "ended"; ended: EndedAccess }
  /** Nothing saved on this phone to show. */
  | { kind: "none"; reason: "offline" | "signed_out" | "other_account" | "error" };

/** Removes one sign-in's data if, and only if, the server says its company has ended. */
export async function discardIfEnded(t: KnownTenant): Promise<EndedAccess | null> {
  if ((await accessEnded(t.organizationId)) !== true) return null;
  const discarded = await pendingFor(t);
  await forgetTenant(t);
  return { organizationName: t.organizationName, discarded };
}

/** Other sign-ins kept on this phone: removed when ended or when nothing waits to send. */
async function tidyOthers(current: KnownTenant) {
  const others: { tenant: KnownTenant; pending: number }[] = [];
  const ended: EndedAccess[] = [];
  for (const t of knownTenants()) {
    if (sameTenant(t, current)) continue;
    const pending = await pendingFor(t);
    if (pending === 0) {
      await forgetTenant(t);
      continue;
    }
    const gone = await discardIfEnded(t);
    if (gone) ended.push(gone);
    else others.push({ tenant: t, pending });
  }
  return { others, ended };
}

export async function openTechSession(): Promise<TechSession> {
  await adoptLegacyStore();
  const last = lastActiveTenant();
  const res = await fetchMe();
  if (res.ok) {
    const me = res.data;
    const t = rememberTenant({ organizationId: me.organization.id, userId: me.user.id }, { organizationName: me.organization.name, userName: me.user.name });
    activateTenant(t);
    await activeStore().kvSet("me", me);
    return { kind: "signed_in", me, ...(await tidyOthers(t)) };
  }
  if (!last) return { kind: "none", reason: res.reason };
  // Only a refused sign-in can mean the company ended; with no signal, nobody can say.
  if (res.reason === "signed_out") {
    const ended = await discardIfEnded(last);
    if (ended) return { kind: "ended", ended };
  }
  activateTenant(last);
  return { kind: "cached", reason: res.reason, me: await activeStore().kvGet<Me>("me") };
}
