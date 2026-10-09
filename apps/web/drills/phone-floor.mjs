// SW-12 Drill A, phone part (plan §12 row 4, §9.1): one phone profile kept across a rollback of
// the web app to the SW-2a phone floor and a roll forward again, while the API stays on an
// approved server. Run only from scripts/sw12/drill-phone-floor.sh, which swaps the servers
// between phases. Scratch only: it talks to http://localhost:3000 and the scratch database it is
// given, never to staging.
//
//   node drills/phone-floor.mjs <phase> <profileDir> <stateFile>
//   phase: before (final SHA), floor (a39e875 web, approved API), after (final SHA again)
//
// Its last line is "PHASE <phase> END checks=<n> fails=<m>"; the script's verdict needs it.
import { chromium, devices } from "@playwright/test";
import fs from "node:fs";
import pg from "pg";

const [phase, profileDir, stateFile] = process.argv.slice(2);
if (!["before", "floor", "after"].includes(phase) || !profileDir || !stateFile) {
  console.error("usage: node drills/phone-floor.mjs before|floor|after <profileDir> <stateFile>");
  process.exit(2);
}
const databaseUrl = process.env.DRILL_DATABASE_URL;
if (!databaseUrl || !/drill.*test|test.*drill/.test(databaseUrl)) {
  console.error("DRILL_DATABASE_URL must name a scratch drill test database");
  process.exit(2);
}
const BASE = "http://localhost:3000";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
const one = async (q, p = []) => (await db.query(q, p)).rows[0];
let checks = 0;
let fails = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} [${phase}] ${what}`);
  if (!ok) process.exitCode = 1;
};

const pixel = { ...devices["Pixel 7"] };
delete pixel.defaultBrowserType;
const ctx = await chromium.launchPersistentContext(profileDir, {
  ...pixel,
  baseURL: BASE,
  geolocation: { latitude: 30.27, longitude: -97.74 },
  permissions: ["geolocation"],
  serviceWorkers: "allow",
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => m.type() === "error" && pageErrors.push(m.text()));

/** Every IndexedDB database on the phone with its version, and the work outbox size. */
const phoneDbs = () =>
  page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    const out = { dbs: dbs.map((d) => ({ name: d.name, version: d.version })), workOutbox: null };
    const work = dbs.find((d) => d.name?.startsWith("aerowise-tech-work:"));
    if (work) {
      out.workOutbox = await new Promise((resolve) => {
        const req = indexedDB.open(work.name);
        req.onsuccess = () => {
          const conn = req.result;
          if (!conn.objectStoreNames.contains("outbox")) return resolve(-1), conn.close();
          const c = conn.transaction("outbox").objectStore("outbox").count();
          c.onsuccess = () => (resolve(c.result), conn.close());
        };
        req.onerror = () => resolve(-2);
      });
    }
    return out;
  });

/** Reloads until the phone runs the build being served (the floor has no work list). */
async function waitForBuild(work) {
  // The reopened phone starts on a blank page: the technician opens the app.
  if (!page.url().includes("/tech")) await page.goto("/tech");
  for (let i = 0; i < 12; i++) {
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(1500);
    if (!page.url().includes("/tech")) continue;
    await page.locator(".stop-card").first().waitFor({ timeout: 20_000 }).catch(() => {});
    const has = (await page.getByTestId("work-stops").count()) > 0;
    if (has === work) return true;
    // A waiting service worker takes over once every page of the old one is gone.
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  }
  return false;
}

try {
  if (phase === "before") {
    // The office books a repair for Tess today, so a work visit is on her day during the drill.
    const office = await ctx.request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } });
    if (!office.ok()) throw new Error(`office sign-in ${office.status()}`);
    const types = (await (await ctx.request.get("/api/work-types")).json()).items;
    const site = (await (await ctx.request.get("/api/sites?limit=1")).json()).items[0];
    const techs = (await (await ctx.request.get("/api/technicians")).json()).items;
    const { today } = await (await ctx.request.get("/api/obligations/due?limit=1")).json();
    const wo = await (await ctx.request.post("/api/work-orders", { data: { siteId: site.id, workTypeId: types.find((t) => t.key === "repair").id, title: "Floor drill repair" } })).json();
    const sched = await (await ctx.request.post(`/api/work-orders/${wo.id}/schedule`, { data: { technicianId: techs.find((t) => t.name === "Tess Tech").id, scheduledDate: today } })).json();
    Object.assign(state, { workOrderId: wo.id, jobId: sched.visits[0].jobId });
    await ctx.request.post("/api/auth/logout").catch(() => {});
    await ctx.clearCookies();

    // Tess's phone saves the app and the route.
    await page.goto("/login");
    await page.getByLabel("Email").fill("tech@example.com");
    await page.getByLabel("Password").fill("aerowise-dev");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/tech");
    await page.getByTestId("work-stops").waitFor();
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.waitForFunction(async () => (await (await caches.open("aerowise-shell-v1")).keys()).length > 5);
    state.before = {
      inspections: Number((await one("select count(*) n from inspections")).n),
      completed: Number((await one("select count(*) n from audit_events where action = 'inspection.completed'")).n),
    };

    // No signal: one inspection and the repair are done and wait on the phone.
    await ctx.setOffline(true);
    await page.reload();
    const stop = page.locator(".stop-card", { hasText: "To do" }).first();
    state.customer = await stop.locator("strong").innerText();
    await stop.click();
    await page.getByRole("button", { name: "Arrive and start inspection" }).click();
    await page.getByRole("group", { name: "Aerator" }).waitFor();
    for (const pass of await page.getByRole("button", { name: "Pass", exact: true }).all()) await pass.click();
    await page.getByRole("group", { name: "Chlorine device" }).getByRole("button", { name: "Working" }).click();
    await page.getByLabel("Chlorine level").fill("1.5");
    await page.getByLabel("Air pressure").fill("4");
    await page.getByRole("group", { name: "Odor" }).getByRole("button", { name: "None" }).click();
    await page.getByRole("group", { name: "Pumping needed" }).getByRole("button", { name: "No" }).click();
    await page.getByLabel("Add photo: Overview of the unit").setInputFiles({ name: "o.png", mimeType: "image/png", buffer: PNG });
    await page.getByLabel("Add photo: Chlorinator").setInputFiles({ name: "c.png", mimeType: "image/png", buffer: PNG });
    await page.locator('[data-photo="chlorinator"]').getByText("1 taken").waitFor();
    await page.getByRole("button", { name: "Finish inspection" }).click();
    await page.locator(".stop-card", { hasText: state.customer }).getByText("Done · not sent yet").waitFor();

    const card = page.locator(".work-card", { hasText: "Floor drill repair" });
    await card.click();
    await page.getByRole("button", { name: "Arrive and start work" }).click();
    await page.getByLabel("Problem found").fill("Alarm stays on");
    await page.getByLabel("Work performed").fill("Replaced the float switch");
    await page.getByRole("group", { name: "Follow-up visit needed" }).getByRole("button", { name: "No", exact: true }).click();
    await page.getByLabel("Add photo: Before the repair").setInputFiles({ name: "b.png", mimeType: "image/png", buffer: PNG });
    await page.getByLabel("Add photo: After the repair").setInputFiles({ name: "a.png", mimeType: "image/png", buffer: PNG });
    await page.locator('[data-photo="after"]').getByText("1 taken").waitFor();
    await page.getByRole("button", { name: "Review and sign" }).click();
    await page.getByLabel("Name of the person signing").fill("Pat Customer");
    const box = await page.getByLabel("Signature pad").boundingBox();
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 20, box.y + 15, { steps: 6 });
    await page.mouse.up();
    await page.getByRole("button", { name: "Sign and finish visit" }).click();
    await card.getByText("Done · not sent yet").waitFor();

    const dbs = await phoneDbs();
    state.inspectionDbVersion = dbs.dbs.find((d) => d.name?.startsWith("aerowise-tech:"))?.version;
    state.workOutboxBefore = dbs.workOutbox;
    check(state.workOutboxBefore > 0, `work outbox holds ${state.workOutboxBefore} unsent changes before the rollback`);
    check(Number((await one("select count(*) n from work_records where job_id = $1", [state.jobId])).n) === 0, "nothing of the repair reached the server");
    save();
  }

  if (phase === "floor") {
    // Signal back, while the phone loads the floor web app from an approved API.
    await ctx.setOffline(false);
    check(await waitForBuild(false), "the phone now runs the floor build (no work list)");
    const route = await page.request.get("/api/route");
    const items = route.ok() ? (await route.json()).items : [];
    const strays = items.filter((s) => !s.obligation);
    if (strays.length) {
      const jobs = (await db.query("select id, type from jobs where id = any($1)", [strays.map((s) => s.jobId)])).rows;
      console.log(`  floor /route lists ${strays.length} stop(s) with no obligation: ${JSON.stringify(jobs)}`);
      await page.screenshot({ path: `${stateFile}.floor-route.png`, fullPage: true }).catch(() => {});
      const shown = await page.locator(".stop-card").allInnerTexts();
      console.log(`  floor phone shows ${shown.length} stop cards: ${JSON.stringify(shown.map((t) => t.replace(/\s+/g, " ").slice(0, 80)))}`);
    }
    check(route.ok() && strays.length === 0, "the floor's /route answers and lists inspections only, with a work visit booked today");
    await page.waitForFunction(() => document.querySelector('[data-testid="sync-status"]')?.textContent?.includes("All changes sent"), null, { timeout: 90_000 }).catch(() => {});
    check(Number((await one("select count(*) n from inspections")).n) === state.before.inspections + 1, "the inspection reached the server exactly once");
    check(Number((await one("select count(*) n from audit_events where action = 'inspection.completed'")).n) === state.before.completed + 1, "one inspection completion recorded");
    check(Number((await one("select count(*) n from work_records where job_id = $1", [state.jobId])).n) === 0, "the floor sent none of the work");
    const dbs = await phoneDbs();
    check(dbs.dbs.find((d) => d.name?.startsWith("aerowise-tech:"))?.version === state.inspectionDbVersion, `inspection database version unchanged (${state.inspectionDbVersion})`);
    check(dbs.workOutbox === state.workOutboxBefore, `work outbox untouched by the floor (${dbs.workOutbox} of ${state.workOutboxBefore})`);
    check(!pageErrors.some((e) => /VersionError/.test(e)), "no VersionError on the floor");
    if (pageErrors.length) console.log(`  floor page errors: ${JSON.stringify(pageErrors.slice(0, 5))}`);
    save();
  }

  if (phase === "after") {
    check(await waitForBuild(true), "the phone runs the final build again (work list back)");
    await page.waitForFunction(() => document.querySelector('[data-testid="sync-status"]')?.textContent?.includes("All changes sent"), null, { timeout: 120_000 });
    const row = await one(
      `select r.status, r.validation_status,
         (select count(*)::int from work_attachments a where a.record_client_id = r.offline_client_id) photos,
         (select count(*)::int from signed_documents d where d.record_client_id = r.offline_client_id and d.kind = 'work_completion' and d.content_sha256 = r.summary_sha256) signatures,
         (select count(*)::int from audit_events e where e.entity_id = r.id and e.action = 'work_record.completed') completions,
         (select count(*)::int from work_records w where w.job_id = $1) records
       from work_records r where r.job_id = $1`,
      [state.jobId],
    );
    check(
      row && row.records === 1 && row.status === "completed" && row.validation_status === "valid" && row.photos === 2 && row.signatures === 1 && row.completions === 1,
      `the repair arrived exactly once after the roll forward (${JSON.stringify(row)})`,
    );
    check(Number((await one("select count(*) n from inspections")).n) === state.before.inspections + 1, "the inspection is still there exactly once");
    const dbs = await phoneDbs();
    check(dbs.workOutbox === 0, "the work outbox is empty");
    check(dbs.dbs.find((d) => d.name?.startsWith("aerowise-tech:"))?.version === state.inspectionDbVersion, "inspection database version still unchanged");
    check(!pageErrors.some((e) => /VersionError/.test(e)), "no VersionError after the roll forward");
  }
} catch (e) {
  fails++;
  console.log(`FAIL [${phase}] ${e?.stack ?? e}`);
  await page.screenshot({ path: `${stateFile}.${phase}-failure.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await ctx.close().catch(() => {});
  await db.end().catch(() => {});
  console.log(`PHASE ${phase} END checks=${checks} fails=${fails}`);
}
