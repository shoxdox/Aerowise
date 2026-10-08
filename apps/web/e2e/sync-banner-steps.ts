import type { Page } from "@playwright/test";

// Shared steps for checking the phone's send banner tells the truth (sync-banner.spec, pumping.spec).

type Win = { releaseOutbox?: () => void; bannerHistory?: (string | null)[] };

/** Another tab is sending: it takes the outbox lock every send needs and keeps it until released. */
export function holdOutbox(page: Page) {
  return page.evaluate(
    () =>
      new Promise<void>((acquired) => {
        void navigator.locks.request("aerowise-outbox", () => {
          acquired();
          return new Promise<void>((release) => ((window as unknown as Win).releaseOutbox = release));
        });
      }),
  );
}

export function releaseOutbox(page: Page) {
  return page.evaluate(() => (window as unknown as Win).releaseOutbox!());
}

/** Records every text the banner shows from now on (until the page reloads). */
export function watchBanner(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as Win;
    const seen: (string | null)[] = [];
    w.bannerHistory = seen;
    const read = () => {
      const text = document.querySelector('[data-testid="sync-status"]')?.textContent ?? null;
      if (seen[seen.length - 1] !== text) seen.push(text);
    };
    read();
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

export function bannerHistory(page: Page) {
  return page.evaluate(() => [...((window as unknown as Win).bannerHistory ?? [])]);
}

/** How many changes wait in the work outbox on the phone. */
export function workOutboxCount(page: Page) {
  return page.evaluate(async () => {
    const name = (await indexedDB.databases()).map((d) => d.name ?? "").find((n) => n.startsWith("aerowise-tech-work:"));
    if (!name) return 0;
    const idb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const req = idb.transaction(["outbox"], "readonly").objectStore("outbox").count();
    const n = await new Promise<number>((r) => (req.onsuccess = () => r(req.result)));
    idb.close();
    return n;
  });
}
