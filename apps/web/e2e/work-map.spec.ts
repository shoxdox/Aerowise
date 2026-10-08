import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// SW-10: work visits on the street map with the inspections, on the office schedule and on the
// technician's phone. The e2e web server serves the synthetic map fixture; the API runs with
// work_orders and field_work on (playwright.config.ts). Pixel 7 emulation for the phone; not a
// physical-phone check.

const ORIGIN = "http://localhost:3000";

async function signIn(page: Page, email: string, landing: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`**${landing}`);
}

function watchOrigins(page: Page) {
  const origins = new Set<string>();
  page.on("request", (r) => {
    const url = r.url();
    if (!url.startsWith("data:") && !url.startsWith("blob:")) origins.add(new URL(url).origin);
  });
  return origins;
}

const dayAfter = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Work for Tess Tech on a day, at a site that is on the map. */
async function workForTess(api: APIRequestContext, key: string, title: string, date: string) {
  const types = (await (await api.get("/api/work-types")).json()).items as { id: string; key: string }[];
  let type = types.find((t) => t.key === key);
  if (!type) {
    // A kind of work with no minutes of its own, in the maintenance category.
    const added = await api.post("/api/work-types", { data: { key, name: "Line jetting (e2e)", category: "maintenance" } });
    expect(added.status()).toBe(201);
    type = await added.json();
  }
  const sites = (await (await api.get("/api/sites?limit=50")).json()).items as { id: string; lat: number | null }[];
  const site = sites.find((s) => s.lat !== null)!;
  const techs = (await (await api.get("/api/technicians")).json()).items as { id: string; name: string }[];
  const created = await api.post("/api/work-orders", { data: { siteId: site.id, workTypeId: type!.id, title } });
  expect(created.status()).toBe(201);
  const wo = await created.json();
  const scheduled = await api.post(`/api/work-orders/${wo.id}/schedule`, { data: { technicianId: techs.find((t) => t.name === "Tess Tech")!.id, scheduledDate: date } });
  expect(scheduled.status()).toBe(201);
  return { id: wo.id as string, jobId: (await scheduled.json()).nextVisit.jobId as string };
}

const cancel = (api: APIRequestContext, id: string) => api.post(`/api/work-orders/${id}/cancel`, { data: { reason: "e2e cleanup" } });

test.describe("office schedule map with work", () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

  test("marks each kind of stop and hides kinds from the map without renumbering the route", async ({ page }) => {
    const origins = watchOrigins(page);
    await signIn(page, "owner@example.com", "/inbox");
    const { today } = await (await page.request.get("/api/obligations/due?limit=1")).json();
    const date = dayAfter(today, 1);
    const pump = await workForTess(page.request, "pumping", "Pump the tank (map e2e)", date);
    const jet = await workForTess(page.request, "e2e_jetting", "Jet the lines (map e2e)", date);
    try {
      await page.goto("/schedule");
      await page.locator('input[type="date"]').fill(date);
      await expect(page.locator(".street-map")).toHaveAttribute("data-status", "ready");

      const pumpMarker = page.locator(`.map-stop[data-stop="${pump.jobId}"]`);
      const jetMarker = page.locator(`.map-stop[data-stop="${jet.jobId}"]`);
      await expect(pumpMarker).toHaveAttribute("data-kind", "pumping");
      await expect(pumpMarker).toHaveAttribute("data-letter", "P");
      await expect(pumpMarker).toHaveClass(/work/);
      await expect(jetMarker).toHaveAttribute("data-kind", "maintenance");
      await expect(jetMarker).toHaveAttribute("data-letter", "M");
      await expect(pumpMarker).toHaveAttribute("aria-label", /stop \d+, Pumping: /);
      const inspections = page.locator('.map-stop[data-kind="inspection"]');
      const inspectionCount = await inspections.count();
      expect(inspectionCount).toBeGreaterThan(0);
      await expect(inspections.first()).not.toHaveClass(/work/);
      await expect(page.getByTestId("map-kinds")).toContainText("Inspection");
      await expect(page.getByTestId("map-kinds")).toContainText("Pumping");
      await expect(page.getByTestId("map-kinds")).toContainText("Maintenance");
      // The honest estimate wording stays.
      await expect(page.getByText("they are straight lines, not roads")).toBeVisible();

      // Hiding inspections changes only the map: the work keeps its numbers.
      const numbers = [await pumpMarker.innerText(), await jetMarker.innerText()];
      const filter = page.getByTestId("map-kind-filter");
      await filter.getByLabel("Inspection").uncheck();
      await expect(inspections).toHaveCount(0);
      expect([await pumpMarker.innerText(), await jetMarker.innerText()]).toEqual(numbers);
      await filter.getByLabel("Pumping").uncheck();
      await expect(pumpMarker).toHaveCount(0);
      await expect(jetMarker).toHaveText(numbers[1]!);
      await filter.getByLabel("Inspection").check();
      await filter.getByLabel("Pumping").check();
      await expect(inspections).toHaveCount(inspectionCount);
      await expect(pumpMarker).toHaveText(numbers[0]!);

      // A selected work stop says what the work is.
      await pumpMarker.click();
      await expect(page.getByTestId("map-stop-detail")).toContainText("Pump the tank (map e2e)");
      expect([...origins]).toEqual([ORIGIN]);
    } finally {
      await cancel(page.request, pump.id);
      await cancel(page.request, jet.id);
    }
  });
});

