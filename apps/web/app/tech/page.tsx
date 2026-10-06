"use client";

import type { InspectionTemplate, Stop } from "@aerowise/domain";
import { useCallback, useEffect, useState } from "react";
import { IntroCard } from "@/components/Intro";
import { InspectionForm } from "@/components/tech/InspectionForm";
import { StopDetail } from "@/components/tech/StopDetail";
import { StopList } from "@/components/tech/StopList";
import { SyncBanner } from "@/components/tech/SyncBanner";
import { api } from "@/lib/api";
import { setDisplayTimeZone } from "@/lib/format";
import { allInspections, allOps, saveInspection, type LocalInspection } from "@/lib/offline/db";
import { currentPosition, loadActiveTemplate, loadMe, loadRoute } from "@/lib/offline/data";
import { startBackgroundSync, subscribe, syncNow, type SyncState } from "@/lib/offline/sync";
import type { Me } from "@/lib/session";

type View = { name: "list" } | { name: "stop"; jobId: string } | { name: "inspect"; jobId: string };

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("/sw.js")
    .then(async () => {
      const reg = await navigator.serviceWorker.ready;
      // Hand over the assets this page already loaded so they work offline too.
      const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.includes("/_next/static/"));
      reg.active?.postMessage({ type: "cache-assets", urls });
    })
    .catch(() => {});
}

export default function TechApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [route, setRoute] = useState<{ date: string; items: Stop[] } | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | undefined>();
  const [template, setTemplate] = useState<InspectionTemplate | undefined>();
  const [inspections, setInspections] = useState<Map<string, LocalInspection>>(new Map());
  const [failures, setFailures] = useState<string[]>([]);
  const [sync, setSync] = useState<SyncState>({ kind: "idle", pending: 0, failed: 0 });
  const [view, setView] = useState<View>({ name: "list" });
  const [loading, setLoading] = useState(true);
  const [needsSignIn, setNeedsSignIn] = useState(false);

  const refreshLocal = useCallback(async () => {
    setInspections(new Map((await allInspections()).map((i) => [i.jobId, i])));
    setFailures((await allOps()).filter((o) => o.failed).map((o) => o.failed!));
  }, []);

  const refresh = useCallback(async () => {
    const [m, r, t] = await Promise.all([loadMe(), loadRoute(), loadActiveTemplate()]);
    if (m.signedOut && !m.data) {
      window.location.href = "/login?next=/tech";
      return;
    }
    setNeedsSignIn(m.signedOut);
    if (m.data) setDisplayTimeZone(m.data.organization.timezone);
    setMe(m.data ?? null);
    if (r.route) setRoute(r.route);
    setFetchedAt(r.fetchedAt);
    setTemplate(t);
    await refreshLocal();
    setLoading(false);
  }, [refreshLocal]);

  useEffect(() => {
    registerServiceWorker();
    void refresh();
    startBackgroundSync();
    return subscribe((s) => {
      setSync(s);
      if (s.kind === "signed_out") setNeedsSignIn(true);
      void refreshLocal();
    });
  }, [refresh, refreshLocal]);

  async function start(stop: Stop) {
    if (!template) return;
    const existing = inspections.get(stop.jobId);
    if (!existing) {
      const insp: LocalInspection = {
        clientId: crypto.randomUUID(),
        jobId: stop.jobId,
        templateId: template.id,
        status: "draft",
        arrivedAt: new Date().toISOString(),
        completedAt: null,
        arrivalGps: await currentPosition(),
        completionGps: null,
        accessIssue: null,
        values: {},
        issues: [],
        photos: [],
        server: null,
      };
      await saveInspection(insp);
      await refreshLocal();
      void syncNow();
    }
    setView({ name: "inspect", jobId: stop.jobId });
  }

  async function signOut() {
    const ops = await allOps();
    if (ops.some((o) => !o.failed) && !window.confirm("Some changes have not reached the office yet. Sign out anyway? They stay on this phone.")) return;
    await api("/auth/logout", { method: "POST", body: {} }).catch(() => {});
    window.location.href = "/login?next=/tech";
  }

  if (loading) return <p className="muted pad">Loading your route…</p>;

  const stop = view.name !== "list" ? route?.items.find((s) => s.jobId === view.jobId) : undefined;

  return (
    <>
      <header className="tech-bar">
        {view.name === "list" ? (
          <strong>Aerowise</strong>
        ) : (
          <button className="link back" onClick={() => setView(view.name === "inspect" ? { name: "stop", jobId: view.jobId } : { name: "list" })}>
            ‹ Back
          </button>
        )}
        <span className="spacer" />
        {me && <span className="muted small">{me.user.name}</span>}
        <button className="link small" onClick={signOut}>
          Sign out
        </button>
      </header>
      <SyncBanner state={sync} failures={failures} needsSignIn={needsSignIn} onRetry={() => void syncNow()} />
      <main className="tech-page">
        {view.name === "list" && me && <IntroCard intro="technician" me={me} />}
        {view.name === "list" && (
          <StopList
            route={route}
            fetchedAt={fetchedAt}
            inspections={inspections}
            onOpen={(jobId) => setView({ name: "stop", jobId })}
            onRefresh={() => void refresh()}
          />
        )}
        {view.name === "stop" && stop && (
          <StopDetail stop={stop} inspection={inspections.get(stop.jobId)} canStart={!!template} onStart={() => void start(stop)} />
        )}
        {view.name === "inspect" && stop && inspections.get(stop.jobId) && (
          <InspectionForm
            key={stop.jobId}
            stop={stop}
            initial={inspections.get(stop.jobId)!}
            onSaved={() => {
              void refreshLocal();
              void syncNow();
            }}
            onFinished={() => {
              void refreshLocal();
              setView({ name: "list" });
            }}
          />
        )}
        {view.name !== "list" && !stop && <p className="muted">This stop is no longer on your route.</p>}
      </main>
    </>
  );
}
