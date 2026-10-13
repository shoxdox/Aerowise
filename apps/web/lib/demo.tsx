"use client";

import { DEMO_NOTICE } from "@aerowise/domain";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useLoad } from "@/components/useLoad";
import { LoadState } from "@/components/LoadState";
import { api, ApiError } from "@/lib/api";

const STORAGE_KEY = "aerowise.demo";

interface DemoInfo {
  /** The demo deployment (the API runs with DEMO_MODE=true): shows the demo sign-ins. */
  demo: boolean;
  /** Whoever is signed in works in a demo company (always so on the demo deployment). */
  demoCompany: boolean;
  /** A visitor's own demo company from "Try the demo": they can look around as each person. */
  demoVisitor: boolean;
  demoRole?: string | null;
  demoExpiresAt?: string | null;
}

const NONE: DemoInfo = { demo: false, demoCompany: false, demoVisitor: false };

function remembered(): DemoInfo {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "true") return { demo: true, demoCompany: true, demoVisitor: false };
    if (v === "company") return { demo: false, demoCompany: true, demoVisitor: false };
  } catch {
    // Private browsing: nothing remembered.
  }
  return NONE;
}

/**
 * Asks the API on every screen change (signing in can move someone into a demo company).
 * Remembered on the device so the banner still shows in the technician app with no signal.
 */
