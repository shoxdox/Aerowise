import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// Plan §12 row 28 (SW-2 storage and failures): a phone that runs out of storage keeps everything
// already saved and queued, says so plainly and takes no new photos until sending makes room; a
// change the server turned down is kept and goes again with Try again. The full phone is
// simulated by failing IndexedDB writes of photo images with the browser's QuotaExceededError.
// Pixel 7 emulation; not a physical-phone check.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });

/** Cancels the work order; one the phone completed cannot be cancelled, so its visit also moves to yesterday for later specs that count today's route and map. */
async function cleanUp(api: APIRequestContext, workOrderId: string) {
  await api.post(`/api/work-orders/${workOrderId}/cancel`, { data: { reason: "e2e cleanup" } });
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query("update jobs set scheduled_date = scheduled_date - 1 where work_order_id = $1", [workOrderId]);
  } finally {
    await db.end();
  }
}

async function office(browser: Browser): Promise<APIRequestContext> {
  const request = (await browser.newContext()).request;
  expect((await request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return request;
}

/** A repair work order for Tess Tech today; returns its id. */
async function repairForTess(api: APIRequestContext, title: string) {
  const types = (await (await api.get("/api/work-types")).json()).items as { id: string; key: string }[];
  const site = (await (await api.get("/api/sites?limit=1")).json()).items[0] as { id: string };
  const techs = (await (await api.get("/api/technicians")).json()).items as { id: string; name: string }[];
  const { today } = await (await api.get("/api/obligations/due?limit=1")).json();
  const created = await api.post("/api/work-orders", { data: { siteId: site.id, workTypeId: types.find((t) => t.key === "repair")!.id, title } });
  expect(created.status()).toBe(201);
  const wo = await created.json();
  const scheduled = await api.post(`/api/work-orders/${wo.id}/schedule`, { data: { technicianId: techs.find((t) => t.name === "Tess Tech")!.id, scheduledDate: today } });
  expect(scheduled.status()).toBe(201);
  return wo.id as string;
}

async function techPhone(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("tech@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/tech");
  await expect(page.getByTestId("work-stops")).toBeVisible();
}

/** Writes of a photo image fail as on a full phone while `window.phoneFull` is true. */
async function simulateFullPhone(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { phoneFull: boolean };
    w.phoneFull = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (w.phoneFull && value && typeof value === "object" && (value as { blob?: unknown }).blob instanceof Blob) {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      return put.call(this, value, key);
    };
  });
}

/** What the work database on the phone holds: queued ops (with failed marks), photo images and the record's photos. */
async function workOnPhone(page: Page, title: string) {
  return page.evaluate(async (title) => {
    const name = (await indexedDB.databases()).map((d) => d.name!).find((n) => n.startsWith("aerowise-tech-work:"))!;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const all = <T,>(store: string) =>
      new Promise<T[]>((resolve, reject) => {
        const req = db.transaction([store], "readonly").objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error);
      });
    const ops = await all<{ seq: number; kind: string; failed?: string }>("outbox");
    const blobs = await all<{ clientId: string }>("blobs");
    const records = await all<{ clientId: string; label?: { title: string }; photos: { clientId: string; photoKey: string; uploaded: boolean }[]; values: Record<string, unknown> }>("records");
    db.close();
    const record = records.find((r) => r.label?.title.endsWith(title));
    return { ops: ops.map((o) => ({ seq: o.seq, kind: o.kind, failed: o.failed ?? null })), blobs: blobs.map((b) => b.clientId).sort(), photos: record?.photos ?? [], values: record?.values ?? {} };
  }, title);
}

