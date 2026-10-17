"use client";

import type { Feature } from "@aerowise/domain";
import { useEffect, useState } from "react";
import { useOptionalSession } from "./session";

let cached: Promise<Set<Feature>> | null = null;

/** What this deployment has switched on (AEROWISE_FEATURES, via /app-info). Asked once per page load. */
function load(): Promise<Set<Feature>> {
  cached ??= fetch("/api/app-info", { credentials: "same-origin" })
    .then((res) => (res.ok ? res.json() : {}))
    .then((body: { features?: Feature[] }) => new Set(body.features ?? []))
    .catch(() => {
      cached = null;
      return new Set<Feature>();
    });
  return cached;
}

/**
 * Whether a feature is on. Inside the office and admin screens the session already says, so
 * the menu and pages draw once with the right links. Elsewhere (or from an older session that
 * does not carry the list) it asks /app-info, and is false until known so create screens never
 * flash on.
 */
export function useFeature(feature: Feature): boolean {
  const known = useOptionalSession()?.features;
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (known) return;
    let live = true;
    void load().then((set) => live && setOn(set.has(feature)));
    return () => {
      live = false;
    };
  }, [feature, known]);
  return known ? known.includes(feature) : on;
}
