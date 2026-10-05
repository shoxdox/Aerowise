"use client";

import type { PlatformAdminMe } from "@aerowise/domain";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";

export default function AdminLayout({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<PlatformAdminMe | null>(null);
  useEffect(() => {
    api<PlatformAdminMe>("/admin/auth/me").then(setMe, () => {});
  }, []);
  if (!me) return <p className="muted pad">Loading…</p>;

  async function signOut() {
    await api("/admin/auth/logout", { method: "POST", body: {} });
    window.location.href = "/admin/login";
  }
  return (
    <>
      <header className="topbar">
        <strong>Aerowise admin</strong>
        <nav>
          <Link href="/admin" className="active">
            Organizations
          </Link>
        </nav>
        <span className="spacer" />
        <span className="muted">{me.name}</span>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
