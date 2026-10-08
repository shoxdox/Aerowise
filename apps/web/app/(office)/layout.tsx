"use client";

import { roleHasPermission, type Permission } from "@aerowise/domain";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { LegalGate } from "@/components/legal/LegalGate";
import { api } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { clock } from "@/lib/format";
import { canEdit, isReadOnlyAccount, isSupportView, SessionProvider, useSession } from "@/lib/session";

function Shell({ children }: { children: ReactNode }) {
  const me = useSession();
  const path = usePathname();
  // A link shows only to roles that can open its page (the API enforces this regardless).
  const can = (permission: Permission) => roleHasPermission(me.role, permission);
  const workOrders = useFeature("work_orders");
  const estimates = useFeature("estimates");
  const nav = [
    { href: "/inbox", label: "Inbox" },
    { href: "/schedule", label: "Schedule" },
    ...(workOrders && can("work:read") ? [{ href: "/work", label: "Work" }] : []),
    ...(estimates && can("estimates:read") ? [{ href: "/estimates", label: "Estimates" }] : []),
    { href: "/due", label: "Due" },
    ...(can("filings:read") ? [{ href: "/filings", label: "Filings" }] : []),
    { href: "/renewals", label: "Renewals" },
    ...(can("invoices:read") ? [{ href: "/invoices", label: "Invoices" }] : []),
    ...(can("quickbooks:read") ? [{ href: "/quickbooks", label: "QuickBooks" }] : []),
    ...(can("sms:read") ? [{ href: "/sms", label: "Texts" }] : []),
    { href: "/customers", label: "Customers" },
    { href: "/sites", label: "Sites" },
    { href: "/plans", label: "Plans" },
    ...(canEdit(me) ? [{ href: "/import", label: "Import" }] : []),
    ...(canEdit(me) || isSupportView(me) ? [{ href: "/settings/users", label: "Users" }] : []),
    ...(canEdit(me) || isSupportView(me) ? [{ href: "/settings/company", label: "Company" }] : []),
    ...(me.role === "owner"
      ? [
          { href: "/settings/billing", label: "Billing" },
          { href: "/settings/subscription", label: "Subscription" },
          { href: "/settings/export", label: "Export" },
        ]
      : []),
  ];
  const current = nav.find((item) => path.startsWith(item.href));
  // On a phone the links fold behind a Menu button; choosing one folds them again.
  const [menuOpen, setMenuOpen] = useState(false);
  async function endSupport() {
    await api("/admin/support/end", { method: "POST", body: {} });
    window.location.href = "/admin";
  }
  async function signOut() {
    await api("/auth/logout", { method: "POST", body: {} });
    window.location.href = "/login";
  }
  return (
    <>
      <header className={menuOpen ? "topbar office menu-open" : "topbar office"}>
        <strong>Aerowise</strong>
        {current && <span className="current-page">{current.label}</span>}
        <button className="secondary menu-toggle" aria-expanded={menuOpen} aria-controls="office-nav" onClick={() => setMenuOpen(!menuOpen)}>
          {menuOpen ? "Close" : "Menu"}
        </button>
        <nav id="office-nav" aria-label="Main">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className={item === current ? "active" : undefined} aria-current={item === current ? "page" : undefined} onClick={() => setMenuOpen(false)}>
              {item.label}
            </Link>
          ))}
        </nav>
        <span className="spacer" />
        <span className="account">
          <span className="muted">
            {me.user.name} · {me.organization.name}
          </span>
          {!isSupportView(me) && (
            <button className="link" onClick={signOut}>
              Sign out
            </button>
          )}
        </span>
      </header>
      {me.support && (
        <p className="banner warn" role="status" data-testid="support-banner">
          Aerowise support view of {me.organization.name}: read-only, nothing can be changed. It ends at{" "}
          {clock(me.support.expiresAt)}.{" "}
          <button className="link" onClick={endSupport}>
            End support view
          </button>
        </p>
      )}
      {isReadOnlyAccount(me) && (
        <p className="banner warn" role="status" data-testid="read-only-banner">
          This account is read-only because its Aerowise plan has lapsed. You can still see due inspections, filings and
          deadlines, and view and export everything.{" "}
          {me.role === "owner" ? <Link href="/settings/subscription">Add a payment method to reactivate it.</Link> : "Ask your company's owner to reactivate it."}
        </p>
      )}
      <main className="page">{me.legalDue?.length ? <LegalGate due={me.legalDue} companyName={me.organization.name} /> : children}</main>
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