test("a full phone keeps everything already saved, says so, and takes photos again once sending has made room", async ({ page, context, browser }) => {
  const api = await office(browser);
  const title = "Float switch (phone full)";
  const id = await repairForTess(api, title);
  try {
    await techPhone(page);
    // At the site with no signal, so what is taken stays queued on the phone.
    await context.setOffline(true);
    await page.locator(".work-card", { hasText: title }).click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await page.getByLabel("Problem found").fill("Alarm stays on after the pump runs");
    await page.getByLabel("Add photo: Before the repair").setInputFiles({ name: "before.png", mimeType: "image/png", buffer: PNG });
    await expect(page.locator('[data-photo="before"]')).toContainText("1 taken");
    const saved = await workOnPhone(page, title);
    expect(saved.blobs).toHaveLength(1);
    expect(saved.ops.map((o) => o.kind)).toContain("work-photo");

    // The phone is full: the next photo does not fit.
    await simulateFullPhone(page);
    await page.getByLabel("Add photo: After the repair").setInputFiles({ name: "after.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByTestId("storage-full")).toHaveText("Phone storage full: send waiting items first.");
    await expect(page.getByTestId("storage-full-banner")).toContainText("Nothing already saved has been lost.");
    // Nothing shows that is not on the phone, and no more photos until there is room.
    await expect(page.locator('[data-photo="after"]')).toContainText("0 taken");
    await expect(page.getByLabel("Add photo: After the repair")).toBeDisabled();
    await expect(page.getByLabel("Add photo: Before the repair")).toBeDisabled();
    // Typing still saves, and nothing queued was dropped.
    await page.getByLabel("Work performed").fill("Replaced the float switch");
    await page.waitForTimeout(600);
    const full = await workOnPhone(page, title);
    expect(full.blobs).toEqual(saved.blobs);
    expect(full.ops.filter((o) => o.kind !== "work-sync")).toEqual(saved.ops.filter((o) => o.kind !== "work-sync"));
    expect(full.ops.every((o) => o.failed === null)).toBe(true);
    expect(full.photos.map((p) => p.photoKey)).toEqual(["before"]);

    // Back in signal, the waiting items send and the phone takes photos again.
    await page.evaluate(() => ((window as unknown as { phoneFull: boolean }).phoneFull = false));
    await context.setOffline(false);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent", { timeout: 60_000 });
    await expect(page.getByTestId("storage-full")).toHaveCount(0);
    await expect(page.getByTestId("storage-full-banner")).toHaveCount(0);
    await page.getByLabel("Add photo: After the repair").setInputFiles({ name: "after.png", mimeType: "image/png", buffer: PNG });
    await expect(page.locator('[data-photo="after"]')).toContainText("1 taken");
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    const sent = await workOnPhone(page, title);
    expect(sent.ops).toEqual([]);
    expect(sent.photos.map((p) => [p.photoKey, p.uploaded])).toEqual([
      ["before", true],
      ["after", true],
    ]);
  } finally {
    await cleanUp(api, id);
  }
});

test("a photo the server turned down stays on the phone and goes again with Try again", async ({ page, browser }) => {
  const api = await office(browser);
  const title = "Float switch (turned down)";
  const id = await repairForTess(api, title);
  try {
    await techPhone(page);
    await page.locator(".work-card", { hasText: title }).click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");

    // The server refuses the photo for good (a 4xx), once.
    await page.route("**/api/work/*/photos/*", (route) => route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ message: "Photo refused for the test" }) }));
    await page.getByLabel("Add photo: Before the repair").setInputFiles({ name: "before.png", mimeType: "image/png", buffer: PNG });
    const alert = page.locator(".sync.error", { hasText: "the office needs to look at" });
    await expect(alert).toContainText("Photo refused for the test");
    const failed = await workOnPhone(page, title);
    expect(failed.ops.filter((o) => o.failed)).toEqual([expect.objectContaining({ kind: "work-photo", failed: "Photo refused for the test" })]);
    expect(failed.blobs).toHaveLength(1);
    // The refused photo is still on the phone, so nothing claims everything was sent.
    await expect(page.getByText("All changes sent")).toHaveCount(0);

    // Try again sends the same photo, which the server now takes.
    await page.unroute("**/api/work/*/photos/*");
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(alert).toHaveCount(0);
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    const sent = await workOnPhone(page, title);
    expect(sent.ops).toEqual([]);
    expect(sent.blobs).toEqual([]);
    expect(sent.photos.map((p) => [p.photoKey, p.uploaded])).toEqual([["before", true]]);
  } finally {
    await cleanUp(api, id);
  }
});

async function sign(page: Page) {
  const pad = page.getByLabel("Signature pad");
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 15, { steps: 5 });
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 15, { steps: 5 });
  await page.mouse.up();
}

