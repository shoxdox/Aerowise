"use client";

import type { PlatformAdminMe } from "@aerowise/domain";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { api } from "@/lib/api";
import { Unreachable, useSessionLoad } from "@/lib/session";

export default function AdminLayout({ children }: { children: ReactNode }) {
  // A failed sign-in check offers Retry; only a 401 goes to the sign-in page (api() sends it there).
  const { value: me, failed, retry } = useSessionLoad<PlatformAdminMe>("/admin/auth/me");
  const path = usePathname();
  if (failed) return <Unreachable onRetry={retry} signIn="/admin/login" />;
  if (!me) return <p className="muted pad" role="status">Loading…</p>;

  async function signOut() {
    // Leave even if the server could not be told: the sign-in page is where this ends either way.
    await api("/admin/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    window.location.href = "/admin/login";
  }
  return (
    <>
      <header className="topbar">
        <strong>Aerowise admin</strong>
        <nav>
          <Link href="/admin" className={path === "/admin" ? "active" : undefined}>
            Organizations
          </Link>
          <Link href="/admin/rulesets" className={path.startsWith("/admin/rulesets") ? "active" : undefined}>
            Rulesets
          </Link>
          <Link href="/admin/demo-requests" className={path.startsWith("/admin/demo-requests") ? "active" : undefined}>
            Demo requests
          </Link>
          <Link href="/admin/prospect-demos" className={path.startsWith("/admin/prospect-demos") ? "active" : undefined}>
            Prospect demos
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