test.describe("technician map with work", () => {
  test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });

  test("shows inspections and work in one numbered visit order, and opens a work visit from its marker", async ({ page }) => {
    await signIn(page, "owner@example.com", "/inbox");
    const { today } = await (await page.request.get("/api/obligations/due?limit=1")).json();
    const pump = await workForTess(page.request, "pumping", "Pump the tank (phone map e2e)", today);
    await page.request.post("/api/auth/logout", { data: {} });
    try {
      const origins = watchOrigins(page);
      await signIn(page, "tech@example.com", "/tech");
      await expect(page.locator(".stop-card").first()).toBeVisible();
      await expect(page.getByTestId("work-stops")).toBeVisible();

      // One numbering across both lists: 1..n, no repeats.
      const inspectionNumbers = await page.locator(".stop-card .stop-num").allInnerTexts();
      const workNumbers = await page.locator(".work-card .stop-num").allInnerTexts();
      const all = [...inspectionNumbers, ...workNumbers].map(Number).sort((a, b) => a - b);
      expect(all).toEqual(all.map((_, i) => i + 1));
      const workCard = page.locator(".work-card", { hasText: "Pump the tank (phone map e2e)" });
      const pumpNumber = await workCard.locator(".stop-num").innerText();

      // The work stop's place in the day is the office's route order.
      const route = (await (await page.request.get("/api/route")).json()).items as { jobId: string; routePosition: number; site: { lat: number | null } }[];
      const work = (await (await page.request.get("/api/work/route")).json()).items as { jobId: string; routePosition: number; lat: number | null }[];
      const order = [...route.map((s) => ({ id: s.jobId, p: s.routePosition })), ...work.map((s) => ({ id: s.jobId, p: s.routePosition }))].sort((a, b) => a.p - b.p);
      expect(String(order.findIndex((s) => s.id === pump.jobId) + 1)).toBe(pumpNumber);

      await page.getByRole("button", { name: "Map", exact: true }).click();
      await expect(page.locator(".street-map")).toHaveAttribute("data-status", "ready");
      const markers = page.locator(".map-stop");
      await expect(markers).toHaveCount(route.filter((s) => s.site.lat !== null).length + work.filter((s) => s.lat !== null).length);
      const marker = page.locator(`.map-stop[data-stop="${pump.jobId}"]`);
      await expect(marker).toHaveText(pumpNumber);
      await expect(marker).toHaveAttribute("data-kind", "pumping");
      for (const n of inspectionNumbers) await expect(page.locator('.map-stop[data-kind="inspection"]', { hasText: new RegExp(`^${n}$`) })).toHaveCount(1);

      // Tapping the work marker opens the work visit.
      await marker.click();
      await expect(page.getByRole("heading", { name: /Pump the tank \(phone map e2e\)/ })).toBeVisible();
      expect([...origins]).toEqual([ORIGIN]);
    } finally {
      await page.request.post("/api/auth/logout", { data: {} });
      await signIn(page, "owner@example.com", "/inbox");
      expect((await cancel(page.request, pump.id)).ok()).toBe(true);
    }
  });
});
