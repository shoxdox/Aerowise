"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

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
  /** Set when Aerowise support is looking at the company read-only. */
  support?: { adminName: string; expiresAt: string };
}

const SessionContext = createContext<Me | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api<Me>("/auth/me").then(setMe, () => {});
  }, []);
  if (!me) return <p className="muted pad">Loading…</p>;
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
