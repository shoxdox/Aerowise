// SW-12 Drill B, API part (plan §12 rows 12 and 21): run only from scripts/sw12/drill-app-floor.sh.
// Scratch only: it talks to http://localhost:4000 and the scratch database it is given.
//
//   node drills/app-floor.mjs fixtures                 service-workflow records for the demo company
//   node drills/app-floor.mjs smoke <label> [floor]    every list and every record of the signed-in company
//   node drills/app-floor.mjs files <label>            every stored photo downloads with its recorded checksum
//
// Its last line is "STEP <mode> <label> END checks=<n> fails=<m>"; the script's verdict needs it.
// FLOOR_UNSUPPORTED (comma-separated path prefixes) names endpoints newer than the floor; on the
// floor they must answer 404 and are reported as unsupported, never counted as passing reads.
import { createHash } from "node:crypto";
import pg from "pg";

const [mode, label = mode, floorArg] = process.argv.slice(2);
const onFloor = floorArg === "floor";
const databaseUrl = process.env.DRILL_DATABASE_URL;
if (!["fixtures", "smoke", "files"].includes(mode) || !databaseUrl || !/drill.*test|test.*drill/.test(databaseUrl)) {
  console.error("usage: DRILL_DATABASE_URL=<scratch drill db> node drills/app-floor.mjs fixtures|smoke|files [label] [floor]");
  process.exit(2);
}
const API = "http://localhost:4000";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const unsupported = (process.env.FLOOR_UNSUPPORTED ?? "").split(",").filter(Boolean);
let checks = 0;
let fails = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} [${label}] ${what}`);
};

async function session(email) {
  const res = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "aerowise-dev" }) });
  if (res.status !== 200) throw new Error(`${email} sign-in ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { cookie, ...(body && !Buffer.isBuffer(body) ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON (a file or an empty answer): callers use the status and text.
    }
    return { status: r.status, json, text };
  };
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), put: (p, b, h) => call("PUT", p, b, h), patch: (p, b) => call("PATCH", p, b) };
}
/** The phone's summary checksum: SHA-256 of the canonical JSON (keys sorted), as packages/domain computes it. */
const canonicalJson = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonicalJson).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`
      : JSON.stringify(v);
const snapshotSha256 = (summary) => createHash("sha256").update(canonicalJson(summary)).digest("hex");
const must = (res, status, what) => {
  if (res.status !== status) throw new Error(`${what}: ${res.status} ${res.text.slice(0, 200)}`);
  return res.json;
};

const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
try {
  const org = (await db.query("select m.organization_id as id from memberships m join users u on u.id = m.user_id where u.email = 'owner@example.com'")).rows[0].id;
  const owner = await session("owner@example.com");

  if (mode === "fixtures") {
    // A repair done on the phone (record, two photos, signature), an accepted estimate with a
    // deposit, and a plan with a coverage rule: the service-workflow rows the floor must read.
    const tech = await session("tech@example.com");
    const { today } = must(await owner.get("/obligations/due?limit=1"), 200, "due list");
    const types = must(await owner.get("/work-types"), 200, "work types").items;
    const site = must(await owner.get("/sites?limit=1"), 200, "sites").items[0];
    const techs = must(await owner.get("/technicians"), 200, "technicians").items;
    const wo = must(await owner.post("/work-orders", { siteId: site.id, workTypeId: types.find((t) => t.key === "repair").id, title: "Drill B repair" }), 201, "work order");
    const sched = must(await owner.post(`/work-orders/${wo.id}/schedule`, { technicianId: techs.find((t) => t.name === "Tess Tech").id, scheduledDate: today }), 201, "schedule");
    const jobId = sched.visits[0].jobId;
    const form = must(await tech.get("/form-templates/work-repair"), 200, "repair form");
    const clientId = crypto.randomUUID();
    const summary = { workDone: "Replaced the float switch", parts: [], notes: "" };
    const sync = (status, revision) =>
      tech.put("/work/sync", { clientId, jobId, templateId: form.id, status, revision, arrivedAt: `${today}T15:00:00Z`, completedAt: status === "completed" ? `${today}T16:00:00Z` : null, values: { problem: "Alarm", work_performed: "Replaced the float switch", follow_up_needed: false }, summary });
    must(await sync("draft", 1), 200, "draft");
    for (const key of ["before", "after"]) must(await tech.put(`/work/${clientId}/photos/${crypto.randomUUID()}`, JPEG, { "content-type": "image/jpeg", "x-photo-key": key }), 201, `photo ${key}`);
    must(
      await tech.put(`/work/${clientId}/signatures/${crypto.randomUUID()}`, { requirementKey: "customer_signoff", signerName: "Pat Customer", capture: { kind: "typed" }, summary, summarySha256: snapshotSha256(summary), consentText: "I confirm this work was done.", signedAt: `${today}T15:55:00Z` }),
      201,
      "signature",
    );
    must(await sync("completed", 2), 200, "completion");
    const est = must(await owner.post("/estimates", { siteId: site.id, lines: [{ description: "Replace aerator", quantity: 1, unitPriceCents: 60000 }], depositCents: 15000 }), 201, "estimate");
    must(await owner.post(`/estimates/${est.id}/record-acceptance`, { evidence: "Signed paper copy" }), 200, "estimate acceptance");
    const plan = must(await owner.post("/plans", { name: "Drill B Gold", termMonths: 12, visitsPerTerm: 2, priceCents: 40000 }), 201, "plan");
    must(await owner.post(`/plans/${plan.id}/versions`, { termsText: "Fictional test terms.", options: [], coverage: [{ ruleKey: "repairs", label: "Repairs", match: { category: "repair" }, effect: "included", limit: { count: 1, per: "term" } }] }), 201, "plan version");
    const rec = (await db.query("select status, validation_status from work_records where job_id = $1", [jobId])).rows[0];
    check(rec?.status === "completed" && rec?.validation_status === "valid", "a repair record completed on the phone, with two photos and a signature");
    check(Number((await db.query("select count(*) n from work_attachments where organization_id = $1", [org])).rows[0].n) >= 2, "work photos stored");
  }

  if (mode === "smoke") {
    const tech = await session("tech@example.com");
    const { today } = must(await owner.get("/obligations/due?limit=1"), 200, "due list");
    const skip = (p) => onFloor && unsupported.some((u) => p.startsWith(u));
    const expect200 = async (who, api, p) => {
      const r = await api.get(p);
      if (skip(p)) return check(r.status === 404, `${who} GET ${p} is newer than the floor: UNSUPPORTED on the floor (answered ${r.status})`);
      check(r.status === 200, `${who} GET ${p} -> ${r.status}`);
      return r.json;
    };
    // Lists the floor supports, as the owner and the technician.
    const lists = ["/customers", "/estimates", "/exports", "/filings", "/form-templates", "/inbox", "/invoices", "/plans", "/service-items", "/service-requests", "/sites", "/work-orders", "/work-types", "/work/conflicts", "/subscription", "/form-templates?purpose=intake", `/schedule?from=${today}&to=${today}`];
    for (const p of lists) await expect200("owner", owner, p);
    for (const p of ["/route", "/work/route"]) await expect200("technician", tech, p);
    // Every record of the signed-in company (never another company's) answers 200.
    const ids = async (q) => (await db.query(q, [org])).rows.map((r) => r.id);
    const details = [
      ["/work-orders/", await ids("select id from work_orders where organization_id = $1")],
      ["/work-records/", await ids("select id from work_records where organization_id = $1")],
      ["/invoices/", await ids("select id from invoices where organization_id = $1")],
      ["/estimates/", await ids("select id from estimates where organization_id = $1")],
      ["/plans/", await ids("select id from plans where organization_id = $1")],
      ["/contracts/", await ids("select id from contracts where organization_id = $1 order by id limit 40")],
    ];
    for (const [prefix, list] of details.slice(0, 4)) check(list.length > 0, `the company has ${prefix.slice(1, -1)} to read (${list.length})`);
    for (const [prefix, list] of details) for (const id of list) await expect200("owner", owner, `${prefix}${id}`);
    for (const id of await ids("select job_id as id from work_records where organization_id = $1")) await expect200("owner", owner, `/jobs/${id}/work-record`);
  }

  if (mode === "files") {
    // Each stored work photo downloads through its signed link with the checksum recorded for it.
    const records = (await db.query("select id from work_records where organization_id = $1", [org])).rows;
    let seen = 0;
    for (const { id } of records) {
      const rec = must(await owner.get(`/work-records/${id}`), 200, "work record");
      for (const photo of rec.photos) {
        const want = (await db.query("select sha256 from work_attachments where id = $1", [photo.id])).rows[0].sha256;
        const res = await fetch(`${API}${photo.url.replace(/^\/api/, "")}`);
        const got = createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
        check(res.status === 200 && got === want, `photo ${photo.id} downloads (${res.status}) with its recorded checksum`);
        seen++;
      }
    }
    check(seen >= 2, `${seen} stored work photos retrieved`);
  }
} catch (e) {
  fails++;
  console.log(`FAIL [${label}] ${e?.stack ?? e}`);
} finally {
  await db.end().catch(() => {});
  console.log(`STEP ${mode} ${label} END checks=${checks} fails=${fails}`);
  process.exitCode = fails ? 1 : 0;
}
