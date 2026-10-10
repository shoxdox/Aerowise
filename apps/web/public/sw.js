// Aerowise technician app service worker.
//
// Keeps the app itself (the /tech page and its scripts and styles) available without
// signal. It never touches /api: the app stores its data in IndexedDB and queues changes
// in its own outbox, so API requests always go straight to the network.

const CACHE = "aerowise-shell-v1";
const SHELL = "/tech";
/** How long to wait for a fresh copy of the app before opening the cached one. */
const SHELL_FETCH_TIMEOUT_MS = 8000;
/**
 * Build assets have content hashes in their names, so every deploy leaves the last build's
 * chunks behind in the cache. A record of when each cached asset was last used (a JSON entry
 * in the same cache) lets a new shell prune what it no longer references and nothing has
 * asked for in a week; a chunk the page loaded lazily and reported is kept while it is used.
 */
const USAGE_KEY = "/__aerowise/asset-usage";
const KEEP_UNUSED_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 60 * 1000;
const ASSET_PREFIX = "/_next/static/";

async function readUsage(cache) {
  const res = await cache.match(USAGE_KEY);
  if (!res) return {};
  try {
    return (await res.json()) || {};
  } catch {
    return {};
  }
}
const writeUsage = (cache, usage) => cache.put(USAGE_KEY, new Response(JSON.stringify(usage), { headers: { "content-type": "application/json" } }));
const pathOf = (url) => new URL(url, self.location.origin).pathname;

/** Records that these assets are in use now. */
async function touch(cache, urls) {
  const usage = await readUsage(cache);
  const now = Date.now();
  let changed = false;
  for (const u of urls) {
    const p = pathOf(u);
    if (!p.startsWith(ASSET_PREFIX)) continue;
    if (!usage[p] || now - usage[p] > TOUCH_EVERY_MS) {
      usage[p] = now;
      changed = true;
    }
  }
  if (changed) await writeUsage(cache, usage);
}

/** The build assets a copy of the shell references. */
const assetsIn = (html) => [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]))];

/**
 * Drops cached build assets the fresh shell does not reference and nothing has used in a
 * week. Assets the shell references are touched, so a page that stayed open through several
 * deploys is still complete offline.
 */
async function prune(cache, shellAssets) {
  const usage = await readUsage(cache);
  const now = Date.now();
  const current = new Set(shellAssets.map(pathOf));
  for (const p of current) usage[p] = now;
  for (const req of await cache.keys()) {
    const p = pathOf(req.url);
    if (!p.startsWith(ASSET_PREFIX) || current.has(p)) continue;
    const last = usage[p] || 0;
    if (now - last > KEEP_UNUSED_MS) {
      await cache.delete(req);
      delete usage[p];
    }
  }
  for (const p of Object.keys(usage)) if (!(await cache.match(p))) delete usage[p];
  await writeUsage(cache, usage);
}

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
        // Pre-cache the scripts and styles the page references, and let go of a previous build's.
        const assets = assetsIn(await res.text());
        await Promise.all(assets.map((url) => cache.add(url).catch(() => {})));
        await prune(cache, assets);
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
  const urls = (event.data.urls || []).filter((u) => typeof u === "string" && pathOf(u).startsWith(ASSET_PREFIX));
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(urls.map(async (u) => ((await cache.match(u)) ? null : cache.add(u).catch(() => {}))));
      await touch(cache, urls);
    }),
  );
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
          if (res.ok) {
            const cache = await caches.open(CACHE);
            await cache.put(SHELL, res.clone());
            // A new build: cache what it references and prune what no build has used for a week.
            event.waitUntil(res.clone().text().then(async (html) => {
              const assets = assetsIn(html);
              await Promise.all(assets.map((url) => cache.add(url).catch(() => {})));
              await prune(cache, assets);
            }).catch(() => {}));
          }
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
        if (cached) {
          if (url.pathname.startsWith(ASSET_PREFIX)) event.waitUntil(caches.open(CACHE).then((cache) => touch(cache, [req.url])));
          return cached;
        }
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(req, res.clone());
          if (url.pathname.startsWith(ASSET_PREFIX)) event.waitUntil(touch(cache, [req.url]));
        }
        return res;
      })(),
    );
  }
});