// Staging, 2026-10-08: a visit finished in signal showed "some not sent yet" on its photos when
// reopened, though everything had reached the office. The form's own copy of the record never
// heard the photos were sent, and finishing saved that copy over the phone's.
test("photos sent while the form is open stay sent on the phone after finishing and reopening the visit", async ({ page, browser }) => {
  const api = await office(browser);
  const title = "Float switch (sent while open)";
  const id = await repairForTess(api, title);
  try {
    await techPhone(page);
    const card = page.locator(".work-card", { hasText: title });
    await card.click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await page.getByLabel("Problem found").fill("Alarm stays on after the pump runs");
    await page.getByLabel("Work performed").fill("Replaced the float switch and tested the alarm");
    await page.getByRole("group", { name: "Follow-up visit needed" }).getByRole("button", { name: "No", exact: true }).click();
    await page.getByLabel("Add photo: Before the repair").setInputFiles({ name: "before.png", mimeType: "image/png", buffer: PNG });
    await page.getByLabel("Add photo: After the repair").setInputFiles({ name: "after.png", mimeType: "image/png", buffer: PNG });
    // In signal both photos reach the office while the form is still open, and the form says so.
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    await expect.poll(async () => (await workOnPhone(page, title)).photos.map((p) => p.uploaded)).toEqual([true, true]);
    await expect(page.locator('[data-photo="before"]')).not.toContainText("not sent yet");
    await expect(page.locator('[data-photo="after"]')).not.toContainText("not sent yet");

    await page.getByRole("button", { name: "Review and sign" }).click();
    await page.getByLabel("Name of the person signing").fill("Pat Customer");
    await sign(page);
    await page.getByRole("button", { name: "Sign and finish visit" }).click();
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    await expect(card).toContainText("Done");
    await expect(card).not.toContainText("not sent");

    // The phone's copy still knows both photos were sent, and reopening the visit says so.
    const stored = await workOnPhone(page, title);
    expect(stored.ops).toEqual([]);
    expect(stored.photos.map((p) => [p.photoKey, p.uploaded])).toEqual([
      ["before", true],
      ["after", true],
    ]);
    await card.click();
    await expect(page.getByTestId("work-visit-status")).toHaveText("Done");
    await expect(page.locator('[data-photo="before"]')).toContainText("1 taken");
    await expect(page.locator('[data-photo="before"]')).not.toContainText("not sent yet");
    await expect(page.locator('[data-photo="after"]')).not.toContainText("not sent yet");
    await expect(page.getByText("Signed by Pat Customer")).not.toContainText("not sent yet");
    // And after the app is closed and opened again (on the visit it was on).
    await page.reload();
    await expect(page.getByTestId("work-visit-status")).toHaveText("Done");
    await expect(page.locator('[data-photo="before"]')).not.toContainText("not sent yet");
    await expect(page.locator('[data-photo="after"]')).not.toContainText("not sent yet");
  } finally {
    await cleanUp(api, id);
  }
});

/** Rewrites the work record on the phone, as an earlier version could have left it. */
async function rewriteOnPhone(page: Page, title: string, change: { unmark: boolean; failedPhotoKey?: string }) {
  await page.evaluate(
    async ({ title, change }) => {
      const name = (await indexedDB.databases()).map((d) => d.name!).find((n) => n.startsWith("aerowise-tech-work:"))!;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const trx = db.transaction(["records", "outbox"], "readwrite");
      const records = trx.objectStore("records");
      const all = await new Promise<{ clientId: string; label?: { title: string }; photos: { clientId: string; photoKey: string; uploaded: boolean }[]; signatures: { uploaded: boolean }[] }[]>((resolve) => {
        const req = records.getAll();
        req.onsuccess = () => resolve(req.result);
      });
      const rec = all.find((r) => r.label?.title.endsWith(title))!;
      if (change.unmark) records.put({ ...rec, photos: rec.photos.map((p) => ({ ...p, uploaded: false })), signatures: rec.signatures.map((x) => ({ ...x, uploaded: false })) });
      const failed = rec.photos.find((p) => p.photoKey === change.failedPhotoKey);
      if (failed) trx.objectStore("outbox").add({ kind: "work-photo", recordClientId: rec.clientId, photoClientId: failed.clientId, failed: "Photo refused earlier" });
      await new Promise((resolve) => (trx.oncomplete = resolve));
      db.close();
    },
    { title, change },
  );
}

