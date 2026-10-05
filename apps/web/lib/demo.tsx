"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "aerowise.demo";

function remembered(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Whether this is the hosted demo (the API runs with DEMO_MODE=true). Remembered on the
 * device so the banner still shows in the technician app with no signal.
 */
export function useDemoMode(): boolean {
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    setDemo(remembered());
    let cancelled = false;
    fetch("/api/app-info", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((info: { demo?: boolean } | null) => {
        if (cancelled || !info) return;
        setDemo(info.demo === true);
        try {
          window.localStorage.setItem(STORAGE_KEY, String(info.demo === true));
        } catch {
          // Private browsing: the banner just waits for the network next time.
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return demo;
}

/** Shown at the top of every screen in the hosted demo. */
export function DemoBanner() {
  const demo = useDemoMode();
  if (!demo) return null;
  return (
    <div className="demo-banner" role="note">
      Demo data. Nothing is sent.
    </div>
  );
}
