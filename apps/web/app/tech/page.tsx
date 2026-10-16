"use client";

import type { Inspection, InspectionTemplate, PumpingFieldData, Stop, WorkStop } from "@aerowise/domain";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { IntroCard } from "@/components/Intro";
import { InspectionForm } from "@/components/tech/InspectionForm";
import { plural } from "@/components/tech/plural";
import { DisposalScreen } from "@/components/tech/PumpOut";
import { StopDetail } from "@/components/tech/StopDetail";
import { StopList, type RouteView } from "@/components/tech/StopList";
import { SyncBanner } from "@/components/tech/SyncBanner";
import { routeNumbers, routeOrder } from "@/components/tech/route-order";
import { WorkStopList, workStatus } from "@/components/tech/WorkStops";
import { WorkVisit } from "@/components/tech/WorkVisit";
import { setDisplayTimeZone } from "@/lib/format";
import { activeStore, activeTenant, allInspections, allOps, sameTenant, storeFor, type CachedRoute, type KnownTenant, type LocalInspection } from "@/lib/offline/db";
import { assumingOffline, locate, fetchInspectionForJob, fetchMe, loadActiveTemplate, loadPumpingField, loadRoute, loadWorkRoute } from "@/lib/offline/data";
import { retryFailed, startBackgroundSync, subscribe, syncNow, unsentFor, type SyncState } from "@/lib/offline/sync";
import { endServerSession, noteSignOut, openTechSession, signOutOnPhone, type EndedAccess } from "@/lib/offline/tenant";
import { saveOrReport } from "@/lib/offline/storage";
import { flushUnsaved } from "@/lib/offline/unsaved";
import { workStoreFor, type LocalWork } from "@/lib/offline/work";
import type { Me } from "@/lib/session";

type View = { name: "list" } | { name: "stop"; jobId: string } | { name: "inspect"; jobId: string } | { name: "work"; jobId: string } | { name: "disposal" };

// Each screen has its own address and history entry, so the phone's Back gesture (which closes an
// installed app opened at its first entry) steps from a form to its stop to the list, as ‹ Back
// does, and a reload opens the same screen again. ?jobId= is also what links from the office use.
const LIST: View = { name: "list" };
type Entry = { techView: View };
const viewOfEntry = (state: unknown): View | undefined => (state as Partial<Entry> | null)?.techView;
const sameView = (a: View, b: View) => a.name === b.name && ("jobId" in a ? a.jobId : null) === ("jobId" in b ? b.jobId : null);

function urlOf(v: View): string {
  switch (v.name) {
    case "list":
      return "/tech";
    case "disposal":
      return "/tech?mode=disposal";
    case "stop":
      return `/tech?jobId=${encodeURIComponent(v.jobId)}`;
    default:
      return `/tech?jobId=${encodeURIComponent(v.jobId)}&mode=${v.name}`;
  }
}

function viewInUrl(search: string): View {
  const q = new URLSearchParams(search);
  const jobId = q.get("jobId");
  const mode = q.get("mode");
  if (mode === "disposal") return { name: "disposal" };
  if (!jobId) return LIST;
  if (mode === "inspect" || mode === "work") return { name: mode, jobId };
  return { name: "stop", jobId };
}

/** The screens from the list to this one, one step each: what Back walks back through. */
const pathTo = (v: View): View[] => (v.name === "list" ? [LIST] : v.name === "inspect" ? [LIST, { name: "stop", jobId: v.jobId }, v] : [LIST, v]);
const depthOf = (v: View) => pathTo(v).length - 1;

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

/** The server's copy of an inspection as this phone's draft: its answers, issues and already-uploaded photos, under the same id. */
function adoptInspection(server: Inspection): LocalInspection {
  return {
    clientId: server.clientId,
    jobId: server.jobId,
    templateId: server.templateId,
    status: server.status,
    arrivedAt: server.arrivedAt,
    completedAt: server.completedAt,
    arrivalGps: server.arrivalLat !== null && server.arrivalLng !== null ? { lat: server.arrivalLat, lng: server.arrivalLng } : null,
    completionGps: null,
    locationStatus: server.locationStatus,
    accessIssue: server.accessIssue,
    values: server.values,
    issues: server.issues.map(({ clientId, type, severity, description }) => ({ clientId, type, severity, description })),
    photos: server.photos.map((p) => ({ clientId: p.clientId, photoKey: p.photoKey, capturedAt: p.capturedAt ?? server.arrivedAt, lat: p.lat, lng: p.lng, uploaded: true, url: p.url })),
    server: { id: server.id, status: server.status, validationStatus: server.validationStatus, problems: server.validationProblems },
  };
}