// Staging, 2026-10-08 (WO1005): the phone already holds the old state, photos marked not sent
// with nothing queued, while the server has the visit completed with both photos. Fixing the
// save alone would not change that; the server's completion is the receipt that settles it.
test("photos an earlier version left marked not sent read as sent once the server has the visit completed, and a turned-down photo stays not sent", async ({ page, browser }) => {
  const api = await office(browser);
  const title = "Float switch (old marks)";
  const id = await repairForTess(api, title);
  try {
    await techPhone(page);
    const card = page.locator(".work-card", { hasText: title });
    await card.click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await page.getByLabel("Problem found").fill("Alarm stays on after the pump runs");
    await page.getByLabel("Work performed").fill("Replaced the float switch and tested the alarm");
    await page.getByRole("group", { name: "Follow-up visit needed" }).getByRole("button", { name: "No", exact: true }).click();
    await page.getByLabel("Add photo: Before the repair").setInputFiles({ name: "before.png", mimeType: "image/png", buffer: PNG });
    await page.getByLabel("Add photo: After the repair").setInputFiles({ name: "after.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: "Review and sign" }).click();
    await page.getByLabel("Name of the person signing").fill("Pat Customer");
    await sign(page);
    await page.getByRole("button", { name: "Sign and finish visit" }).click();
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    await expect(card).toContainText("Done");

    await expect.poll(async () => (await workOnPhone(page, title)).ops).toEqual([]);

    // The old state: everything marked not sent, nothing queued, the server has it all.
    await rewriteOnPhone(page, title, { unmark: true });
    expect((await workOnPhone(page, title)).ops).toEqual([]);
    await page.reload();
    await card.click();
    await expect(page.getByTestId("work-visit-status")).toHaveText("Done");
    await expect(page.locator('[data-photo="before"]')).not.toContainText("not sent yet");
    await expect(page.locator('[data-photo="after"]')).not.toContainText("not sent yet");
    await expect(page.getByText(/^Signed by Pat Customer/)).not.toContainText("not sent yet");
    const repaired = await workOnPhone(page, title);
    expect(repaired.photos.map((p) => [p.photoKey, p.uploaded])).toEqual([
      ["before", true],
      ["after", true],
    ]);
    expect(repaired.ops).toEqual([]);

    // A photo with its upload turned down keeps its op and stays not sent; nothing is cleared.
    await rewriteOnPhone(page, title, { unmark: true, failedPhotoKey: "after" });
    // Reopened on the visit it was on.
    await page.reload();
    await expect(page.getByTestId("work-visit-status")).toBeVisible();
    await expect(page.locator('[data-photo="before"]')).not.toContainText("not sent yet");
    await expect(page.locator('[data-photo="after"]')).toContainText("some not sent yet");
    await expect(page.locator(".sync.error")).toContainText("Photo refused earlier");
    const kept = await workOnPhone(page, title);
    expect(kept.photos.map((p) => [p.photoKey, p.uploaded])).toEqual([
      ["before", true],
      ["after", false],
    ]);
    expect(kept.ops).toEqual([expect.objectContaining({ kind: "work-photo", failed: "Photo refused earlier" })]);
  } finally {
    await cleanUp(api, id);
  }
});

// Leaving a form within the 400 ms before its typing is saved saves it on the way out. On a full
// phone that save is refused like any other: the phone says so, keeps what was already saved and
// queued, and nothing is written later by a timer of the closed form.
test("leaving a visit straight after typing on a full phone says so, keeps what was saved, and writes nothing afterwards", async ({ page, browser }) => {
  const api = await office(browser);
  const title = "Float switch (quick back)";
  const id = await repairForTess(api, title);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await techPhone(page);
    await page.locator(".work-card", { hasText: title }).click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await page.getByLabel("Problem found").fill("Alarm stays on");
    await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
    await expect.poll(async () => (await workOnPhone(page, title)).values).toEqual(expect.objectContaining({ problem: "Alarm stays on" }));
    await expect.poll(async () => (await workOnPhone(page, title)).ops).toEqual([]);
    const saved = await workOnPhone(page, title);

    // The phone is full: writing the record itself does not fit.
    await page.evaluate(() => {
      const w = window as unknown as { recordsFull: boolean };
      w.recordsFull = true;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (w.recordsFull && this.name === "records") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return put.call(this, value, key);
      };
    });
    await page.getByLabel("Work performed").fill("Replaced the float switch");
    await page.getByRole("button", { name: "‹ Back" }).click();
    await expect(page.getByTestId("storage-full-banner")).toContainText("Phone storage full: send waiting items first.");
    // What was saved before is kept as it was, with nothing queued lost or added.
    const after = await workOnPhone(page, title);
    expect(after.values).toEqual(saved.values);
    expect(after.ops).toEqual(saved.ops);

    // Room again: nothing of the closed form is written later.
    await page.evaluate(() => ((window as unknown as { recordsFull: boolean }).recordsFull = false));
    await page.waitForTimeout(1000);
    expect((await workOnPhone(page, title)).values).toEqual(saved.values);
    expect(errors).toEqual([]);
  } finally {
    await cleanUp(api, id);
  }
});
