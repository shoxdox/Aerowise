"use client";

import type { Feature } from "@aerowise/domain";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import { setDisplayTimeZone } from "./format";

export interface Me {
  user: { id: string; name: string; email: string };
  organization: {
    id: string;
    name: string;
    timezone: string;
    /** Missing from a copy cached on a phone before plans existed. */
    subscription?: { state: "design_partner" | "trial" | "active" | "past_due" | "read_only"; endsOn: string | null; readOnly: boolean };
  };
  role: "owner" | "office" | "technician" | "read_only";
  /** Documents this owner must accept first (W8.3). Missing from a copy cached on a phone before then. */
  legalDue?: ("terms" | "privacy")[];
  /** First-run intros this person has closed (W10.4). Missing from a copy cached on a phone before then. */
  introsDismissed?: ("office" | "technician")[];
  /** Set when Aerowise support is looking at the company read-only. */
  support?: { adminName: string; expiresAt: string };
  /** Demo companies only: lets the technician app learn later that the company was removed. */
  demoTicket?: string;
  /** What this deployment has switched on, so the menu draws once. Missing from an older cached copy. */
  features?: Feature[];
  /** The company's date when this was loaded (YYYY-MM-DD, its own time zone). */
  today?: string;
}

const SessionContext = createContext<Me | null>(null);

/** The signed-in session, or null outside the office and admin screens (features.ts asks it first). */
export const useOptionalSession = () => useContext(SessionContext);

/** Shown when the sign-in check itself cannot be answered: a deploy, a dropped connection. Never a blank "Loading…" forever. */
export function Unreachable({ onRetry, signIn = "/login" }: { onRetry: () => void; signIn?: string }) {
  return (
    <div className="pad stack" role="alert" style={{ maxWidth: 520, margin: "48px auto" }}>
      <h1>Could not reach Aerowise</h1>
      <p>Check your connection, then try again. Nothing you saved is lost.</p>
      <div className="row">
        <button onClick={onRetry}>Try again</button>
        <a href={signIn}>Sign in again</a>
      </div>
    </div>
  );
}

/**
 * Loads a signed-in session once, with a way back when it fails. A 401 already sends to the
 * sign-in page (api() does that); any other failure offers Retry instead of waiting forever.
 */
export function useSessionLoad<T>(path: string, onLoaded?: (value: T) => void) {
  const [state, setState] = useState<{ value: T | null; failed: boolean }>({ value: null, failed: false });
  const load = useCallback(() => {
    setState({ value: null, failed: false });
    api<T>(path).then(
      (value) => {
        onLoaded?.(value);
        setState({ value, failed: false });
      },
      (err) => {
        // The sign-in page is already on its way.
        if (err instanceof ApiError && err.status === 401) return;
        setState({ value: null, failed: true });
      },
    );
    // onLoaded is a setup step, not an input: a new function each render must not reload.
  }, [path]);
  useEffect(load, [load]);
  return { ...state, retry: load };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { value: me, failed, retry } = useSessionLoad<Me>("/auth/me", (m) => setDisplayTimeZone(m.organization.timezone));
  if (failed) return <Unreachable onRetry={retry} />;
  if (!me) return <p className="muted pad" role="status">Loading…</p>;
  return <SessionContext.Provider value={me}>{children}</SessionContext.Provider>;
}

export function useSession(): Me {
  const me = useContext(SessionContext);
  if (!me) throw new Error("useSession outside SessionProvider");
  return me;
}

/** Whether the company's Aerowise plan has lapsed: everything stays readable, nothing changes. */
export const isReadOnlyAccount = (me: Me) => me.organization.subscription?.readOnly === true;

/** Whether this is Aerowise support's read-only view of the company. */
export const isSupportView = (me: Me) => Boolean(me.support);

/** Whether the signed-in role may edit records. The API enforces this regardless. */
export const canEdit = (me: Me) => (me.role === "owner" || me.role === "office") && !isReadOnlyAccount(me) && !isSupportView(me);
