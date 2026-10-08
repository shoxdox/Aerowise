import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// Plan §12 row 28 for the disposal record (SW-6): a load that does not fit on a full phone is not
// saved at all, the phone says so, keeps what was typed and takes no manifest photo until there
// is room; already-saved data and queued ops are untouched. The full phone is simulated by failing
// IndexedDB writes of photo images with the browser's QuotaExceededError. Pixel 7 emulation.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });

async function office(browser: Browser): Promise<APIRequestContext> {
  const request = (await browser.newContext()).request;
  expect((await request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return request;
}

async function pumpingForTess(api: APIRequestContext, title: string) {
  const truck = await (await api.post("/api/vehicles", { data: { name: `Truck ${title}` } })).json();
  const facility = await (await api.post("/api/disposal-facilities", { data: { name: `Facility ${title}`, kind: "wastewater_treatment_plant" } })).json();
  const types = (await (await api.get("/api/work-types")).json()).items as { id: string; key: string }[];
  const site = (await (await api.get("/api/sites?limit=1")).json()).items[0] as { id: string };
  const techs = (await (await api.get("/api/technicians")).json()).items as { id: string; name: string }[];
  const { today } = await (await api.get("/api/obligations/due?limit=1")).json();
  const wo = await (await api.post("/api/work-orders", { data: { siteId: site.id, workTypeId: types.find((t) => t.key === "pumping")!.id, title } })).json();
  const scheduled = await api.post(`/api/work-orders/${wo.id}/schedule`, { data: { technicianId: techs.find((t) => t.name === "Tess Tech")!.id, scheduledDate: today } });
  expect(scheduled.status()).toBe(201);
  return { id: wo.id as string, jobId: (await scheduled.json()).visits[0].jobId as string, truck: truck as { name: string }, facility: facility as { name: string } };
}

/** What the phone's work database holds: the queued ops and the saved loads. */
function onPhone(page: Page) {
  return page.evaluate(async () => {
    const name = (await indexedDB.databases()).map((d) => d.name ?? "").find((n) => n.startsWith("aerowise-tech-work:"))!;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const get = <T,>(store: string, key?: string) =>
      new Promise<T>((resolve) => {
        const s = db.transaction([store], "readonly").objectStore(store);
        const req = key === undefined ? s.getAll() : s.get(key);
        req.onsuccess = () => resolve(req.result as T);
      });
    const ops = await get<{ seq: number; kind: string; failed?: string }[]>("outbox");
    const loads = (await get<{ clientId: string; manifestReference: string | null; photos: unknown[] }[] | undefined>("kv", "disposal-loads")) ?? [];
    db.close();
    return { ops: ops.map((o) => ({ seq: o.seq, kind: o.kind })), loads: loads.map((l) => ({ manifest: l.manifestReference, photos: l.photos.length })) };
  });
}

test("a disposal record that does not fit is not saved, says so, keeps what was typed, and saves once there is room", async ({ page, browser }) => {
  const api = await office(browser);
  const title = "Pump-out (phone full)";
  const wo = await pumpingForTess(api, title);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto("/login");
    await page.getByLabel("Email").fill("tech@example.com");
    await page.getByLabel("Password").fill("aerowise-dev");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/tech");
    // The pump-out, done with signal.
    await page.locator(".work-card", { hasText: title }).click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await page.getByLabel("Tanks pumped").fill("1");
    await page.getByRole("group", { name: "Lid condition" }).getByRole("button", { name: "Good" }).click();
    await page.getByLabel("Volume pumped").fill("500");
    await page.getByLabel("Truck").selectOption({ label: wo.truck.name });
    await page.getByRole("button", { name: "Review and sign" }).click();
    await page.getByRole("button", { name: "Finish without a signature" }).click();
    const query = () => db.query("select p.group_id from pumping_records p join work_records r on r.id = p.work_record_id where r.job_id = $1", [wo.jobId]);
    await expect.poll(async () => (await query()).rows.length, { timeout: 60_000 }).toBe(1);
    await page.reload();
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    const before = await onPhone(page);

    // The disposal record with its manifest photo, on a full phone.
    await page.evaluate(() => {
      const w = window as unknown as { phoneFull: boolean };
      w.phoneFull = true;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (w.phoneFull && value && typeof value === "object" && (value as { blob?: unknown }).blob instanceof Blob) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return put.call(this, value, key);
      };
    });
    await page.getByTestId("open-disposal").click();
    const screen = page.getByTestId("record-disposal");
    await screen.locator("label", { hasText: "500.0 gallons" }).getByRole("checkbox").check();
    await screen.getByLabel("Facility").selectOption({ label: wo.facility.name });
    await screen.getByLabel("Total delivered").fill("500");
    await screen.getByLabel("Manifest/reference number").fill("E2E-FULL-1");
    await screen.getByLabel("Add manifest photo").setInputFiles({ name: "manifest.png", mimeType: "image/png", buffer: PNG });
    await screen.getByRole("button", { name: "Save disposal record" }).click();
    await expect(screen.getByTestId("storage-full")).toHaveText("Phone storage full: send waiting items first.");
    await expect(page.getByTestId("storage-full-banner")).toBeVisible();
    // Not saved at all (no load, no queued op), what was typed is still there, and no new photo.
    expect(await onPhone(page)).toEqual(before);
    await expect(screen.getByLabel("Manifest/reference number")).toHaveValue("E2E-FULL-1");
    await expect(screen.getByLabel("Add manifest photo")).toBeDisabled();
    await expect(screen.getByRole("button", { name: "Save disposal record" })).toBeEnabled();

    // Room again (nothing was waiting to send): the same record saves with its photo and is sent.
    await page.evaluate(() => ((window as unknown as { phoneFull: boolean }).phoneFull = false));
    await page.getByTestId("storage-full-banner").getByRole("button", { name: "Send now" }).click();
    await expect(page.getByTestId("storage-full-banner")).toHaveCount(0);
    await expect(screen.getByLabel("Add manifest photo")).toBeEnabled();
    await screen.getByRole("button", { name: "Save disposal record" }).click();
    await expect(screen).toHaveCount(0);
    const photos = () =>
      db.query("select count(*)::int as n from work_attachments a join disposal_loads l on l.group_id = a.disposal_load_group_id where l.is_current and l.manifest_reference = 'E2E-FULL-1'");
    await expect.poll(async () => (await photos()).rows[0].n, { timeout: 60_000 }).toBe(1);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
    expect((await onPhone(page)).loads).toEqual([...before.loads, { manifest: "E2E-FULL-1", photos: 1 }]);
    expect(errors).toEqual([]);
  } finally {
    await api.post(`/api/work-orders/${wo.id}/cancel`, { data: { reason: "e2e cleanup" } });
    // Later specs count today's work visits on the route and map: this one moves to yesterday.
    await db.query("update jobs set scheduled_date = scheduled_date - 1 where work_order_id = $1", [wo.id]);
    await db.end();
  }
});
