import { expect, test, type Page, type Route } from "@playwright/test";
import pg from "pg";

// The street map on the office schedule and in the technician app. The e2e web server serves the
// small synthetic map fixture (MAP_TILES_FILE), and the API runs in demo mode.

const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const ORIGIN = "http://localhost:3000";

async function signIn(page: Page, email: string, landing: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`**${landing}`);
}

/** Every origin the page asks anything of, apart from in-page data. */
function watchOrigins(page: Page) {
  const origins = new Set<string>();
  page.on("request", (r) => {
    const url = r.url();
    if (!url.startsWith("data:") && !url.startsWith("blob:")) origins.add(new URL(url).origin);
  });
  return origins;
}

/** Holds every request for the map file unanswered (not failed) until released. */
async function holdMapData(page: Page) {
  const held: Route[] = [];
  await page.route("**/map-data/**", (route) => {
    held.push(route);
  });
  return {
    held,
    async release() {
      await page.unroute("**/map-data/**");
      for (const route of held) await route.continue().catch(() => {});
    },
  };
}

/** Errors thrown in the page. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function tomorrow(page: Page) {
  const { today } = await (await page.request.get("/api/obligations/due?limit=1")).json();
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Tess Tech's day tomorrow: four seeded inspections, and with work orders on, the demo story's
 * repair visit as a fifth stop.
 */
const tessColumn = (page: Page) => page.locator(".column", { has: page.getByRole("heading", { name: "Tess Tech" }) });
const tessStopCount = async (page: Page, date: string) =>
  ((await (await page.request.get(`/api/routing/day?date=${date}`)).json()).technicians as { technicianName: string; stops: unknown[] }[]).find((t) => t.technicianName === "Tess Tech")!.stops.length;

async function openDay(page: Page, date: string) {
  await page.goto("/schedule");
  await page.locator('input[type="date"]').fill(date);
  await expect(page.locator(".street-map")).toHaveAttribute("data-status", "ready");
}

