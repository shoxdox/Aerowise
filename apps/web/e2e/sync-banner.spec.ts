import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import pg from "pg";

// The phone's banner never says "All changes sent" while something saved is still queued. Here
// another tab holds the outbox (the lock every send takes), so the phone's own pass cannot count
// the new change yet: the banner must not keep the earlier "All changes sent". Pixel 7 emulation.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });

async function office(browser: Browser): Promise<APIRequestContext> {
  const request = (await browser.newContext()).request;
  expect((await request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return request;
}

test("a change saved while sending is held up is never shown as sent until it is", async ({ page, browser }) => {
  const api = await office(browser);
  const title = `Banner check ${Date.now()}`;
  const types = (await (await api.get("/api/work-types")).json()).items as { id: string; key: string }[];
  const site = (await (await api.get("/api/sites?limit=1")).json()).items[0] as { id: string };
  const techs = (await (await api.get("/api/technicians")).json()).items as { id: string; name: string }[];
  const { today } = await (await api.get("/api/obligations/due?limit=1")).json();
  const wo = await (await api.post("/api/work-orders", { data: { siteId: site.id, workTypeId: types.find((t) => t.key === "repair")!.id, title } })).json();
  const scheduled = await api.post(`/api/work-orders/${wo.id}/schedule`, { data: { technicianId: techs.find((t) => t.name === "Tess Tech")!.id, scheduledDate: today } });
  expect(scheduled.status()).toBe(201);
  const jobId = (await scheduled.json()).visits[0].jobId as string;
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await page.goto("/login");
    await page.getByLabel("Email").fill("tech@example.com");
    await page.getByLabel("Password").fill("aerowise-dev");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/tech");
    const banner = page.getByTestId("sync-status");
    await expect(banner).toHaveText("All changes sent");

    // Another tab is sending: it holds the outbox until released.
    await page.evaluate(
      () =>
        new Promise<void>((acquired) => {
          void navigator.locks.request("aerowise-outbox", () => {
            acquired();
            return new Promise<void>((release) => ((window as unknown as { releaseOutbox: () => void }).releaseOutbox = release));
          });
        }),
    );
    await page.locator(".work-card", { hasText: title }).click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    // The arrival is saved and queued; nothing has sent it.
    await expect
      .poll(() =>
        page.evaluate(async () => {
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
        }),
      )
      .toBe(1);
    expect((await db.query("select count(*)::int as n from work_records where job_id = $1", [jobId])).rows[0].n).toBe(0);
    await expect(banner).not.toHaveText("All changes sent");
    await expect(banner).toHaveText("Checking for changes to send…");

    // Once the other tab lets go, the phone sends it, and only then says so.
    await page.evaluate(() => (window as unknown as { releaseOutbox: () => void }).releaseOutbox());
    await expect(banner).toHaveText("All changes sent", { timeout: 30_000 });
    expect((await db.query("select count(*)::int as n from work_records where job_id = $1", [jobId])).rows[0].n).toBe(1);
  } finally {
    await api.post(`/api/work-orders/${wo.id}/cancel`, { data: { reason: "e2e cleanup" } });
    await db.query("update jobs set scheduled_date = scheduled_date - 1 where work_order_id = $1", [wo.id]);
    await db.end();
  }
});
