// Aerowise technician app service worker.
//
// Keeps the app itself (the /tech page and its scripts and styles) available without
// signal. It never touches /api: the app stores its data in IndexedDB and queues changes
// in its own outbox, so API requests always go straight to the network.

const CACHE = "aerowise-shell-v1";
const SHELL = "/tech";
/** How long to wait for a fresh copy of the app before opening the cached one. */
const SHELL_FETCH_TIMEOUT_MS = 8000;

function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const res = await fetch(SHELL, { cache: "reload" });
      if (res.ok) {
        await cache.put(SHELL, res.clone());
        // Pre-cache the scripts and styles the page references.
        const html = await res.text();
        const assets = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]);
        await Promise.all([...new Set(assets)].map((url) => cache.add(url).catch(() => {})));
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// The page tells us which assets it actually loaded (including ones fetched before this
// worker was in control), so they are cached too.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "cache-assets") return;
  const urls = (event.data.urls || []).filter((u) => typeof u === "string" && new URL(u, self.location.origin).pathname.startsWith("/_next/static/"));
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(urls.map(async (u) => ((await cache.match(u)) ? null : cache.add(u).catch(() => {}))))));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // The app page: network first so updates arrive, the cached copy when offline or when the
  // network answers nothing for a while (one bar of signal keeps a socket open for a minute
  // or more before it fails; the technician should not wait on it).
  if (req.mode === "navigate" && (url.pathname === SHELL || url.pathname.startsWith(SHELL + "/"))) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(SHELL);
        try {
          const res = await fetch(req, cached ? { signal: timeoutSignal(SHELL_FETCH_TIMEOUT_MS) } : {});
          if (res.ok) (await caches.open(CACHE)).put(SHELL, res.clone());
          return res;
        } catch {
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // Build assets have content hashes in their names, so a cached copy is always right.
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
        return res;
      })(),
    );
  }
});