test.describe("office schedule map", () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

  test("shows each route's numbered stops in its color, with details and a way to the site", async ({ page }) => {
    const origins = watchOrigins(page);
    await signIn(page, "owner@example.com", "/inbox");
    const date = await tomorrow(page);
    const day = await (await page.request.get(`/api/routing/day?date=${date}`)).json();
    await openDay(page, date);

    // The fixture's credit and the demo label are on the map.
    await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("Test map: synthetic streets, not real");
    await expect(page.locator(".map-chip")).toHaveText("Demo: made-up locations");
    await expect(page.getByText("they are straight lines, not roads")).toBeVisible();
    await expect(page.locator(".map-start")).toHaveCount(day.start ? 1 : 0);

    const column = tessColumn(page);
    const legend = await column.locator(".route-legend").evaluate((el) => getComputedStyle(el).backgroundColor);
    const listed = await column
      .locator(".card.tight")
      .evaluateAll((cards) => cards.map((c) => ({ n: c.querySelector(".stop-number")?.textContent, address: c.querySelector("strong")?.textContent })));
    const route = day.technicians.find((t: { technicianName: string }) => t.technicianName === "Tess Tech");
    const markers = page.locator(`.map-stop[data-route="${route.technicianId}"]`);
    await expect(markers).toHaveCount(route.stops.length);
    // Numbers, order, colors and done state match the list and the route.
    for (const [i, s] of (route.stops as { jobId: string; status: string }[]).entries()) {
      const marker = page.locator(`.map-stop[data-stop="${s.jobId}"]`);
      await expect(marker).toHaveText(listed[i]!.n!);
      await expect(marker).toHaveAttribute("aria-label", new RegExp(`stop ${i + 1}(, [A-Za-z ]+)?: ${listed[i]!.address}`));
      expect(await marker.evaluate((el) => getComputedStyle(el).getPropertyValue("--route").trim())).not.toBe("");
      const fill = await marker.evaluate((el) => getComputedStyle(el).backgroundColor);
      if (s.status === "completed") await expect(marker).toHaveClass(/done/);
      else expect(fill).toBe(legend);
    }
    // Selecting a stop shows its details and opens its site.
    await markers.nth(1).click();
    const detail = page.getByTestId("map-stop-detail");
    await expect(detail).toContainText(listed[1]!.address!);
    await expect(detail).toContainText("stop 2");
    await expect(detail).toContainText("estimate from straight-line distance, no traffic");
    await expect(markers.nth(1)).toHaveClass(/selected/);
    await detail.getByRole("link", { name: "Open site" }).click();
    await page.waitForURL("**/sites/*");

    // Nothing was asked of any other site: map code, tiles and fonts all come from this origin.
    expect([...origins]).toEqual([ORIGIN]);
  });

  test("lists stops it cannot place, flags stops outside the installed map and marks done ones", async ({ page }) => {
    const db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    await signIn(page, "owner@example.com", "/inbox");
    const date = await tomorrow(page);
    const day = await (await page.request.get(`/api/routing/day?date=${date}`)).json();
    const route = day.technicians.find((t: { technicianName: string }) => t.technicianName === "Tess Tech");
    const [first, second, third] = route.stops as { jobId: string; lat: number; lng: number; status: string }[];
    const site = async (jobId: string) => (await db.query("select site_id from jobs where id = $1", [jobId])).rows[0].site_id;
    const firstSite = await site(first!.jobId);
    const secondSite = await site(second!.jobId);
    const saved = (await db.query("select id, lat, lng, location_source from sites where id = any($1)", [[firstSite, secondSite]])).rows;
    try {
      await db.query("update sites set lat = null, lng = null, location_source = null where id = $1", [firstSite]);
      // Dallas: real coordinates, but outside the fixture's Central Texas box.
      await db.query("update sites set lat = 32.7767, lng = -96.797 where id = $1", [secondSite]);
      await db.query("update jobs set status = 'completed' where id = $1", [third!.jobId]);
      await openDay(page, date);
      await expect(page.locator(`.map-stop[data-stop="${third!.jobId}"]`)).toHaveClass(/done/);
      await expect(page.locator(`.map-stop[data-stop="${third!.jobId}"]`)).toHaveAttribute("aria-label", /stop 3: .*, done$/);
      await expect(page.getByTestId("map-unlocated")).toContainText("stop 1");
      await expect(page.getByTestId("map-outside")).toContainText("stop 2");
      await expect(page.locator(`.map-stop[data-route="${route.technicianId}"]`)).toHaveCount(route.stops.length - 1);
      await expect(page.locator(`.map-stop[data-stop="${second!.jobId}"]`)).toHaveAttribute("aria-label", /outside the street map/);
      // The list still has every stop, and says which one is not on the map.
      const column = tessColumn(page);
      await expect(column.locator(".card.tight")).toHaveCount(route.stops.length);
      await expect(column.getByText("Not on the map yet")).toHaveCount(1);
    } finally {
      await db.query("update jobs set status = $2 where id = $1", [third!.jobId, third!.status]);
      for (const r of saved) await db.query("update sites set lat = $2, lng = $3, location_source = $4 where id = $1", [r.id, r.lat, r.lng, r.location_source]);
      await db.end();
    }
  });

  test("keeps the schedule working when the map cannot load", async ({ page }) => {
    await page.route("**/map-data/**", (route) => route.abort());
    await signIn(page, "owner@example.com", "/inbox");
    const date = await tomorrow(page);
    await page.goto("/schedule");
    await page.locator('input[type="date"]').fill(date);
    await expect(page.getByTestId("map-unavailable")).toHaveText("The street map is not available right now. Every stop is still in the list.");
    const column = tessColumn(page);
    await expect(column.locator(".card.tight")).toHaveCount(await tessStopCount(page, date));
    await expect(column.getByRole("button", { name: "Optimize route" })).toBeEnabled();
  });

  test("gives up on a map file that never answers, and keeps the list", async ({ page }) => {
    const errors = watchErrors(page);
    const mapData = await holdMapData(page);
    await signIn(page, "owner@example.com", "/inbox");
    const date = await tomorrow(page);
    await page.goto("/schedule");
    await page.locator('input[type="date"]').fill(date);
    await expect(page.getByText("Loading map…")).toBeVisible();
    await expect.poll(() => mapData.held.length).toBeGreaterThan(0);
    // The start-up deadline (20 s) covers the map file's first answer, which never comes.
    await expect(page.getByTestId("map-unavailable")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText("Loading map…")).toHaveCount(0);
    await expect(page.locator(".maplibregl-map")).toHaveCount(0);
    const column = tessColumn(page);
    await expect(column.locator(".card.tight")).toHaveCount(await tessStopCount(page, date));
    await expect(column.getByRole("button", { name: "Optimize route" })).toBeEnabled();

    // The answer arriving late changes nothing.
    await mapData.release();
    await page.waitForTimeout(1_000);
    await expect(page.locator(".street-map")).toHaveAttribute("data-status", "failed");
    await expect(page.locator(".maplibregl-map")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("takes the map down when no stop has a location, and draws it again when they come back", async ({ page }) => {
    const errors = watchErrors(page);
    // The day's routes as the API gives them, with no start, and with every stop's location
    // removed while `hide` is set.
    let hide = false;
    await page.route(/\/api\/routing\/day\?/, async (route) => {
      const response = await route.fetch();
      const day = await response.json();
      day.start = null;
      if (hide) for (const t of day.technicians) for (const s of t.stops) Object.assign(s, { lat: null, lng: null });
      await route.fulfill({ response, json: day });
    });
    await signIn(page, "owner@example.com", "/inbox");
    const date = await tomorrow(page);
    await openDay(page, date);
    const column = tessColumn(page);
    const markers = page.locator(".map-stop");
    const count = await markers.count();
    expect(count).toBeGreaterThanOrEqual(4);
    await expect(page.locator(".map-start")).toHaveCount(0);
    // Marks the map's surroundings, to show they stay mounted throughout.
    await page.getByTestId("street-map").evaluate((el) => (el.parentElement!.dataset.probe = "kept"));

    // No stop located: the map area goes, and its map with it.
    hide = true;
    await column.locator(".card.tight").first().getByRole("button", { name: "Move down" }).click();
    await expect(page.getByTestId("map-empty")).toHaveText("None of these stops has a map location yet, so there is no map. Use the list.");
    await expect(page.getByTestId("street-map")).toHaveCount(0);
    await expect(page.locator(".maplibregl-map")).toHaveCount(0);
    await expect(column.locator(".card.tight")).toHaveCount(await tessStopCount(page, date));

    // Located again: a fresh map, drawn and with every marker.
    hide = false;
    await column.locator(".card.tight").nth(1).getByRole("button", { name: "Move up" }).click();
    await expect(page.locator(".street-map")).toHaveAttribute("data-status", "ready");
    await expect(page.locator(".maplibregl-map")).toHaveCount(1);
    await expect(markers).toHaveCount(count);
    expect(await page.locator(".maplibregl-canvas").evaluate((c) => (c as HTMLCanvasElement).width)).toBeGreaterThan(0);
    await expect(page.locator('[data-probe="kept"] [data-testid="street-map"]')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
});

test.describe("technician route map", () => {
  test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });

  test("shows only their own route and opens a stop from its marker", async ({ page }) => {
    // Someone else in the company has a stop the same day: it must not show on this technician's map.
    await signIn(page, "owner@example.com", "/inbox");
    const { today } = await (await page.request.get("/api/obligations/due?limit=1")).json();
    const people = (await (await page.request.get("/api/technicians")).json()).items as { id: string; name: string }[];
    const someoneElse = people.find((t) => t.name !== "Tess Tech")!;
    const due = (await (await page.request.get("/api/obligations/due?unscheduledOnly=true&limit=1")).json()).items[0];
    const theirs = await page.request.post("/api/jobs", { data: { obligationId: due.id, technicianId: someoneElse.id, scheduledDate: today } });
    expect(theirs.status()).toBe(201);
    const theirJob = (await theirs.json()).jobId as string;
    await page.request.post("/api/auth/logout", { data: {} });

    try {
      const origins = watchOrigins(page);
      await signIn(page, "tech@example.com", "/tech");
      await expect(page.locator(".stop-card").first()).toBeVisible();
      const cards = await page
        .locator(".stop-card")
        .evaluateAll((els) =>
          els.map((e) => ({ n: e.querySelector(".stop-num")?.textContent, customer: e.querySelector("strong")?.textContent, status: e.querySelector(".badge")?.textContent })),
        );
      const mine = (await (await page.request.get("/api/route")).json()).items as { jobId: string; site: { lat: number | null } }[];

      await page.getByRole("button", { name: "Map" }).click();
      await expect(page.getByRole("button", { name: "Map" })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".street-map")).toHaveAttribute("data-status", "ready");
      await expect(page.locator(".stop-card")).toHaveCount(0);
      const markers = page.locator(".map-stop");
      await expect(markers).toHaveCount(mine.filter((s) => s.site.lat !== null).length);
      expect(await markers.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.stop).sort())).toEqual(mine.map((s) => s.jobId).sort());
      await expect(page.locator(`.map-stop[data-stop="${theirJob}"]`)).toHaveCount(0);
      for (const [i, s] of mine.entries()) {
        const marker = page.locator(`.map-stop[data-stop="${s.jobId}"]`);
        await expect(marker).toHaveText(cards[i]!.n!);
        if (cards[i]!.status!.startsWith("Done")) await expect(marker).toHaveClass(/done/);
        else await expect(marker).not.toHaveClass(/done/);
      }

      // Tapping a marker opens that stop; Back returns to the map.
      await markers.nth(1).click();
      await expect(page.getByRole("heading", { name: cards[1]!.customer! })).toBeVisible();
      await page.getByRole("button", { name: "‹ Back" }).click();
      await expect(page.locator(".street-map")).toBeVisible();
      expect([...origins]).toEqual([ORIGIN]);
    } finally {
      await page.request.post("/api/auth/logout", { data: {} });
      await signIn(page, "owner@example.com", "/inbox");
      expect((await page.request.post(`/api/jobs/${theirJob}/cancel`, { data: { reason: "e2e cleanup" } })).status()).toBe(204);
    }
  });

  test("falls back to the stop list with no signal", async ({ page, context }) => {
    await signIn(page, "tech@example.com", "/tech");
    await expect(page.locator(".stop-card").first()).toBeVisible();
    const count = await page.locator(".stop-card").count();
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.waitForFunction(async () => (await (await caches.open("aerowise-shell-v1")).keys()).length > 5);

    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.locator(".stop-card")).toHaveCount(count);
      await page.getByRole("button", { name: "Map" }).click();
      await expect(page.getByTestId("map-unavailable")).toBeVisible();
      // Every stop is still there to open.
      await expect(page.locator(".stop-card")).toHaveCount(count);
      const customer = await page.locator(".stop-card strong").first().innerText();
      await page.locator(".stop-card").first().click();
      await expect(page.getByRole("heading", { name: customer })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });
});

