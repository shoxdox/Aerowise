"use client";

import { roleHasPermission, type Permission } from "@aerowise/domain";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { LegalGate } from "@/components/legal/LegalGate";
import { api } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { clock } from "@/lib/format";
import { canEdit, isReadOnlyAccount, isSupportView, SessionProvider, useSession, type Me } from "@/lib/session";
import { settingsPages } from "@/lib/settings-pages";

const ROLE_LABELS: Record<Me["role"], string> = { owner: "Owner", office: "Office", technician: "Technician", read_only: "Read-only" };

/** "Oscar Office" → "OO", for the account button. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** Who is signed in, to which company, and Sign out: one button instead of a line of text in the header. */
function AccountMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  async function signOut() {
    try {
      await api("/auth/logout", { method: "POST", body: {} });
    } catch {
      // Leave even when the request didn't get through (no signal): they asked to close these screens.
    }
    window.location.href = "/login";
  }
  return (
    <div className="account" ref={box}>
      <button ref={toggle} className="account-toggle" aria-expanded={open} aria-controls="account-menu" onClick={() => setOpen(!open)}>
        <span className="avatar" aria-hidden="true">
          {initials(me.user.name)}
        </span>
        <span className="sr-only">Account</span>
      </button>
      {open && (
        <div id="account-menu" className="account-menu">
          <p className="account-name">{me.user.name}</p>
          <p className="muted small wrap-anywhere">{me.user.email}</p>
          <p className="small">
            {ROLE_LABELS[me.role]} · {me.organization.name}
          </p>
          {!isSupportView(me) && (
            <button className="secondary" onClick={signOut}>
              Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Whether the menu's links fit on one row between the logo and the account button. How wide
 * they are depends on the role and the company's features, so it is measured rather than tied to
 * a screen width: where they don't fit (phones, tablets, a narrow laptop) they fold behind Menu.
 * Folded, the links stay laid out in a hidden zero-width row, so they can still be measured.
 */
function useLinksFit(header: RefObject<HTMLElement | null>, links: string, menuOpen: boolean) {
  const [fit, setFit] = useState(true);
  useLayoutEffect(() => {
    const h = header.current;
    if (!h) return;
    const check = () => {
      // The open menu is laid out as a panel; measure again once it closes.
      if (h.classList.contains("menu-open")) return;
      const groups = h.querySelectorAll("nav > .nav-group");
      const brand = h.querySelector(".brand");
      const account = h.querySelector(".account");
      if (groups.length === 0 || !brand || !account) return;
      const style = getComputedStyle(h);
      const needed = groups[groups.length - 1]!.getBoundingClientRect().right - groups[0]!.getBoundingClientRect().left + 8;
      const room = h.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - brand.getBoundingClientRect().width - account.getBoundingClientRect().width - 2 * parseFloat(style.columnGap);
      setFit(needed <= room);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(h);
    return () => observer.disconnect();
  }, [header, links, menuOpen]);
  return fit;
}

function Shell({ children }: { children: ReactNode }) {
  const me = useSession();
  const path = usePathname();
  const router = useRouter();
  // A link shows only to roles that can open its page (the API enforces this regardless).
  const can = (permission: Permission) => roleHasPermission(me.role, permission);
  const workOrders = useFeature("work_orders");
  const estimates = useFeature("estimates");
  const serviceItems = useFeature("service_items");
  const pumping = useFeature("pumping");
  // Five groups: the day, the work, the customers, the money, and the settings behind one link
  // (their index lists what this role can change). Owners who inspect get their route here too.
  const settings = settingsPages(me, { serviceItems, pumping });
  const groups = [
    {
      label: "Today",
      items: [
        { href: "/inbox", label: "Inbox" },
        { href: "/schedule", label: "Schedule" },
        { href: "/due", label: "Due" },
        ...(can("inspections:write") && !isSupportView(me) ? [{ href: "/tech", label: "My route" }] : []),
      ],
    },
    {
      label: "Work",
      items: [
        ...(workOrders && can("work:read") ? [{ href: "/work", label: "Work" }] : []),
        ...(estimates && can("estimates:read") ? [{ href: "/estimates", label: "Estimates" }] : []),
        ...(pumping && can("work:write") ? [{ href: "/disposal", label: "Disposal" }] : []),
        ...(can("filings:read") ? [{ href: "/filings", label: "Filings" }] : []),
      ],
    },
    {
      label: "Customers",
      items: [
        { href: "/customers", label: "Customers" },
        { href: "/sites", label: "Sites" },
        { href: "/plans", label: "Plans" },
        { href: "/renewals", label: "Renewals" },
        ...(canEdit(me) ? [{ href: "/import", label: "Import" }] : []),
      ],
    },
    {
      label: "Money",
      items: [
        ...(can("invoices:read") ? [{ href: "/invoices", label: "Invoices" }] : []),
        ...(can("quickbooks:read") ? [{ href: "/quickbooks", label: "QuickBooks" }] : []),
        ...(can("sms:read") ? [{ href: "/sms", label: "Texts" }] : []),
      ],
    },
    { label: "Settings", items: settings.length ? [{ href: "/settings", label: "Settings" }] : [] },
  ].filter((g) => g.items.length > 0);
  const nav = groups.flatMap((g) => g.items);
  const current = nav.find((item) => path === item.href || path.startsWith(`${item.href}/`));
  // Where the links don't fit they fold behind a Menu button; choosing one folds them again.
  const [menuOpen, setMenuOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const fit = useLinksFit(header, nav.map((item) => item.href).join(" "), menuOpen);

  // Technicians work from the phone app. A texted office link (or a ?next= from before they
  // signed in) would otherwise leave them in screens their role mostly can't use.
  const technician = me.role === "technician";
  useEffect(() => {
    if (technician) router.replace("/tech");
  }, [technician, router]);

  // Name the tab after the menu item ("Schedule · Aerowise"). Detail pages name it after their
  // record with usePageTitle, whose effect runs before this one (children first), so a title that
  // isn't one of the menu's is the page's own and stays.
  const label = current?.label;
  const menuTitles = nav.map((item) => `${item.label} · Aerowise`).join("\n");
  const tabTitle = useRef("Aerowise");
  // Renames the <title> Next renders, and never adds one: an extra one would outlive this layout.
  const nameTab = () => {
    if (document.querySelector("title")) document.title = tabTitle.current;
  };
  useEffect(() => {
    const now = document.title;
    if (now !== "" && now !== "Aerowise" && !menuTitles.split("\n").includes(now)) return;
    tabTitle.current = label ? `${label} · Aerowise` : "Aerowise";
    nameTab();
  }, [path, label, menuTitles]);
  useEffect(() => {
    // On a navigation Next swaps in the root layout's plain "Aerowise" <title>, sometimes after the
    // tab was named (above, or by the page); name it again when that happens. Between the swap's
    // two steps there is no title at all, which says nothing.
    const observer = new MutationObserver(() => {
      const now = document.title;
      if (now === "") return;
      if (now === "Aerowise") {
        if (tabTitle.current !== "Aerowise") nameTab();
      } else tabTitle.current = now;
    });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  async function endSupport() {
    await api("/admin/support/end", { method: "POST", body: {} });
    window.location.href = "/admin";
  }
  if (technician) return <p className="muted pad">Opening your route…</p>;
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header ref={header} className={`topbar office${fit ? "" : " folded"}${menuOpen && !fit ? " menu-open" : ""}`}>
        <Link href="/inbox" className="brand">
          <img src="/icons/icon.svg" alt="" width={28} height={28} />
          <span className="brand-name">Aerowise</span>
        </Link>
        {current && <span className="current-page">{current.label}</span>}
        <nav id="office-nav" aria-label="Main">
          {groups.map((g) => (
            <div key={g.label} className="nav-group" role="group" aria-label={g.label}>
              {(g.items.length > 1 || g.items[0]!.label !== g.label) && (
                <span className="nav-group-label" aria-hidden="true">
                  {g.label}
                </span>
              )}
              {g.items.map((item) => (
                <Link key={item.href} href={item.href} className={item === current ? "active" : undefined} aria-current={item === current ? "page" : undefined} onClick={() => setMenuOpen(false)}>
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <AccountMenu me={me} />
        <button className="secondary menu-toggle" aria-expanded={menuOpen} aria-controls="office-nav" onClick={() => setMenuOpen(!menuOpen)}>
          {menuOpen ? "Close" : "Menu"}
        </button>
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
      <main className="page" id="main" tabIndex={-1}>
        {me.legalDue?.length ? <LegalGate due={me.legalDue} companyName={me.organization.name} /> : children}
      </main>
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
