// SW-12 Drill B, API part (plan §12 rows 12 and 21): run only from scripts/sw12/drill-app-floor.sh.
// Scratch only: it talks to http://localhost:4000 and the scratch database it is given.
//
//   node drills/app-floor.mjs fixtures                 service-workflow records for the demo company
//                                                      (core, SW-6 pumping and disposal, SW-7 installation,
//                                                      SW-9 pumping cycle)
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
  return { cookie, get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), put: (p, b, h) => call("PUT", p, b, h), patch: (p, b) => call("PATCH", p, b) };
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
    // SW-6: a pump-out on the phone, a disposal load carrying it, and the load's manifest photo.
    const truck = must(await owner.post("/vehicles", { name: `Drill B truck ${clientId.slice(0, 6)}`, capacityGallons: 3000 }), 201, "truck");
    const facility = must(await owner.post("/disposal-facilities", { name: `Drill B plant ${clientId.slice(0, 6)}`, kind: "wastewater_treatment_plant", city: "Austin" }), 201, "facility");
    const tessId = techs.find((t) => t.name === "Tess Tech").id;
    const pwo = must(await owner.post("/work-orders", { siteId: site.id, workTypeId: types.find((t) => t.key === "pumping").id, title: "Drill B pump-out" }), 201, "pumping work order");
    const pjob = must(await owner.post(`/work-orders/${pwo.id}/schedule`, { technicianId: tessId, scheduledDate: today }), 201, "pumping schedule").visits[0].jobId;
    const pform = must(await tech.get("/form-templates/work-pumping"), 200, "pumping form");
    const pclient = crypto.randomUUID();
    const psync = (status, revision) =>
      tech.put("/work/sync", { clientId: pclient, jobId: pjob, templateId: pform.id, status, revision, arrivedAt: `${today}T15:00:00Z`, completedAt: status === "completed" ? `${today}T16:00:00Z` : null, values: { tank_count: 1, lid_condition: "good" }, pumpOut: { clientId: crypto.randomUUID(), volume: 1000, unit: "gallons", wasteType: "septage", tanks: [{ label: "Tank 1", volume: 1000 }], vehicleId: truck.id } });
    must(await psync("draft", 1), 200, "pump-out draft");
    must(await psync("completed", 2), 200, "pump-out completion");
    const pumpingGroup = must(await owner.get(`/pumping-records?workOrderId=${pwo.id}`), 200, "pump-outs").items[0].groupId;
    const loadClient = crypto.randomUUID();
    must(await tech.put("/disposal/loads/sync", { clientId: loadClient, vehicleId: truck.id, facilityId: facility.id, deliveredOn: today, manifestReference: "DRILL-B-1", total: 1000, unit: "gallons", pumpingGroupIds: [pumpingGroup] }), 201, "disposal load");
    must(await tech.put(`/disposal/loads/${loadClient}/photos/${crypto.randomUUID()}`, JPEG, { "content-type": "image/jpeg", "x-photo-key": "manifest" }), 201, "manifest photo");

    // SW-7: a two-visit installation; the final visit carries the customer's completion sign-off.
    const iwo = must(await owner.post("/work-orders", { siteId: site.id, workTypeId: types.find((t) => t.key === "installation").id, title: "Drill B installation" }), 201, "installation work order");
    const iform = must(await tech.get("/form-templates/work-installation"), 200, "installation form");
    for (const finalVisit of [false, true]) {
      const visits = must(await owner.post(`/work-orders/${iwo.id}/schedule`, { technicianId: tessId, scheduledDate: today }), 201, "installation schedule").visits;
      const ijob = visits[visits.length - 1].jobId;
      const iclient = crypto.randomUUID();
      const isummary = { workOrder: "Drill B installation", visit: ijob, anotherVisitNeeded: !finalVisit };
      const isync = (status, revision) =>
        tech.put("/work/sync", { clientId: iclient, jobId: ijob, templateId: iform.id, status, revision, arrivedAt: `${today}T15:00:00Z`, completedAt: status === "completed" ? `${today}T17:00:00Z` : null, values: { system_status: "new", bedrooms: 3, tank_sizes: "1,000 gal", work_performed: "Set the tank" }, summary: isummary, finalVisit });
      must(await isync("draft", 1), 200, "installation draft");
      for (const key of finalVisit ? ["install_location", "as_built"] : ["install_location"]) must(await tech.put(`/work/${iclient}/photos/${crypto.randomUUID()}`, JPEG, { "content-type": "image/jpeg", "x-photo-key": key }), 201, `installation photo ${key}`);
      if (finalVisit) {
        must(
          await tech.put(`/work/${iclient}/signatures/${crypto.randomUUID()}`, { requirementKey: "customer_completion", signerName: "Pat Customer", capture: { kind: "typed" }, summary: isummary, summarySha256: snapshotSha256(isummary), consentText: "I confirm this work was done.", signedAt: `${today}T16:55:00Z` }),
          201,
          "completion sign-off",
        );
      }
      must(await isync("completed", 2), 200, "installation visit completion");
    }

    // SW-9: a pumping-only plan with a six-monthly pumping cycle, contracted on a new site; its first
    // visit booked as a work order and done on the phone with a pump-out, its second left open.
    const customer = must(await owner.get("/customers?limit=1"), 200, "customers").items[0];
    const cplan = must(await owner.post("/plans", { name: "Drill B pumping cycle", termMonths: 12, visitsPerTerm: 2, priceCents: 40000 }), 201, "cycle plan");
    must(
      await owner.post(`/plans/${cplan.id}/versions`, {
        termsText: null,
        options: [],
        coverage: [],
        aerobic: false,
        serviceCycles: [{ cycleKey: "pumping", label: "Tank pumping", serviceType: "pumping", workTypeId: types.find((t) => t.key === "pumping").id, schedule: { kind: "every_months", everyMonths: 6, windowDays: 30 }, allowNoVisit: false }],
      }),
      201,
      "cycle plan version",
    );
    const csite = must(await owner.post(`/customers/${customer.id}/sites`, { addressLine1: `${clientId.slice(0, 4)} Drill Cycle Rd`, city: "Austin" }), 201, "cycle site");
    const ccontract = must(await owner.post(`/sites/${csite.id}/contracts`, { planId: cplan.id, startOn: today }), 201, "cycle contract");
    const cvisits = ccontract.obligations.filter((o) => o.serviceType === "pumping").sort((x, y) => x.sequence - y.sequence);
    check(cvisits.length >= 2, `the cycle contract has its pumping visits (${cvisits.length})`);
    const cwo = must(await owner.post(`/obligations/${cvisits[0].id}/work-order`, {}), 201, "cycle visit booked");
    const cjob = must(await owner.post(`/work-orders/${cwo.id}/schedule`, { technicianId: tessId, scheduledDate: today }), 201, "cycle visit schedule").visits[0].jobId;
    const cclient = crypto.randomUUID();
    const csync = (status, revision) =>
      tech.put("/work/sync", { clientId: cclient, jobId: cjob, templateId: pform.id, status, revision, arrivedAt: `${today}T17:00:00Z`, completedAt: status === "completed" ? `${today}T18:00:00Z` : null, values: { tank_count: 1, lid_condition: "good" }, pumpOut: { clientId: crypto.randomUUID(), volume: 900, unit: "gallons", wasteType: "septage", tanks: [{ label: "Tank 1", volume: 900 }], vehicleId: truck.id } });
    must(await csync("draft", 1), 200, "cycle visit draft");
    must(await csync("completed", 2), 200, "cycle visit completion");

    const rec = (await db.query("select status, validation_status from work_records where job_id = $1", [jobId])).rows[0];
    check(rec?.status === "completed" && rec?.validation_status === "valid", "a repair record completed on the phone, with two photos and a signature");
    check(Number((await db.query("select count(*) n from work_attachments where organization_id = $1", [org])).rows[0].n) >= 2, "work photos stored");
    check(Number((await db.query("select count(*) n from work_attachments where organization_id = $1 and disposal_load_group_id is not null", [org])).rows[0].n) >= 1, "a disposal load with its manifest photo stored");
    check((await db.query("select status from work_orders where id = $1", [iwo.id])).rows[0].status === "completed", "an installation completed on its final visit");
    check(
      Number((await db.query("select count(*) n from signed_documents d join work_records r on r.organization_id = d.organization_id and r.offline_client_id = d.record_client_id where r.work_order_id = $1 and d.kind = 'work_completion'", [iwo.id])).rows[0].n) === 1,
      "one completion sign-off for the installation",
    );
    check((await db.query("select status from service_obligations where id = $1", [cvisits[0].id])).rows[0].status === "completed", "the booked pumping visit completed with its work order");
    check((await db.query("select status from service_obligations where id = $1", [cvisits[1].id])).rows[0].status === "open", "the next pumping visit stays open");
    check(
      Number((await db.query("select count(*) n from work_orders where obligation_id = $1 and obligation_service_type = 'pumping' and status = 'completed'", [cvisits[0].id])).rows[0].n) === 1,
      "one completed pumping work order for the visit",
    );
  }

  if (mode === "smoke") {
    const tech = await session("tech@example.com");
    const { today } = must(await owner.get("/obligations/due?limit=1"), 200, "due list");
    // An entry starting with "/" is a path prefix; any other entry is a path suffix (".../completion-summary.pdf").
    const skip = (p) => onFloor && unsupported.some((u) => (u.startsWith("/") ? p.startsWith(u) : p.endsWith(u)));
    const expect200 = async (who, api, p) => {
      const r = await api.get(p);
      if (skip(p)) return check(r.status === 404, `${who} GET ${p} is newer than the floor: UNSUPPORTED on the floor (answered ${r.status})`);
      check(r.status === 200, `${who} GET ${p} -> ${r.status}`);
      return r.json;
    };
    // Lists the floor supports, as the owner and the technician.
    const lists = ["/customers", "/estimates", "/exports", "/filings", "/form-templates", "/inbox", "/invoices", "/plans", "/service-items", "/service-requests", "/sites", "/work-orders", "/work-types", "/work/conflicts", "/subscription", "/form-templates?purpose=intake", `/schedule?from=${today}&to=${today}`, "/vehicles", "/disposal-facilities", "/pumping-records", "/disposal/loads", "/pumping/settings"];
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
    details.push(
      ["/pumping-records/", await ids("select distinct group_id as id from pumping_records where organization_id = $1")],
      ["/disposal/loads/", await ids("select distinct group_id as id from disposal_loads where organization_id = $1")],
    );
    for (const [prefix, list] of details) for (const id of list) await expect200("owner", owner, `${prefix}${id}`);
    // SW-7: every completed installation's completion summary.
    const installs = await ids("select w.id from work_orders w join work_types t on t.id = w.work_type_id where w.organization_id = $1 and t.key = 'installation' and w.status = 'completed'");
    if (!skip("/work-orders/x/completion-summary.pdf")) check(installs.length > 0, `the company has completed installations to read (${installs.length})`);
    for (const id of installs) await expect200("owner", owner, `/work-orders/${id}/completion-summary.pdf`);
    for (const id of await ids("select job_id as id from work_records where organization_id = $1")) await expect200("owner", owner, `/jobs/${id}/work-record`);
    // SW-9: every contract with a pumping or maintenance cycle, and the due list of those visits.
    const cycleContracts = await ids("select distinct contract_id as id from contract_service_cycles where organization_id = $1 and service_type <> 'aerobic_inspection'");
    check(cycleContracts.length > 0, `the company has cycle contracts to read (${cycleContracts.length})`);
    for (const id of cycleContracts) await expect200("owner", owner, `/contracts/${id}`);
    await expect200("owner", owner, "/obligations/due?serviceType=pumping");
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

    // SW-6: each disposal load's manifest photos, with their recorded checksums.
    let manifests = 0;
    for (const { id } of (await db.query("select distinct group_id as id from disposal_loads where organization_id = $1", [org])).rows) {
      const load = must(await owner.get(`/disposal/loads/${id}`), 200, "disposal load");
      for (const photo of load.photos) {
        const want = (await db.query("select sha256 from work_attachments where id = $1", [photo.id])).rows[0].sha256;
        const res = await fetch(`${API}${photo.url.replace(/^\/api/, "")}`);
        const got = createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
        check(res.status === 200 && got === want, `manifest photo ${photo.id} downloads (${res.status}) with its recorded checksum`);
        manifests++;
      }
    }
    check(manifests >= 1, `${manifests} stored manifest photos retrieved`);

    // SW-7: each completed installation's completion summary is made from the restored records,
    // and its completion sign-off is the one recorded (same checksum).
    const installs = (await db.query("select w.id from work_orders w join work_types t on t.id = w.work_type_id where w.organization_id = $1 and t.key = 'installation' and w.status = 'completed'", [org])).rows;
    for (const { id } of installs) {
      const res = await fetch(`${API}/work-orders/${id}/completion-summary.pdf`, { headers: { cookie: owner.cookie } });
      const pdf = Buffer.from(await res.arrayBuffer());
      check(res.status === 200 && pdf.subarray(0, 5).toString() === "%PDF-", `installation ${id} completion summary is a PDF (${res.status}, ${pdf.length} bytes)`);
      const signed = (await db.query("select d.content_sha256 as sha256 from signed_documents d join work_records r on r.organization_id = d.organization_id and r.offline_client_id = d.record_client_id where r.work_order_id = $1 and d.kind = 'work_completion'", [id])).rows;
      check(signed.length === 1 && /^[0-9a-f]{64}$/.test(signed[0].sha256 ?? ""), `installation ${id} keeps its one completion sign-off with its checksum`);
    }
    check(installs.length >= 1, `${installs.length} completed installations summarized`);

    // SW-9: each cycle contract reads back its cycles, and each booked visit names its work order.
    const booked = (await db.query("select o.contract_id, o.id, w.id as wo from service_obligations o join work_orders w on w.obligation_id = o.id and w.status <> 'cancelled' where o.organization_id = $1 and o.service_type <> 'aerobic_inspection'", [org])).rows;
    for (const b of booked) {
      const c = must(await owner.get(`/contracts/${b.contract_id}`), 200, "cycle contract");
      const visit = c.obligations.find((o) => o.id === b.id);
      check(c.cycles.some((y) => y.serviceType !== "aerobic_inspection") && visit?.workOrder?.id === b.wo, `cycle visit ${b.id} keeps its cycle and its work order`);
    }
    check(booked.length >= 1, `${booked.length} booked cycle visits read back`);
  }
} catch (e) {
  fails++;
  console.log(`FAIL [${label}] ${e?.stack ?? e}`);
} finally {
  await db.end().catch(() => {});
  console.log(`STEP ${mode} ${label} END checks=${checks} fails=${fails}`);
  process.exitCode = fails ? 1 : 0;
}