// The service worker would answer these requests itself, out of the tests' reach.
test.describe("technician route map without its data", () => {
  test.use({ serviceWorkers: "block", geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });

  test("falls back to the stop list when the map file never answers", async ({ page }) => {
    const errors = watchErrors(page);
    const mapData = await holdMapData(page);
    await signIn(page, "tech@example.com", "/tech");
    await expect(page.locator(".stop-card").first()).toBeVisible();
    const count = await page.locator(".stop-card").count();
    await page.getByRole("button", { name: "Map" }).click();
    await expect(page.getByText("Loading map…")).toBeVisible();
    await expect(page.locator(".stop-card")).toHaveCount(0);
    await expect(page.getByTestId("map-unavailable")).toBeVisible({ timeout: 25_000 });
    await expect(page.locator(".stop-card")).toHaveCount(count);
    const customer = await page.locator(".stop-card strong").first().innerText();
    await page.locator(".stop-card").first().click();
    await expect(page.getByRole("heading", { name: customer })).toBeVisible();
    await mapData.release();
    expect(errors).toEqual([]);
  });

  test("leaves the map while it is still starting, then opens it afresh", async ({ page }) => {
    const errors = watchErrors(page);
    const mapData = await holdMapData(page);
    await signIn(page, "tech@example.com", "/tech");
    await expect(page.locator(".stop-card").first()).toBeVisible();
    const count = await page.locator(".stop-card").count();
    await page.getByRole("button", { name: "Map" }).click();
    await expect(page.getByText("Loading map…")).toBeVisible();
    await expect.poll(() => mapData.held.length).toBeGreaterThan(0);

    // Back to the list before the map file answers: the half-started map is dropped.
    await page.getByRole("button", { name: "List" }).click();
    await expect(page.getByTestId("street-map")).toHaveCount(0);
    await mapData.release();
    // Past the first start's deadline: nothing from it fails the list or a later map.
    await page.waitForTimeout(21_000);
    await expect(page.locator(".stop-card")).toHaveCount(count);
    await expect(page.getByTestId("map-unavailable")).toHaveCount(0);

    await page.getByRole("button", { name: "Map" }).click();
    await expect(page.locator(".street-map")).toHaveAttribute("data-status", "ready");
    await expect(page.locator(".maplibregl-map")).toHaveCount(1);
    await expect(page.locator(".map-stop").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("shows the full stop list in Map view when no stop has a location", async ({ page }) => {
    await page.route(/\/api\/route(\?|$)/, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const s of body.items) Object.assign(s.site, { lat: null, lng: null });
      await route.fulfill({ response, json: body });
    });
    await signIn(page, "tech@example.com", "/tech");
    await expect(page.locator(".stop-card").first()).toBeVisible();
    const count = await page.locator(".stop-card").count();
    await page.getByRole("button", { name: "Map" }).click();
    await expect(page.getByTestId("map-empty")).toBeVisible();
    await expect(page.locator(".stop-card")).toHaveCount(count);
    const customer = await page.locator(".stop-card strong").first().innerText();
    await page.locator(".stop-card").first().click();
    await expect(page.getByRole("heading", { name: customer })).toBeVisible();
  });
});

test("serves the map file in ranges, and nothing else under its path", async ({ request }) => {
  const head = await request.get("/map-data/basemap.pmtiles", { headers: { range: "bytes=0-126" } });
  expect(head.status()).toBe(206);
  expect(head.headers()["content-range"]).toMatch(/^bytes 0-126\/\d+$/);
  expect((await head.body()).subarray(0, 7).toString()).toBe("PMTiles");
  expect((await request.get("/map-data/basemap.pmtiles", { headers: { range: "bytes=999999999-" } })).status()).toBe(416);
  expect((await request.get("/map-data/..%2F..%2Fpackage.json")).status()).toBe(404);
  expect((await request.get("/map-data/other.pmtiles")).status()).toBe(404);
  // The fonts the labels use are served here too.
  expect((await request.get("/map/fonts/Noto%20Sans%20Regular/0-255.pbf")).status()).toBe(200);
});