function useDemoInfo(): DemoInfo {
  const pathname = usePathname();
  const [info, setInfo] = useState<DemoInfo>(NONE);
  useEffect(() => {
    setInfo((prev) => (prev.demoCompany ? prev : remembered()));
    let cancelled = false;
    fetch("/api/app-info", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: Partial<DemoInfo> | null) => {
        if (cancelled || !body) return;
        const next = { demo: body.demo === true, demoCompany: body.demo === true || body.demoCompany === true, demoVisitor: body.demoVisitor === true, demoRole: body.demoRole ?? null, demoExpiresAt: body.demoExpiresAt ?? null };
        setInfo(next);
        try {
          window.localStorage.setItem(STORAGE_KEY, next.demo ? "true" : next.demoCompany ? "company" : "false");
        } catch {
          // Private browsing: the banner just waits for the network next time.
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname]);
  return info;
}

/** Whether this is the hosted demo deployment, where the demo sign-ins are shown. */
export function useDemoMode(): boolean {
  return useDemoInfo().demo;
}

/** Whoever is signed in works in a demo company, whose sites are made up. */
export function useDemoCompany(): boolean {
  return useDemoInfo().demoCompany;
}

export function useDemoVisitor(): boolean { return useDemoInfo().demoVisitor; }

/**
 * Shown at the top of every screen in the hosted demo, and to anyone in a demo company. Not on
 * the marketing page: a prospect landing there is not in any company yet, and the strip was the
 * first thing they read.
 */
export function DemoBanner() {
  const { demoCompany, demoVisitor, demoRole, demoExpiresAt } = useDemoInfo();
  const pathname = usePathname();
  if (!demoCompany || pathname === "/") return null;
  return (
    <div className="demo-banner" role="note">
      {DEMO_NOTICE}
      {demoVisitor && <><strong> Active role: {demoRole ?? "loading"}.</strong><ViewAs />{demoExpiresAt && <span> Your private demo ends {new Date(demoExpiresAt).toLocaleString()}.</span>}{pathname !== "/inbox" && <details><summary>Five-minute walkthrough</summary><DemoJourney /></details>}</>}
    </div>
  );
}

const VIEWS = [
  { role: "owner", label: "Owner", home: "/inbox" },
  { role: "office", label: "Office", home: "/inbox" },
  { role: "technician", label: "Technician", home: "/tech" },
] as const;

/** In a visitor's own demo company: switch between its owner, office manager and technician. */
function ViewAs() {
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  async function view(role: string, home: string) {
    if (busy) return;
    setBusy(true);
    setError(false);
    const res = await fetch("/api/demo/switch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }) }).catch(() => null);
    if (res?.ok) window.location.assign(home);
    else { setError(true); setBusy(false); }
  }
  return (
    <span className="demo-view-as">
      {" "}
      View as:{" "}
      {VIEWS.map((v, i) => (
        <span key={v.role}>
          {i > 0 && " · "}
          <button type="button" className="link" disabled={busy} onClick={() => void view(v.role, v.home)}>
            {v.label}
          </button>
        </span>
      ))}
      {error && " (could not switch, try again)"}
    </span>
  );
}


interface Journey {
  expiresAt: string; role: string;
  case: { filingId: string; siteId: string; customerId: string; customerName: string; addressLine1: string; city: string; inspectionId: string; completedAt: string | null; status: string; submissionMethod: string | null };
  obligation: { id: string; dueOn: string } | null;
  job: { id: string; scheduledDate: string } | null;
  invoice: { id: string; paymentStatus: string } | null;
  work: { id: string; title: string; status: string } | null;
  renewal: { id: string; customerId: string; status: string } | null;
}

/** Short, optional walkthrough of real application records in this visitor's disposable tenant. */
export function DemoJourney() {
  const load = useLoad<Journey>("/demo/journey");
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const j = load.data;
  useEffect(() => {
    if (!j) return;
    try { setStep(Math.min(4, Math.max(0, Number(sessionStorage.getItem(`aerowise-tour:${j.expiresAt}`)) || 0))); } catch { /* optional context */ }
  }, [j?.expiresAt]);
  function choose(n: number) { setStep(n); try { if (j) sessionStorage.setItem(`aerowise-tour:${j.expiresAt}`, String(n)); } catch { /* optional context */ } }
  async function open(role: string, href: string) {
    if (busy) return;
    setBusy(true); setError(null);
    try { if (j?.role !== role) await api("/demo/switch", { method: "POST", body: { role } }); window.location.assign(href); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Could not switch view. Retry or use the role buttons."); setBusy(false); }
  }
  async function homeowner(customerId: string) {
    if (busy) return;
    setBusy(true); setError(null);
    try { const link = await api<{ href: string }>("/demo/homeowner", { method: "POST", body: { customerId } }); window.location.assign(link.href); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Could not open this example. Retry when connected."); setBusy(false); }
  }
  return <section className="card stack demo-journey" aria-labelledby="demo-journey-title"><h2 id="demo-journey-title">Aerowise in five minutes</h2><LoadState load={load} label="walkthrough records" />{j && <>
    <p><strong>{j.case.customerName}</strong> · {j.case.addressLine1}, {j.case.city}. Follow one fictional case across the office, field and homeowner views. All outside effects are simulated.</p>
    <nav className="row" aria-label="Walkthrough steps">{["Completed result", "Schedule", "Technician", "Office review", "Homeowner"].map((label, n) => <button className={step === n ? undefined : "secondary"} aria-current={step === n ? "step" : undefined} onClick={() => choose(n)} key={label}>{n + 1}. {label}</button>)}</nav>
    <div role="region" aria-live="polite" className="stack">
      {step === 0 && <><p>Start with the finished inspection and its actual report, submission package and evidence. You can see the result before filling in a form.</p><button disabled={busy} onClick={() => void open("office", `/filings/${j.case.filingId}`)}>Open completed report and evidence</button></>}
      {step === 1 && <><p>The site&apos;s next obligation and booked visit stay connected. Opening Schedule selects this case without changing its assignment.</p><button disabled={busy} onClick={() => void open("office", `/schedule?siteId=${j.case.siteId}${j.obligation ? `&obligationId=${j.obligation.id}` : ""}${j.job ? `&date=${j.job.scheduledDate}` : ""}`)}>Open this visit in Schedule</button></>}
      {step === 2 && <>{j.job ? <><p>Switch to Tess Tech to open this case&apos;s follow-up on today&apos;s route, read its site notes and inspect. Starting or finishing is optional.</p><button disabled={busy} onClick={() => void open("technician", `/tech?jobId=${j.job!.id}`)}>Open technician stop</button></> : <><p>This case no longer has an open stop on Tess&apos;s route today; it may have been moved, reassigned or completed. Its existing inspection and report stay available.</p><button disabled={busy} onClick={() => void open("office", `/filings/${j.case.filingId}`)}>Review this case&apos;s completed inspection</button><button className="secondary" disabled={busy} onClick={() => void open("technician", "/tech")}>Explore Tess&apos;s current route</button></>}{j.work && <button className="secondary" disabled={busy} onClick={() => void open("office", `/work/${j.work!.id}`)}>See {j.work.title}</button>}</>}
      {step === 3 && <><p>The maintenance provider reviews and signs the report in the office. The filing shows its actual method, proof and any acknowledgment process. A fictional receipt does not prove real authority acceptance.</p><button disabled={busy} onClick={() => void open("owner", `/filings/${j.case.filingId}`)}>Open provider review and signature</button><Link href={`/sites/${j.case.siteId}`}>See current system, contract and history</Link></>}
      {step === 4 && <><p>Open the populated homeowner view directly. Its reports and any invoice belong to this same case. Test payment is simulated.</p><button disabled={busy} onClick={() => void homeowner(j.case.customerId)}>Open {j.case.customerName}&apos;s homeowner view</button>{j.invoice && <button className="secondary" disabled={busy} onClick={() => void open("office", `/invoices/${j.invoice!.id}`)}>Open test invoice · {j.invoice.paymentStatus}</button>}{j.renewal && <><p className="muted small">A second fictional homeowner has an existing renewal example.</p><button className="secondary" disabled={busy} onClick={() => void homeowner(j.renewal!.customerId)}>Open homeowner renewal example</button></>}</>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="row"><button className="secondary" disabled={step === 0} onClick={() => choose(step - 1)}>Previous step</button><button className="secondary" disabled={step === 4} onClick={() => choose(step + 1)}>Next step / skip</button><span className="muted small">Explore freely; return here from the demo banner. Ends {new Date(j.expiresAt).toLocaleString()}.</span></div>
  </>}</section>;
}
