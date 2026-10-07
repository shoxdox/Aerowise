"use client";

import type { InspectionTemplate, Stop } from "@aerowise/domain";
import { useCallback, useEffect, useState } from "react";
import { IntroCard } from "@/components/Intro";
import { InspectionForm } from "@/components/tech/InspectionForm";
import { StopDetail } from "@/components/tech/StopDetail";
import { StopList, type RouteView } from "@/components/tech/StopList";
import { SyncBanner } from "@/components/tech/SyncBanner";
import { api } from "@/lib/api";
import { setDisplayTimeZone } from "@/lib/format";
import { activeStore, activeTenant, allInspections, allOps, saveInspection, type KnownTenant, type LocalInspection } from "@/lib/offline/db";
import { currentPosition, loadActiveTemplate, loadRoute } from "@/lib/offline/data";
import { startBackgroundSync, subscribe, syncNow, type SyncState } from "@/lib/offline/sync";
import { discardIfEnded, openTechSession, type EndedAccess } from "@/lib/offline/tenant";
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
  // List or map of the route; kept while a stop is open, so Back returns to the same one.
  const [routeView, setRouteView] = useState<RouteView>("list");
  const [loading, setLoading] = useState(true);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  // A demo company that ended: its data was removed from the phone and nothing of it shows.
  const [ended, setEnded] = useState<EndedAccess | null>(null);
  const [endedElsewhere, setEndedElsewhere] = useState<EndedAccess[]>([]);
  const [others, setOthers] = useState<{ tenant: KnownTenant; pending: number }[]>([]);

  const refreshLocal = useCallback(async () => {
    if (!activeTenant()) return;
    setInspections(new Map((await allInspections()).map((i) => [i.jobId, i])));
    setFailures((await allOps()).filter((o) => o.failed).map((o) => o.failed!));
  }, []);

  const showEnded = useCallback((e: EndedAccess) => {
    setEnded(e);
    setMe(null);
    setRoute(null);
    setTemplate(undefined);
    setInspections(new Map());
    setFailures([]);
    setView({ name: "list" });
  }, []);

  const refresh = useCallback(async () => {
    const session = await openTechSession();
    if (session.kind === "ended") {
      showEnded(session.ended);
      setLoading(false);
      return;
    }
    if (session.kind === "none" || (session.kind === "cached" && !session.me)) {
      if (session.reason === "signed_out") {
        window.location.href = "/login?next=/tech";
        return;
      }
      // Nothing saved on this phone yet: the route list says to open the app with signal.
      setLoading(false);
      return;
    }
    setEnded(null);
    setNeedsSignIn(session.kind === "cached" && (session.reason === "signed_out" || session.reason === "other_account"));
    setOthers(session.kind === "signed_in" ? session.others : []);
    if (session.kind === "signed_in" && session.ended.length > 0) setEndedElsewhere(session.ended);
    const m = session.me!;
    setDisplayTimeZone(m.organization.timezone);
    setMe(m);
    const store = activeStore();
    const [r, t] = await Promise.all([loadRoute(store), loadActiveTemplate(store)]);
    setRoute(r.route ?? null);
    setFetchedAt(r.fetchedAt);
    setTemplate(t);
    await refreshLocal();
    setLoading(false);
    void syncNow();
  }, [refreshLocal, showEnded]);

  useEffect(() => {
    registerServiceWorker();
    startBackgroundSync();
    // Opened only after the sign-in is known, so nothing of another sign-in is ever read.
    void refresh();
    return subscribe((s) => {
      setSync(s);
      if (s.kind === "signed_out") {
        setNeedsSignIn(true);
        // Back in signal and refused: ask whether the company ended, and only then clear it.
        const t = activeTenant();
        if (t) void discardIfEnded(t).then((e) => e && showEnded(e));
      }
      // The phone is signed in as someone else now: switch to them; these changes wait.
      if (s.kind === "other_account") void refresh();
      void refreshLocal();
    });
  }, [refresh, refreshLocal, showEnded]);

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

  if (ended) {
    return (
      <main className="tech-page">
        <div className="card stack" role="alert" data-testid="access-ended">
          <h1>This demo has ended</h1>
          <p>
            {ended.organizationName ? `${ended.organizationName} is` : "This demo company is"} no longer available. Its route, inspections and photos were removed from this
            phone.
          </p>
          {ended.discarded > 0 && (
            <p className="muted">
              {ended.discarded} unsent {ended.discarded === 1 ? "change" : "changes"} from the demo could not be sent, because the demo company no longer exists. Nothing was
              recorded for a real company.
            </p>
          )}
          <a className="button" href="/login?next=/tech">
            Sign in
          </a>
        </div>
      </main>
    );
  }

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
      {(others.length > 0 || endedElsewhere.length > 0) && (
        <div className="sync-area" data-testid="other-sign-ins">
          {others.map(({ tenant, pending }) => (
            <p key={`${tenant.organizationId}:${tenant.userId}`} className="sync warn" role="status">
              {pending} {pending === 1 ? "change" : "changes"} made as {tenant.userName || "another person"}
              {tenant.organizationName && ` at ${tenant.organizationName}`} {pending === 1 ? "is" : "are"} saved on this phone. Sign in as them to send{" "}
              {pending === 1 ? "it" : "them"}.
            </p>
          ))}
          {endedElsewhere.map((e, i) => (
            <p key={i} className="sync" role="status">
              The demo {e.organizationName && `for ${e.organizationName} `}has ended, so its data was removed from this phone
              {e.discarded > 0 && `, including ${e.discarded} unsent ${e.discarded === 1 ? "change" : "changes"}`}.
            </p>
          ))}
        </div>
      )}
      <main className="tech-page">
        {view.name === "list" && me && <IntroCard intro="technician" me={me} />}
        {view.name === "list" && (
          <StopList
            route={route}
            fetchedAt={fetchedAt}
            inspections={inspections}
            onOpen={(jobId) => setView({ name: "stop", jobId })}
            onRefresh={() => void refresh()}
            view={routeView}
            onView={setRouteView}
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
