import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("tech@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/tech");
  await expect(page.locator(".stop-card").first()).toBeVisible();
}
async function answerInspection(page: Page) {
  for (const pass of await page.getByRole("button", { name: "Pass", exact: true }).all()) await pass.click();
  await page.getByRole("group", { name: "Chlorine device" }).getByRole("button", { name: "Working" }).click();
  await page.getByLabel("Chlorine level").fill("1.5");
  await page.getByRole("group", { name: "Odor", exact: true }).getByRole("button", { name: "None" }).click();
  await page.getByRole("group", { name: "Pumping needed" }).getByRole("button", { name: "No", exact: true }).click();
}

test("delayed GPS starts once and reuses a draft saved during the wait without replacing its answers", async ({ page, context }) => {
  // Permission is never granted; stand-in location acquisition waits, then reports permission denied.
  await page.addInitScript(() => {
    const w = window as unknown as { gpsCalls: number; releaseGps: () => void };
    w.gpsCalls = 0;
    navigator.geolocation.getCurrentPosition = (_success, failure) => {
      w.gpsCalls++;
      w.releaseGps = () => failure?.({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: "Denied in controlled test" } as GeolocationPositionError);
    };
  });
  await login(page);
  await context.setOffline(true);
  await page.locator(".stop-card", { hasText: "To do" }).first().click();
  const start = page.getByRole("button", { name: "Arrive and start inspection" });
  await start.click();
  await expect(page.getByRole("button", { name: "Starting…", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Starting…", exact: true }).dispatchEvent("click");
  await expect.poll(() => page.evaluate(() => (window as unknown as { gpsCalls: number }).gpsCalls)).toBe(1);
  const existingId = await page.evaluate(async () => {
    const known = JSON.parse(localStorage.getItem("aerowise-tech:tenants")!)[0] as { dbName: string };
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(known.dbName); r.onsuccess = () => resolve(r.result); });
    const read = <T,>(key: string) => new Promise<T>(resolve => { const r = db.transaction("kv").objectStore("kv").get(key); r.onsuccess = () => resolve(r.result as T); });
    const route = await read<{ items: { jobId: string; status: string }[] }>("route");
    const template = await read<{ id: string }>("template:active");
    const stop = route.items.find(s => s.status === "scheduled")!;
    const clientId = crypto.randomUUID();
    const trx = db.transaction(["inspections", "outbox"], "readwrite");
    trx.objectStore("inspections").put({ clientId, jobId: stop.jobId, templateId: template.id, status: "draft", arrivedAt: new Date().toISOString(), completedAt: null, arrivalGps: null, completionGps: null, locationStatus: "denied", accessIssue: null, values: { notes: "Saved by the other tab while GPS waited" }, issues: [], photos: [], server: null });
    trx.objectStore("outbox").add({ kind: "sync", inspectionClientId: clientId });
    await new Promise<void>((resolve, reject) => { trx.oncomplete = () => resolve(); trx.onabort = () => reject(trx.error); });
    db.close();
    (window as unknown as { releaseGps: () => void }).releaseGps();
    return clientId;
  });
  await expect(page.getByLabel("Notes for the customer")).toHaveValue("Saved by the other tab while GPS waited");
  await expect(page.getByTestId("inspection-location")).toContainText("turned off");
  await expect(page.getByTestId("local-save-status")).toContainText("Saved on this phone");
  const ids = await page.evaluate(async () => {
    const known = JSON.parse(localStorage.getItem("aerowise-tech:tenants")!)[0] as { dbName: string };
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(known.dbName); r.onsuccess = () => resolve(r.result); });
    const records = await new Promise<{ clientId: string }[]>(resolve => { const r = db.transaction("inspections").objectStore("inspections").getAll(); r.onsuccess = () => resolve(r.result); });
    db.close(); return records.map(r => r.clientId);
  });
  expect(ids).toEqual([existingId]);
});

