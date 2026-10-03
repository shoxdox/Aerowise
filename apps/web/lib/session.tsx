"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

export interface Me {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string; timezone: string };
  role: "owner" | "office" | "technician" | "read_only";
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

/** Whether the signed-in role may edit records. The API enforces this regardless. */
export const canEdit = (me: Me) => me.role === "owner" || me.role === "office";