/** Signed out with changes still on the phone: whose they are and how many, and nothing else. */
type Locked = { name: string; pending: number };

export default function TechApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [route, setRoute] = useState<Omit<CachedRoute, "fetchedAt"> | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | undefined>();
  const [template, setTemplate] = useState<InspectionTemplate | undefined>();
  const [inspections, setInspections] = useState<Map<string, LocalInspection>>(new Map());
  const [failures, setFailures] = useState<string[]>([]);
  /** Why a stop could not be opened just now (an inspection started on another phone, with no signal to fetch it). */
  const startingJobs = useRef(new Set<string>());
  const [starting, setStarting] = useState<Set<string>>(new Set());
  const [startNotice, setStartNotice] = useState<string | null>(null);
  // Work visits (SW-2): empty unless field work is switched on and the office scheduled some.
  const [workStops, setWorkStops] = useState<WorkStop[]>([]);
  const [works, setWorks] = useState<Map<string, LocalWork>>(new Map());
  const [failedWork, setFailedWork] = useState<Set<string>>(new Set());
  // SW-6: trucks, facilities and pump-outs in no load; undefined unless pumping is on.
  const [pumpingField, setPumpingField] = useState<PumpingFieldData | undefined>();
  const [sync, setSync] = useState<SyncState>({ kind: "idle", pending: 0, failed: 0 });
  const [view, setView] = useState<View>(LIST);
  // The screen on show, for callbacks that finish after the technician may have moved on.
  const viewRef = useRef<View>(LIST);
  // Where the list was scrolled to when a stop was opened from it.
  const listScroll = useRef(0);
  // A step back under way (the browser answers it a moment later): a second tap waits for it
  // instead of going back past the screen it lands on.
  const stepping = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [steppingBack, setSteppingBack] = useState(false);
  const stepped = useCallback(() => {
    if (stepping.current) clearTimeout(stepping.current);
    stepping.current = null;
    setSteppingBack(false);
  }, []);
  // List or map of the route; kept while a stop is open, so Back returns to the same one.
  const [routeView, setRouteView] = useState<RouteView>("list");
  const [loading, setLoading] = useState(true);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [locked, setLocked] = useState<Locked | null>(null);
  // A demo company that ended: its data was removed from the phone and nothing of it shows.
  const [ended, setEnded] = useState<EndedAccess | null>(null);
  const [endedElsewhere, setEndedElsewhere] = useState<EndedAccess[]>([]);
  const [others, setOthers] = useState<{ tenant: KnownTenant; pending: number }[]>([]);

  const show = useCallback((next: View) => {
    if (viewRef.current.name === "list" && next.name !== "list") listScroll.current = window.scrollY;
    viewRef.current = next;
    setView(next);
  }, []);

  /** Opens a screen one step on: the phone's Back, or ‹ Back, comes back here. */
  const open = useCallback(
    (next: View) => {
      // A second tap on the same stop, before the list has gone, adds no second entry to step back through.
      if (sameView(next, viewRef.current)) return;
      window.history.pushState({ techView: next } satisfies Entry, "", urlOf(next));
      show(next);
    },
    [show],
  );

  /** Steps back to a screen on the way here (the list, or the stop from its inspection), as Back does. */
  const backTo = useCallback(
    (target: View) => {
      if (stepping.current) return;
      const steps = depthOf(viewRef.current) - depthOf(target);
      const here = viewOfEntry(window.history.state);
      // The app put the entries under its own, so Back lands on them; otherwise this entry becomes the target.
      if (steps > 0 && here && sameView(here, viewRef.current)) {
        // Never stuck: an answer that does not come in a second frees the button again.
        stepping.current = setTimeout(stepped, 1000);
        setSteppingBack(true);
        window.history.go(-steps);
      } else {
        window.history.replaceState({ techView: target } satisfies Entry, "", urlOf(target));
        show(target);
      }
    },
    [show, stepped],
  );

  useEffect(() => {
    const before = window.history.scrollRestoration;
    // Each screen's scroll is put back by the app once it has drawn it (below), not by the browser.
    window.history.scrollRestoration = "manual";
    const onPop = (e: PopStateEvent) => {
      stepped();
      const next = viewOfEntry(e.state) ?? viewInUrl(window.location.search);
      if (!sameView(next, viewRef.current)) show(next);
    };
    window.addEventListener("popstate", onPop);
    // A section link scrolls to its section without a history entry of its own, so one Back still leaves the form.
    const onClick = (e: MouseEvent) => {
      const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href^="#"]') : null;
      const target = link && document.getElementById(decodeURIComponent(link.hash.slice(1)));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ block: "start" });
    };
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
      window.history.scrollRestoration = before;
    };
  }, [show, stepped]);

  // Every screen opens at its top; the list comes back where it was left.
  useLayoutEffect(() => {
    window.scrollTo(0, view.name === "list" ? listScroll.current : 0);
  }, [view]);

  const refreshLocal = useCallback(async () => {
    const tenant = activeTenant();
    if (!tenant) return;
    const work = workStoreFor(tenant);
    // Uploads the server's completion shows were delivered read as sent, even where an earlier version lost the mark.
    await Promise.all([storeFor(tenant).reconcileSent(), work.reconcileSent()]).catch(() => {});
    const [insp, ops, recs, workOps] = await Promise.all([allInspections(), allOps(), work.allRecords(), work.allOps()]);
    setInspections(new Map(insp.map((i) => [i.jobId, i])));
    setWorks(new Map(recs.map((r) => [r.jobId, r])));
    const failedOps = workOps.filter((o) => o.failed);
    setFailedWork(new Set(failedOps.map((o) => o.recordClientId!)));
    setFailures([...ops, ...failedOps].filter((o) => o.failed).map((o) => o.failed!));
  }, []);

  /** Nothing of the last sign-in on screen: an ended demo, or signed out (with what waits, if anything). */
  const clearScreen = useCallback(
    (next: { ended?: EndedAccess; locked?: Locked }) => {
      setEnded(next.ended ?? null);
      setLocked(next.locked ?? null);
      setMe(null);
      setRoute(null);
      setTemplate(undefined);
      setInspections(new Map());
      setFailures([]);
      setWorkStops([]);
      setWorks(new Map());
      setPumpingField(undefined);
      setOthers([]);
      setNeedsSignIn(false);
      show(LIST);
    },
    [show],
  );

  const refresh = useCallback(async () => {
    // An open form's last answers are saved on the phone before anything is counted, kept or locked.
    await flushUnsaved();
    const session = await openTechSession();
    if (session.kind === "ended") {
      clearScreen({ ended: session.ended });
      setLoading(false);
      return;
    }
    if (session.kind === "locked") {
      clearScreen({ locked: { name: session.tenant.userName, pending: session.pending } });
      setLoading(false);
      return;
    }
    if (session.kind === "none" || !session.me) {
      if (session.kind === "none" && session.reason === "signed_out") {
        window.location.href = "/login?next=/tech";
        return;
      }
      // Nothing saved on this phone: the screen asks for a sign-in with signal.
      clearScreen({});
      setLoading(false);
      return;
    }
    setEnded(null);
    setLocked(null);
    setNeedsSignIn(false);
    setOthers(session.kind === "signed_in" ? session.others : []);
    if (session.kind === "signed_in" && session.ended.length > 0) setEndedElsewhere(session.ended);
    const m = session.me;
    setDisplayTimeZone(m.organization.timezone);
    setMe(m);
    const store = activeStore();
    const work = workStoreFor(store.tenant);
    // No signal (or a connection that answers nothing): open the phone's copies at once rather
    // than waiting out a timeout on each of the day's reads in turn.
    const load = async () => {
      const [r, t, w] = await Promise.all([loadRoute(store), loadActiveTemplate(store), loadWorkRoute(work)]);
      const p = await loadPumpingField(work, !!w?.items.some((s) => s.requiresDisposalRecord));
      return { r, t, w, p };
    };
    const { r, t, w, p } = session.kind === "cached" && session.reason === "offline" ? await assumingOffline(load) : await load();
    setPumpingField(p);
    setRoute(r.route ?? null);
    setWorkStops(w?.items ?? []);
    setFetchedAt(r.fetchedAt);
    setTemplate(t);
    await refreshLocal();
    setLoading(false);
    void syncNow();
  }, [refreshLocal, clearScreen]);

  // "Sign in again" is only ever a past answer: a send refused under an earlier sign-in, or a page
  // the phone kept from before a sign-out and shows again on Back or Forward (Android's
  // back/forward cache restores it as it was, with no new load). Whenever the page is shown again,
  // or comes back to the front while it still asks for a sign-in, the server is asked again; a valid
  // session clears the banner, switches to whoever is signed in now and sends what waits.
  const needsSignInRef = useRef(false);
  useEffect(() => {
    needsSignInRef.current = needsSignIn || !!locked;
  }, [needsSignIn, locked]);
  const checking = useRef(false);
  const recheck = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      await refresh();
    } finally {
      checking.current = false;
    }
  }, [refresh]);

  // A send was refused. A session the server no longer has (expired, ended, the person
  // deactivated) locks the screen, or clears an ended demo; one it still has leaves the banner, with Try now.
  const onRefused = useCallback(async () => {
    const res = await fetchMe();
    if (!res.ok && res.reason === "signed_out") await recheck();
    else setNeedsSignIn(true);
  }, [recheck]);

  useEffect(() => {
    registerServiceWorker();
    startBackgroundSync();
    // Opened only after the sign-in is known, so nothing of another sign-in is ever read.
    void refresh();
    return subscribe((s) => {
      setSync(s);
      if (s.kind === "signed_out") void onRefused();
      // The phone is signed in as someone else now: switch to them; these changes wait.
      if (s.kind === "other_account") void refresh();
      void refreshLocal();
    });
  }, [refresh, refreshLocal, onRefused]);

  // Opened at an address (a link from the office, a reload): once the route is known, that screen
  // opens, with the screens on the way to it under it.
  const placed = useRef(false);
  useEffect(() => {
    if (loading || placed.current || !me) return;
    placed.current = true;
    const saved = viewOfEntry(window.history.state);
    const asked = saved ?? viewInUrl(window.location.search);
    const onRoute = (jobId: string) => route?.items.some((s) => s.jobId === jobId) || !!inspections.get(jobId)?.stopSnapshot;
    let target: View = LIST;
    if (asked.name === "disposal") target = asked;
    else if (asked.name !== "list") {
      if (workStops.some((s) => s.jobId === asked.jobId)) target = { name: "work", jobId: asked.jobId };
      else if (asked.name !== "work" && onRoute(asked.jobId)) target = asked.name === "inspect" && inspections.has(asked.jobId) ? asked : { name: "stop", jobId: asked.jobId };
      else setStartNotice("The linked visit is not on this account’s current route. Refresh with signal or ask the office for the current visit.");
    }
    if (!saved) {
      const [first = LIST, ...rest] = pathTo(target);
      window.history.replaceState({ techView: first } satisfies Entry, "", urlOf(first));
      for (const v of rest) window.history.pushState({ techView: v } satisfies Entry, "", urlOf(v));
    } else if (!sameView(saved, target)) window.history.replaceState({ techView: target } satisfies Entry, "", urlOf(target));
    if (target.name !== "list") show(target);
  }, [loading, me, route, workStops, inspections, show]);

  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) void recheck();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (needsSignInRef.current) void recheck();
      // Picked up again: a session that ended meanwhile (the person deactivated, signed out
      // elsewhere, expired) clears the screen now, not at the next start.
      else if (activeTenant())
        void fetchMe().then((res) => {
          if (!res.ok && res.reason === "signed_out") void recheck();
        });
    };
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [recheck]);

  async function startingJob(jobId: string, fn: () => Promise<void>) {
    if (startingJobs.current.has(jobId)) return;
    startingJobs.current.add(jobId);
    setStarting(new Set(startingJobs.current));
    setStartNotice(null);
    try { await fn(); }
    catch (err) { setStartNotice(err instanceof Error ? err.message : "Could not save this visit on the phone. Try again."); }
    finally { startingJobs.current.delete(jobId); setStarting(new Set(startingJobs.current)); }
  }

  async function refreshPhotoLinks(jobId: string): Promise<boolean> {
    const store = activeStore();
    if (!navigator.onLine) return false;
    const local = await store.getInspection(jobId);
    if (!local) return false;
    const fetched = await fetchInspectionForJob(jobId, store.tenant);
    if (!fetched.ok || fetched.data.clientId !== local.clientId || !sameTenant(activeTenant(), store.tenant)) return false;
    // Metadata-only update in a transaction reads the newest draft; no downloaded answer replaces local work.
    await store.refreshPhotoUrls(jobId, local.clientId, fetched.data.photos);
    if (!sameTenant(activeTenant(), store.tenant)) return false;
    await refreshLocal();
    return true;
  }

  async function start(stop: Stop) {
    if (!template && !inspections.has(stop.jobId)) return;
    const store = activeStore();
    await startingJob(stop.jobId, async () => {
      const existing = await store.getInspection(stop.jobId);
      if (!existing) {
        let insp: LocalInspection;
        if (stop.inspection) {
          const fetched = await fetchInspectionForJob(stop.jobId, store.tenant);
          if (!fetched.ok) {
            setStartNotice("Open this stop with signal to download its recorded inspection. Your saved work stays on this phone.");
            return;
          }
          insp = { ...adoptInspection(fetched.data), stopSnapshot: stop };
        } else {
          const arrival = await locate();
          insp = { clientId: crypto.randomUUID(), jobId: stop.jobId, stopSnapshot: stop, templateId: template!.id, status: "draft", arrivedAt: new Date().toISOString(), completedAt: null,
            arrivalGps: arrival.gps, completionGps: null, locationStatus: arrival.status, accessIssue: null, values: {}, issues: [], photos: [], server: null };
        }
        // Atomic recheck after every network/location wait; never replace an existing draft.
        if (!sameTenant(activeTenant(), store.tenant)) return;
        await saveOrReport(() => store.ensureInspection(insp));
      }
      if (existing?.photos.some(p => p.uploaded && !p.preview) && navigator.onLine) await refreshPhotoLinks(stop.jobId).catch(() => false);
      if (!sameTenant(activeTenant(), store.tenant)) return;
      await refreshLocal();
      void syncNow();
      // Only if the technician is still on this stop.
      const current = viewRef.current;
      if (current.name === "stop" && current.jobId === stop.jobId) open({ name: "inspect", jobId: stop.jobId });
    });
  }

  async function startWork(stop: WorkStop) {
    const tenant = activeTenant();
    if (!tenant || !stop.templateId) return;
    const store = workStoreFor(tenant);
    await startingJob(stop.jobId, async () => {
      if (!(await store.allRecords()).some(r => r.jobId === stop.jobId)) {
        const arrival = await locate();
        const rec: LocalWork = {
          clientId: crypto.randomUUID(), jobId: stop.jobId, templateId: stop.templateId!, label: { title: `${stop.workOrderLabel} · ${stop.title}`, customerName: stop.customerName, address: stop.address },
          status: "draft", revision: 0, arrivedAt: new Date().toISOString(), completedAt: null, arrivalGps: arrival.gps, completionGps: null, locationStatus: arrival.status,
          values: {}, finalVisit: true, summary: null, photos: [], signatures: [], draftAckedAt: null, server: null, held: null, resolved: null,
        };
        if (!sameTenant(activeTenant(), tenant)) return;
        await saveOrReport(() => store.ensureWork(rec));
      }
      if (!sameTenant(activeTenant(), tenant)) return;
      await refreshLocal();
      void syncNow();
    });
  }

  const signingOut = useRef(false);
  async function signOut() {
    if (signingOut.current) return;
    signingOut.current = true;
    try {
      const tenant = activeTenant();
      // The open form's last answers are saved first, so they are counted and kept.
      await flushUnsaved();
      const { unsent: runnable, later } = tenant ? await unsentFor(tenant) : { unsent: 0, later: 0 };
      const unsent = `Some changes have not reached the office yet.${later > 0 ? ` ${later} of them will send only after the app updates.` : ""}`;
      if (runnable + later > 0 && !window.confirm(`${unsent} Sign out anyway? They stay on this phone and send when you sign in again.`)) return;
      // Noted first: if the phone has no signal (or the page goes), the next start ends the session.
      noteSignOut();
      // From here nothing of this sign-in is readable on the phone; what waits to send stays for the same person.
      const pending = tenant ? await signOutOnPhone(tenant) : 0;
      // Drawn before leaving, so Back to this page (kept as it was by the phone) shows none of it either.
      flushSync(() => clearScreen({ locked: pending > 0 && tenant ? { name: tenant.userName, pending } : undefined }));
      // With no signal the card stays, and the next start ends the session.
      if (await endServerSession()) window.location.href = "/login?next=/tech";
    } finally {
      signingOut.current = false;
    }
  }

  // One store object per sign-in, so the work form does not reload on every render.
  const tenant = activeTenant();
  const workStore = useMemo(() => (tenant ? workStoreFor(tenant) : null), [tenant]);
  // Inspections and work visits in one visit order, numbered alike in the lists and on the map.
  const numbers = useMemo(() => routeNumbers(routeOrder(route, workStops)), [route, workStops]);
  const work = useMemo(
    () => ({
      stops: workStops,
      done: (jobId: string) => {
        const s = workStops.find((w) => w.jobId === jobId);
        const rec = works.get(jobId);
        return !!s && workStatus(s.record, rec, !!rec && failedWork.has(rec.clientId)).tone === "ok";
      },
    }),
    [workStops, works, failedWork],
  );

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

  // Signed out, or nothing saved on this phone: no route, no customers, nothing to start.
  if (!me) {
    return (
      <main className="tech-page">
        <div className="card stack" role="status" data-testid="signed-out">
          {locked ? (
            <>
              <h1>Signed out</h1>
              <p>
                {plural(locked.pending, "change")} for {locked.name || "the last person signed in"} {locked.pending === 1 ? "is" : "are"} waiting on this phone. Sign in to
                send {locked.pending === 1 ? "it" : "them"}.
              </p>
            </>
          ) : (
            <>
              <h1>Sign in</h1>
              <p>Sign in with signal to download your route to this phone.</p>
            </>
          )}
          <a className="button" href="/login?next=/tech">
            Sign in
          </a>
        </div>
      </main>
    );
  }

  // A reload can name an inspection this phone no longer holds: its stop opens instead.
  const shown: View = view.name === "inspect" && !inspections.has(view.jobId) ? { name: "stop", jobId: view.jobId } : view;
  const stop = shown.name === "stop" || shown.name === "inspect" ? (route?.items.find((s) => s.jobId === shown.jobId) ?? inspections.get(shown.jobId)?.stopSnapshot) : undefined;
  const workStop = shown.name === "work" ? workStops.find((s) => s.jobId === shown.jobId) : undefined;

  return (
    <>
      <header className="tech-bar">
        {shown.name === "list" ? (
          <strong>Aerowise</strong>
        ) : (
          <button className="link back" disabled={steppingBack} onClick={() => backTo(shown.name === "inspect" ? { name: "stop", jobId: shown.jobId } : LIST)}>
            ‹ Back
          </button>
        )}
        <span className="spacer" />
        <span className="muted small">{me.user.name}</span>
        {/* Owners and office staff who do their own visits get back to the office screens from here. */}
        {(me.role === "owner" || me.role === "office") && (
          <a className="small" href="/inbox">
            Office
          </a>
        )}
        <button className="link small" onClick={signOut}>
          Sign out
        </button>
      </header>
      <SyncBanner state={sync} failures={failures} needsSignIn={needsSignIn} onRetry={() => void (needsSignIn ? recheck() : syncNow())} onRetryFailed={() => void retryFailed().then(refreshLocal)} />
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
        {shown.name === "list" && <IntroCard intro="technician" me={me} />}
        {shown.name === "list" && startNotice && <p className="card warn" role="status">{startNotice}</p>}
        {shown.name === "list" && (
          <StopList
            route={route}
            fetchedAt={fetchedAt}
            inspections={inspections}
            onOpen={(jobId) => open(workStops.some((w) => w.jobId === jobId) ? { name: "work", jobId } : { name: "stop", jobId })}
            onRefresh={() => void refresh()}
            view={routeView}
            onView={setRouteView}
            work={work}
            numbers={numbers}
          />
        )}
        {shown.name === "list" && <WorkStopList routeDate={route?.date} stops={workStops} records={works} failedRecords={failedWork} numbers={numbers} onOpen={(jobId) => open({ name: "work", jobId })} />}
        {shown.name === "list" && [...inspections.values()].some(i => i.stopSnapshot && !route?.items.some(s => s.jobId === i.jobId)) && <section className="stack"><h2>Inspections kept on this phone</h2>{[...inspections.values()].filter(i => i.stopSnapshot && !route?.items.some(s => s.jobId === i.jobId)).map(i => <button key={i.clientId} className="secondary" onClick={() => open({ name: "stop", jobId: i.jobId })}>{i.stopSnapshot!.customer.displayName} · {i.held ? "Held for the office" : i.status === "completed" ? "Completed inspection" : "Saved inspection"}</button>)}</section>}
        {/* Off on the server, /pumping/field answers empty lists: nothing to record a disposal with yet. */}
        {shown.name === "list" && pumpingField && (pumpingField.facilities.length > 0 || pumpingField.unloaded.length > 0) && (
          <button className="secondary" data-testid="open-disposal" onClick={() => open({ name: "disposal" })}>
            Record disposal
            {pumpingField.unloaded.length > 0 && ` (${plural(pumpingField.unloaded.length, "pump-out")} waiting)`}
          </button>
        )}
        {shown.name === "disposal" && workStore && (
          <DisposalScreen
            store={workStore}
            field={pumpingField}
            onDone={() => {
              void refreshLocal();
              void syncNow();
              backTo(LIST);
            }}
          />
        )}
        {shown.name === "work" && workStop && workStore && (
          <WorkVisit
            stop={workStop}
            store={workStore}
            record={works.get(workStop.jobId)}
            failed={!!works.get(workStop.jobId) && failedWork.has(works.get(workStop.jobId)!.clientId)}
            starting={starting.has(workStop.jobId)}
            notice={startNotice}
            onStart={() => void startWork(workStop)}
            onSaved={() => {
              void refreshLocal();
              void syncNow();
            }}
            onFinished={() => {
              void refreshLocal();
              void syncNow();
              backTo(LIST);
            }}
          />
        )}
        {shown.name === "stop" && stop && (
          <StopDetail
            stop={stop}
            inspection={inspections.get(stop.jobId)}
            canStart={!!template || inspections.has(stop.jobId)}
            starting={starting.has(stop.jobId)}
            onStart={() => void start(stop)}
            notice={startNotice}
            onTheWayTexts={route?.onTheWayTexts}
          />
        )}
        {shown.name === "inspect" && stop && inspections.get(stop.jobId) && (
          <InspectionForm
            key={stop.jobId}
            stop={stop}
            initial={inspections.get(stop.jobId)!}
            onRefreshPhotos={() => refreshPhotoLinks(stop.jobId)}
            onSaved={() => {
              void refreshLocal();
              void syncNow();
            }}
            onFinished={() => {
              void refreshLocal();
              backTo(LIST);
            }}
          />
        )}
        {shown.name !== "list" && shown.name !== "disposal" && !stop && !workStop && <p className="muted">This stop is no longer on your route.</p>}
      </main>
    </>
  );
}