test("keyboard photo replacement survives offline reload, sends only retained photos, and opens immutable completed recap", async ({ page, context }) => {
  await page.addInitScript(() => { navigator.geolocation.getCurrentPosition = (_success, failure) => failure?.({ code: 1, PERMISSION_DENIED: 1, message: "Denied" } as GeolocationPositionError); });
  await login(page);
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(async () => (await (await caches.open("aerowise-shell-v1")).keys()).length > 5);
  await context.setOffline(true);
  const card = page.locator(".stop-card", { hasText: "To do" }).first();
  const customer = await card.locator("strong").innerText();
  await card.click();
  await page.getByRole("button", { name: "Arrive and start inspection" }).click();
  await answerInspection(page);
  const add = page.getByRole("button", { name: "Add photo: Overview of the unit", exact: true });
  const picker = page.waitForEvent("filechooser");
  await add.focus(); await page.keyboard.press("Enter");
  await (await picker).setFiles({ name: "wrong.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator('[data-photo="overview"] img')).toBeVisible();
  const replacement = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Replace or retake Overview of the unit, photo 1" }).focus(); await page.keyboard.press("Enter");
  await (await replacement).setFiles({ name: "retake.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator('[data-photo="overview"]')).toContainText("1 taken");
  await page.getByLabel("Add photo: Chlorinator", { exact: true }).setInputFiles({ name: "chlorinator.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByTestId("local-save-status")).toContainText("Saved on this phone");
  await page.reload();
  await page.locator(".stop-card", { hasText: customer }).click();
  await page.getByRole("button", { name: "Continue inspection" }).click();
  await expect(page.locator('[data-photo="overview"] img')).toBeVisible();
  await expect(page.getByLabel("Chlorine level")).toHaveValue("1.5");
  await page.getByRole("button", { name: "Finish inspection", exact: true }).click();
  await page.locator(".stop-card", { hasText: customer }).click();
  await page.getByRole("button", { name: "View completed inspection" }).click();
  await expect(page.getByTestId("inspection-recap")).toContainText("waiting to send");
  await expect(page.getByTestId("inspection-recap")).toContainText("1.5");
  await expect(page.getByRole("button", { name: "Remove Overview" })).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
  await expect(page.getByTestId("inspection-recap")).toContainText("Sent to office");
  const db = new pg.Client({ connectionString: databaseUrl }); await db.connect();
  try {
    const { rows } = await db.query("select i.id, (select count(*)::int from attachments a where a.inspection_id=i.id) photos from inspections i join jobs j on j.id=i.job_id join sites s on s.id=j.site_id join customers c on c.id=s.customer_id where c.display_name=$1 and i.status='completed' order by i.created_at desc limit 1", [customer]);
    expect(rows[0]?.photos).toBe(2);
  } finally { await db.end(); }
});

test("typed work signature uses the consent and exact summary binding and mixed totals include work", async ({ page, browser }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { workGpsCalls: number; releaseWorkGps: () => void };
    w.workGpsCalls = 0;
    navigator.geolocation.getCurrentPosition = (_success, failure) => {
      w.workGpsCalls++;
      const deny = () => failure?.({ code: 1, PERMISSION_DENIED: 1, message: "Denied" } as GeolocationPositionError);
      if (w.workGpsCalls === 1) w.releaseWorkGps = deny;
      else deny();
    };
  });
  const office = (await browser.newContext()).request;
  expect((await office.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  const site = (await (await office.get("/api/sites?limit=1")).json()).items[0];
  const types = (await (await office.get("/api/work-types")).json()).items as { id: string; key: string }[];
  const techs = (await (await office.get("/api/technicians")).json()).items as { id: string; name: string }[];
  const { today } = await (await office.get("/api/obligations/due?limit=1")).json();
  const wo = await (await office.post("/api/work-orders", { data: { siteId: site.id, workTypeId: types.find(t => t.key === "repair")!.id, title: "Keyboard sign-off" } })).json();
  const scheduled = await (await office.post(`/api/work-orders/${wo.id}/schedule`, { data: { technicianId: techs.find(t => t.name === "Tess Tech")!.id, scheduledDate: today } })).json();
  const jobId = scheduled.visits[0].jobId;
  try {
    await login(page);
    const route = await (await page.request.get("/api/route")).json();
    const work = await (await page.request.get("/api/work/route")).json();
    await expect(page.getByText(new RegExp(`of ${route.items.length + work.items.length} stops done`))).toBeVisible();
    await page.locator(".work-card", { hasText: "Keyboard sign-off" }).click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await expect(page.getByRole("button", { name: "Starting…", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Starting…", exact: true }).dispatchEvent("click");
    await expect.poll(() => page.evaluate(() => (window as unknown as { workGpsCalls: number }).workGpsCalls)).toBe(1);
    await page.evaluate(() => (window as unknown as { releaseWorkGps: () => void }).releaseWorkGps());
    await page.getByLabel("Problem found").fill("Fictional alarm stuck");
    await page.getByLabel("Work performed").fill("Fictional float replaced");
    await page.getByRole("group", { name: "Follow-up visit needed" }).getByRole("button", { name: "No", exact: true }).click();
    await page.getByLabel("Add photo: Before the repair", { exact: true }).setInputFiles({ name: "before.png", mimeType: "image/png", buffer: PNG });
    await page.getByLabel("Add photo: After the repair", { exact: true }).setInputFiles({ name: "after.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: "Review and sign", exact: true }).click();
    await expect(page.getByTestId("work-signoff")).toBeFocused();
    await page.getByLabel("Name of the person signing").fill("Fictional Keyboard Customer");
    await page.getByRole("button", { name: "Type signature", exact: true }).focus(); await page.keyboard.press("Enter");
    await expect(page.getByTestId("work-signoff")).toContainText("I adopt my typed name");
    await page.getByRole("button", { name: "Sign and finish visit" }).focus(); await page.keyboard.press("Enter");
    await expect(page.locator(".work-card", { hasText: "Keyboard sign-off" })).toContainText("Done");
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
    const db = new pg.Client({ connectionString: databaseUrl }); await db.connect();
    try {
      const { rows } = await db.query("select d.signature_kind kind,d.consent_text,d.content_sha256=r.summary_sha256 matching from signed_documents d join work_records r on r.offline_client_id=d.record_client_id where r.job_id=$1", [jobId]);
      expect(rows).toEqual([{ kind: "typed", consent_text: "I have read the summary of the work above and confirm it describes the work done at this property.", matching: true }]);
    } finally { await db.end(); }
  } finally {
    // Leave no new stop on today’s route for unrelated cap/map tests.
    const db = new pg.Client({ connectionString: databaseUrl }); await db.connect();
    try { await db.query("update jobs set scheduled_date=scheduled_date-1 where id=$1", [jobId]); } finally { await db.end(); }
  }
});

test("quota failure never claims the latest edit is saved, retry recovers, and yesterday’s cache shows its date", async ({ page, context }) => {
  await page.addInitScript(() => { navigator.geolocation.getCurrentPosition = (_success, failure) => failure?.({ code: 1, PERMISSION_DENIED: 1, message: "Denied" } as GeolocationPositionError); });
  await login(page);
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(async () => (await (await caches.open("aerowise-shell-v1")).keys()).length > 5);
  await context.setOffline(true);
  await page.locator(".stop-card", { hasText: "To do" }).first().click();
  await page.getByRole("button", { name: "Arrive and start inspection" }).click();
  await expect(page.getByTestId("local-save-status")).toContainText("Saved on this phone");
  await page.evaluate(() => {
    const w = window as unknown as { editsFull: boolean };
    w.editsFull = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
      if (w.editsFull && this.name === "inspections") throw new DOMException("Controlled full phone", "QuotaExceededError");
      return put.call(this, value, key);
    };
  });
  await page.getByLabel("Notes for the customer").fill("Latest edit must not be called safe before commit");
  await expect(page.getByTestId("local-save-status")).toContainText("not saved on this phone");
  await expect(page.getByTestId("storage-full-banner")).toBeVisible();
  await expect(page.getByTestId("offline-status")).toContainText("Offline");
  await page.evaluate(() => { (window as unknown as { editsFull: boolean }).editsFull = false; });
  await page.getByRole("button", { name: "Retry local save" }).click();
  await expect(page.getByTestId("local-save-status")).toContainText("Saved on this phone");
  // Saved cached route from a different date remains explicitly recognizable after offline reload.
  await page.evaluate(async () => {
    const known = JSON.parse(localStorage.getItem("aerowise-tech:tenants")!)[0] as { dbName: string };
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(known.dbName); r.onsuccess = () => resolve(r.result); });
    const trx = db.transaction("kv", "readwrite");
    const kv = trx.objectStore("kv");
    const read = kv.get("route");
    read.onsuccess = () => { kv.put({ ...read.result, date: "2001-01-01" }, "route"); kv.put("2001-01-01T18:00:00.000Z", "routeFetchedAt"); };
    await new Promise<void>((resolve, reject) => { trx.oncomplete = () => resolve(); trx.onabort = () => reject(trx.error); });
    db.close();
  });
  await page.reload();
  await expect(page.getByText("This is the cached route for Jan 1, 2001.", { exact: false })).toBeVisible();
  await expect(page.getByText(/route last downloaded Jan 1, 2001/)).toBeVisible();
  await page.locator(".stop-card", { hasText: "In progress" }).first().click();
  await page.getByRole("button", { name: "Continue inspection" }).click();
  await expect(page.getByLabel("Notes for the customer")).toHaveValue("Latest edit must not be called safe before commit");
});
