"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { api } from "@/lib/api";
import { canEdit, SessionProvider, useSession } from "@/lib/session";

function Shell({ children }: { children: ReactNode }) {
  const me = useSession();
  const path = usePathname();
  const nav = [
    { href: "/inbox", label: "Inbox" },
    { href: "/schedule", label: "Schedule" },
    { href: "/due", label: "Due" },
    { href: "/filings", label: "Filings" },
    { href: "/renewals", label: "Renewals" },
    { href: "/invoices", label: "Invoices" },
    ...(me.role !== "technician" ? [{ href: "/quickbooks", label: "QuickBooks" }, { href: "/sms", label: "Texts" }] : []),
    { href: "/customers", label: "Customers" },
    { href: "/sites", label: "Sites" },
    { href: "/plans", label: "Plans" },
    ...(canEdit(me) ? [{ href: "/import", label: "Import" }] : []),
    ...(canEdit(me) ? [{ href: "/settings/users", label: "Users" }] : []),
    ...(me.role === "owner" ? [{ href: "/settings/billing", label: "Billing" }] : []),
  ];
  async function signOut() {
    await api("/auth/logout", { method: "POST", body: {} });
    window.location.href = "/login";
  }
  return (
    <>
      <header className="topbar">
        <strong>Aerowise</strong>
        <nav>
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className={path.startsWith(item.href) ? "active" : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        <span className="spacer" />
        <span className="muted">
          {me.user.name} · {me.organization.name}
        </span>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>
      <main className="page">{children}</main>
    </>
  );
}

export default function OfficeLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
