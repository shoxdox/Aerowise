"use client";

import { DEMO_NOTICE } from "@aerowise/domain";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const STORAGE_KEY = "aerowise.demo";

interface DemoInfo {
  /** The demo deployment (the API runs with DEMO_MODE=true): shows the demo sign-ins. */
  demo: boolean;
  /** Whoever is signed in works in a demo company (always so on the demo deployment). */
  demoCompany: boolean;
}

const NONE: DemoInfo = { demo: false, demoCompany: false };

function remembered(): DemoInfo {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "true") return { demo: true, demoCompany: true };
    if (v === "company") return { demo: false, demoCompany: true };
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
        const next = { demo: body.demo === true, demoCompany: body.demo === true || body.demoCompany === true };
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

/** Shown at the top of every screen in the hosted demo, and to anyone in a demo company. */
export function DemoBanner() {
  const { demoCompany } = useDemoInfo();
  if (!demoCompany) return null;
  return (
    <div className="demo-banner" role="note">
      {DEMO_NOTICE}
    </div>
  );
}
