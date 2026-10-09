import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { openContractFiling, OutboxTransport, prepareFilingById } from "@aerowise/compliance";
import { DEMO_ORG_NAME, type Database } from "@aerowise/db";
import { addDays, addMonths, DEFAULT_TEMPLATE, parseFeatures, snapshotSha256, type Feature } from "@aerowise/domain";
import type { ObjectStore } from "@aerowise/storage";
import { complianceContext, drainTasks } from "@aerowise/tasks";
import { buildApp, type App } from "./app.ts";
import { createSession, SESSION_COOKIE } from "./auth/sessions.ts";

// The demo's five-minute path, played once on top of the seed: what a provider would have
// done before a prospect opens the demo. Everything goes through the API as the demo users,
// with every outside service a stand-in, so the records are exactly what the product makes.
//
//   - The owner's MP license and the technician's registration on file, the owner as the
//     company's responsible MP (so reports can be signed and filings released).
//   - The Spicewood, Lago Vista and Jonestown sites report to LCRA, assigned by the office with an
//     evidence note that says the assignment is fictional, and a fictional LCRA application number
//     on each; the Blanco sites stay with the fictional Example County. Every active contract on
//     an LCRA site has a (fictional) signed copy on file and its contract filing emailed.
//   - The year so far: every visit due before last week was inspected on its day, on the story's
//     own clock, so reports were made, signed by the MP and filed when they would have been
//     (by email: the office presses Send for LCRA, the example county sends by itself). Sites have real history.
//   - Yesterday, the technician finished two overdue inspections. Their reports were made
//     and filed with the (fictional) Example County by email; the outbox keeps the proof.
//     The county answered one, so it is confirmed with a reference; the other waits.
//   - A contract ending in three weeks has a renewal sent to the customer.
//   - Invoices: one sent and unpaid, one paid by card on the test checkout.
//   - With work orders switched on (AEROWISE_FEATURES): the inspections noted a repair and a
//     pump-out; the pump-out became a work order done yesterday and invoiced, the repair one
//     scheduled for tomorrow, and a homeowner's portal request became a third, ready to schedule.
//     With service items switched on too, the company has a small catalog and the pump-out is
//     priced by the gallon and the hour and invoiced straight from its work order.
//   - With estimates on: one sent and waiting, one signed by a fictional homeowner; with
//     deposits on too, the signed one asked for a deposit, paid by card on the test checkout.
//   - With field work and pumping on too: the technician recorded that pump-out on the phone (1,000
//     gallons on a fictional truck) and delivered it to a fictional facility, recorded as a
//     disposal record with a demo manifest/reference number. Nothing says it is compliant.
//   - With field work on: a two-visit installation done on the phone, finished yesterday with the
//     fictional homeowner's completion sign-off; its completion summary is in their portal.
//   - With service cycles on (SW-9): a fictional pumping-only plan, and a fictional customer
//     with a conventional system on it from five months ago. Its two pumping visits are frozen on
//     the contract; the first, due next month, is booked as a work order ready to schedule. They
//     are never inspections: nothing is reported or filed for them.
//   - With the plan builder switched on: three fictional plan tiers (Basic, Gold, Platinum) whose
//     own terms say they are fictional, with different coverage and options, and an intake form
//     the Gold and Platinum tiers ask at online signing. No real terms or coverage are promised.
//
// Today's and tomorrow's route is left alone for the visitor to work through.

/** A one-page PDF standing in for a signed maintenance contract: the demo files it with the real authorities. */
const CONTRACT_PDF = (() => {
  const text = "FICTIONAL signed maintenance contract for the Aerowise demo. Not a real agreement.";
  const content = `BT /F1 14 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
})();

const PHOTOS = {
  overview: readFileSync(new URL("./demo-assets/demo-overview.jpg", import.meta.url)),
  chlorinator: readFileSync(new URL("./demo-assets/demo-chlorinator.jpg", import.meta.url)),
};

function as(app: App, cookie: string) {
  const call = async (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method, url, payload: payload as never, headers: { cookie, ...headers } });
    if (res.statusCode >= 300 && res.statusCode !== 302) throw new Error(`demo story: ${method} ${url} answered ${res.statusCode} ${res.body}`);
    return res;
  };
  return {
    get: (url: string) => call("GET", url).then((r) => r.json()),
    post: (url: string, body: object = {}) => call("POST", url, body).then((r) => r.json()),
    put: (url: string, body: object) => call("PUT", url, body).then((r) => r.json()),
    patch: (url: string, body: object) => call("PATCH", url, body).then((r) => r.json()),
    photo: (url: string, body: Buffer, headers: Record<string, string>) =>
      app.inject({ method: "PUT", url, payload: body, headers: { cookie, "content-type": "image/jpeg", ...headers } }).then((r) => {
        if (r.statusCode >= 300) throw new Error(`demo story: photo ${url} answered ${r.statusCode} ${r.body}`);
      }),
    raw: call,
  };
}

/**
 * SW-6: the technician pumps on the phone (a fictional truck), then delivers the load to a
 * fictional facility the owner entered, recorded as a disposal record with a demo reference.
 */
async function pumpedOnThePhone(owner: ReturnType<typeof as>, tech: ReturnType<typeof as>, jobId: string, day: string) {
  const truck = await owner.post("/vehicles", { name: "Truck 1 (demo)", plate: "DEMO-001", capacityGallons: 3000 });
  const facility = await owner.post("/disposal-facilities", {
    name: "Example Water Reclamation (fictional)",
    kind: "wastewater_treatment_plant",
    city: "Example City",
    state: "TX",
    notes: "Fictional facility for the demo; not a real place.",
  });
  const form = await tech.get("/form-templates/work-pumping");
  const clientId = randomUUID();
  const base = {
    clientId,
    jobId,
    templateId: form.id,
    arrivedAt: afternoon(day, "15:00"),
    values: { tank_count: 2, lid_condition: "good", sludge_scum: "Sludge near the top of the pretreatment tank." },
    pumpOut: { clientId: randomUUID(), volume: 1000, unit: "gallons", wasteType: "septage", tanks: [{ label: "Pretreatment", volume: 600 }, { label: "Aerobic", volume: 400 }], vehicleId: truck.id },
  };
  await tech.put("/work/sync", { ...base, status: "draft", revision: 1 });
  const done = await tech.put("/work/sync", { ...base, status: "completed", revision: 2, completedAt: afternoon(day, "16:00"), finalVisit: true });
  if (done.status !== "completed") throw new Error(`demo story: pumping visit did not complete: ${JSON.stringify(done.validationProblems ?? done)}`);
  const pumped = await tech.get(`/pumping/field`);
  const groupIds = (pumped.unloaded as { groupId: string; workRecordId: string }[]).filter((p) => p.workRecordId === done.id).map((p) => p.groupId);
  await tech.put("/disposal/loads/sync", {
    clientId: randomUUID(),
    vehicleId: truck.id,
    facilityId: facility.id,
    deliveredOn: day,
    manifestReference: "DEMO-MANIFEST-0001",
    total: 1000,
    unit: "gallons",
    notes: "Fictional demo record.",
    pumpingGroupIds: groupIds,
  });
}

/**
 * SW-7: a two-visit installation recorded on the phone. The first visit needs another one; the
 * second finishes the work, with the fictional homeowner's completion sign-off given once.
 */
async function installedOnThePhone(office: ReturnType<typeof as>, tech: ReturnType<typeof as>, techId: string, siteId: string, days: [string, string]) {
  const kind = ((await office.get("/work-types")).items as { id: string; key: string }[]).find((t) => t.key === "installation");
  if (!kind) return false;
  const wo = await office.post("/work-orders", { siteId, workTypeId: kind.id, title: "Replace the drip field", description: "Fictional: new drip field lines and a replacement pump tank." });
  const form = await tech.get("/form-templates/work-installation");
  for (const [i, day] of days.entries()) {
    const finalVisit = i === days.length - 1;
    const scheduled = await office.post(`/work-orders/${wo.id}/schedule`, { technicianId: techId, scheduledDate: day, notes: finalVisit ? "Finish the field and walk the homeowner through it." : "Set the pump tank." });
    const jobId = (scheduled.visits as { jobId: string }[]).at(-1)!.jobId;
    const clientId = randomUUID();
    const values = {
      system_status: "existing",
      bedrooms: 3,
      tank_sizes: "Pump tank: 1,000 gallons",
      line_lengths: finalVisit ? "6 lines, 50 ft each" : "",
      work_performed: finalVisit ? "Laid and pressure-tested the drip lines; restored the yard." : "Set and leveled the pump tank; ran the conduit.",
    };
    const base = { clientId, jobId, templateId: form.id, arrivedAt: afternoon(day, "14:00"), values, finalVisit };
    await tech.put("/work/sync", { ...base, status: "draft", revision: 1 });
    await tech.photo(`/work/${clientId}/photos/${randomUUID()}`, PHOTOS.overview, { "x-photo-key": "install_location", "x-captured-at": afternoon(day, "14:30") });
    let summary: object | null = null;
    if (finalVisit) {
      summary = { workOrder: "Replace the drip field", visit: 2, anotherVisitNeeded: false, answers: [{ label: "Work done on this visit", answer: values.work_performed }] };
      await tech.put(`/work/${clientId}/signatures/${randomUUID()}`, {
        requirementKey: "customer_completion",
        signerName: "Pat Example (fictional)",
        capture: { kind: "typed" },
        summary,
        summarySha256: await snapshotSha256(summary),
        consentText: "I have read the summary of the work above and confirm it describes the work done at this property.",
        signedAt: afternoon(day, "16:50"),
      });
    }
    const done = await tech.put("/work/sync", { ...base, status: "completed", revision: 2, completedAt: afternoon(day, "17:00"), summary });
    if (done.status !== "completed") throw new Error(`demo story: installation visit did not complete: ${JSON.stringify(done.validationProblems ?? done)}`);
  }
  return true;
}

/** A session made for the person directly: demo people may have no password (W10.2). */
async function signIn(app: App, db: Database, organizationId: string, userId: string) {
  const { token } = await createSession(db, organizationId, userId);
  return as(app, `${SESSION_COOKIE}=${token}`);
}

const chicagoDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
/** An afternoon time on a Central date, as UTC (Central is UTC-5 or -6; 20:00Z is mid-afternoon either way). */
const afternoon = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00Z`).toISOString();

/**
 * Plays the story once, in the shared demo company or the one named. Returns false when
 * there is no such demo company or the story was already played there.
 */
export async function playDemoStory(opts: { db: Database; store: ObjectStore; organizationId?: string; now?: () => Date; log?: (msg: string) => void; features?: ReadonlySet<Feature> }): Promise<boolean> {
  const { db, store, now: realNow = () => new Date(), log = () => {}, features = parseFeatures(process.env.AEROWISE_FEATURES) } = opts;
  // The story's clock. The year's history is played on its own days (a job scheduled, an
  // inspection completed, its report made, signed and filed when they would have been), then the
  // clock returns to the present for yesterday's work and everything after it.
  let clockAt: Date | null = null;
  const now = () => clockAt ?? realNow();
  const work = features.has("work_orders");
  const catalog = work && features.has("service_items");
  const tiers = features.has("plan_builder");
  // SW-6: the pump-out is recorded on the technician's phone, with a fictional truck and facility.
  const pumping = work && features.has("field_work") && features.has("pumping");
  // SW-7: an installation recorded on the phone over two visits.
  const fieldWork = work && features.has("field_work");
  // SW-9: a pumping-only plan's visits, frozen on a contract and booked as work.
  const cycles = work && tiers && features.has("service_cycles");
  const found = db.selectFrom("organizations").select(["id", "demo"]);
  const org = await (opts.organizationId ? found.where("id", "=", opts.organizationId) : found.where("name", "=", DEMO_ORG_NAME).where("demoExpiresAt", "is", null)).executeTakeFirst();
  if (!org?.demo) {
    log("demo story: no demo company; nothing to do");
    return false;
  }
  const played = await db.selectFrom("inspections").select("id").where("organizationId", "=", org.id).limit(1).executeTakeFirst();
  if (played) {
    log("demo story: already played; nothing to do");
    return false;
  }

  const mail = new OutboxTransport(store, now);
  const appUrl = process.env.PUBLIC_APP_URL ?? "http://localhost:3000";
  // Not production: every outside service is a stand-in and the fictional rules are loaded.
  const app = await buildApp({ db, store, now, mail, appUrl, production: false, loginRateLimit: 1000, logger: false, features });
  // Only the demo company's own tasks: any other company's stay queued for the real worker.
  const worker = async () => {
    // The deployed worker can claim a report before this inline drain does. Wait for
    // its in-flight work (and drain anything it queues) before advancing the story.
    const deadline = Date.now() + 30_000;
    while (true) {
      await drainTasks({ db, store, now, mail, appUrl }, "demo-story", org.id);
      const pending = await db.selectFrom("backgroundTasks").select("id")
        .where("organizationId", "=", org.id).where("completedAt", "is", null)
        .where("failedAt", "is", null).where("runAt", "<=", now())
        .limit(1).executeTakeFirst();
      if (!pending) return;
      if (Date.now() >= deadline) throw new Error("demo story: timed out waiting for the worker");
      await pause(50);
    }
  };
  try {
    const members = await db
      .selectFrom("memberships as m")
      .innerJoin("users as u", "u.id", "m.userId")
      .select(["u.id", "u.name", "m.role"])
      .where("m.organizationId", "=", org.id)
      .execute();
    const ownerId = members.find((m) => m.role === "owner")!.id;
    const officeId = members.find((m) => m.role === "office")!.id;
    const techId = members.find((m) => m.role === "technician")!.id;
    const owner = await signIn(app, db, org.id, ownerId);
    const office = await signIn(app, db, org.id, officeId);
    const tech = await signIn(app, db, org.id, techId);
    const today = chicagoDate(realNow());
    const yesterday = addDays(today, -1);
    const template = await tech.get("/inspection-template");

    /** One visit inspected on the phone that day: started, photographed, completed through the API. */
    const inspectVisit = async (
      visit: { id: string; siteId: string; lat: number | null; lng: number | null },
      day: string,
      o: { times: [string, string, string]; chlorine: number; airPressure: number; notes: string; pumping?: boolean; issues?: { clientId: string; type: string; severity: string; description: string }[] },
    ) => {
      const job = await office.post("/jobs", { obligationId: visit.id, technicianId: techId, scheduledDate: day });
      const clientId = randomUUID();
      const base = { clientId, jobId: job.jobId, templateId: template.id, arrivedAt: afternoon(day, o.times[0]), arrivalGps: { lat: visit.lat ?? 30.19, lng: visit.lng ?? -98.09, accuracyM: 8 } };
      await tech.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
      for (const key of ["overview", "chlorinator"] as const) {
        await tech.photo(`/inspections/${clientId}/photos/${randomUUID()}`, PHOTOS[key], { "x-photo-key": key, "x-captured-at": afternoon(day, o.times[1]) });
      }
      const values: Record<string, string | number | boolean> = {};
      for (const f of DEFAULT_TEMPLATE.definition.fields) if (f.type === "pass_fail") values[f.key] = "pass";
      Object.assign(values, {
        // Every demo unit has a tablet or liquid chlorinator (seed.ts), and it was working.
        chlorinator: "working",
        chlorine_level: o.chlorine,
        chlorine_added: 2,
        air_pressure: o.airPressure,
        odor: "none",
        pumping_needed: o.pumping ?? false,
        // The report fields some authorities ask for (form v2), so any authority's check passes.
        pump_tank_sludge: 6,
        pump_tank_ph: 7.2,
        spray_area: "acceptable",
        unauthorized_alterations: "none_found",
        notes: o.notes,
      });
      const done = await tech.put("/inspections/sync", { ...base, status: "completed", completedAt: afternoon(day, o.times[2]), values, issues: o.issues ?? [] });
      if (done.status !== "completed") throw new Error(`demo story: inspection did not complete: ${JSON.stringify(done.validationProblems ?? done)}`);
      return done as { id: string };
    };

    const filingOfInspection = async (inspectionId: string) =>
      (await db.selectFrom("filings").select("id").where("organizationId", "=", org.id).where("inspectionId", "=", inspectionId).executeTakeFirstOrThrow()).id;

    /**
     * Files a filing the way its authority takes it. A report is first signed by the MP
     * (30 TAC 285.7(b)(3)); then the office presses Send for an email authority, or records a
     * filing by hand with the reference the portal gave. The example county's automatic email
     * needs nothing. Returns the filing, or null when it could not be filed (left for the inbox).
     */
    const fileFiling = async (filingId: string, reference: string) => {
      const read = () => db.selectFrom("filings").select(["id", "status", "submissionMethod", "kind", "inspectionId"]).where("organizationId", "=", org.id).where("id", "=", filingId).executeTakeFirstOrThrow();
      let f = await read();
      if (["queued", "submitting", "sent", "confirmed"].includes(f.status)) return f;
      if (f.kind === "inspection_report" && f.inspectionId) {
        await owner.post(`/inspections/${f.inspectionId}/signature`, { typedName: "Olivia Owner" });
        f = await read();
      }
      if (f.status !== "ready") return null;
      if (f.submissionMethod === "email") {
        await office.post(`/filings/${f.id}/submit`);
        await worker();
      } else if (f.submissionMethod === "manual_export") {
        await office.post(`/filings/${f.id}/mark-sent`, { reference, note: "Fictional: recorded for the demo as filed by hand on the authority's portal." });
      } else {
        return null;
      }
      return read();
    };

    // ---- Licenses on file ----
    // Verified well before the year's history, so the MP can sign every report in it.
    const mp = await owner.post("/credentials", { userId: ownerId, holderName: "Olivia Owner", kind: "tceq_maintenance_provider", number: "MP-DEMO-0001", verifiedOn: addDays(today, -420), verificationSource: "Fictional: demo company" });
    await owner.post("/credentials", { userId: techId, holderName: "Tess Tech", kind: "tceq_maintenance_technician", number: "MT-DEMO-0001", expiresOn: addDays(today, 365) });
    await owner.put("/settings/responsible-provider", { credentialId: mp.id });

    // ---- A real authority for the Lake Travis sites, as a fictional assignment ----
    // LCRA is assigned by a person (its rules say so: it covers part of Burnet and Travis
    // counties); the demo's office did that, and said in the evidence that the sites are made up.
    // LCRA's cover sheet needs the site's application number, so each gets a fictional one.
    const AUTHORITY_FOR_COUNTY: Record<string, string> = { Travis: "tx-lcra-ossf", Burnet: "tx-lcra-ossf" };
    clockAt = new Date(`${addDays(today, -400)}T15:00:00Z`);
    const sites = await db.selectFrom("sites").select(["id", "county"]).where("organizationId", "=", org.id).orderBy("createdAt").execute();
    let assigned = 0;
    for (const [n, site] of sites.entries()) {
      const key = AUTHORITY_FOR_COUNTY[site.county ?? ""];
      if (!key) continue;
      const { candidates } = (await office.get(`/sites/${site.id}/jurisdiction`)) as { candidates: { id: string; key: string }[] };
      const match = candidates.find((c) => c.key === key);
      if (!match) continue;
      if (key === "tx-lcra-ossf") {
        await office.put(`/sites/${site.id}/authority-identifiers/lcra_ossf_application_number`, { jurisdictionId: match.id, value: `LCRA-DEMO-${10000 + n}`, sourceNote: "Fictional: made up for the demo, not from a permit." });
      }
      await office.put(`/sites/${site.id}/jurisdiction`, {
        jurisdictionId: match.id,
        evidenceKind: "other",
        evidenceReference: "Fictional demo company: assigned for the walkthrough",
        evidenceNote: "This site is made up, so this is not a determination. A real site's authority is checked against its permit or the authority's own map, and that evidence is recorded here.",
      });
      assigned++;
    }

    // ---- Contracts on file with LCRA ----
    // LCRA asks for the signed maintenance contract. Each active contract on its sites has a
    // fictional signed copy on file and its contract filing emailed the day after it started.
    const compliance = complianceContext({ db, store, now, mail, appUrl });
    const realCountyContracts = await db
      .selectFrom("contracts as c")
      .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "c.siteId").onRef("s.organizationId", "=", "c.organizationId"))
      .select(["c.id", "c.startOn"])
      .where("c.organizationId", "=", org.id)
      .where("c.status", "=", "active")
      .where("c.serviceType", "=", "aerobic_inspection")
      .where("s.county", "in", Object.keys(AUTHORITY_FOR_COUNTY))
      .orderBy("c.startOn")
      .execute();
    // First every contract's copy on file and its filing opened and checked, each on its own
    // day (the worker's sweep would otherwise open the rest all at once); then each one sent.
    const contractFilings: { filingId: string; startOn: string }[] = [];
    for (const c of realCountyContracts) {
      clockAt = new Date(`${addDays(c.startOn, 1)}T16:00:00Z`);
      await office.post(`/contracts/${c.id}/document`, { filename: "signed-maintenance-contract-demo.pdf", contentBase64: CONTRACT_PDF.toString("base64"), signedOn: c.startOn });
      const opened = await db.transaction().execute((trx) => openContractFiling(trx, { organizationId: org.id, contractId: c.id, actorUserId: officeId, at: now() }));
      const filingId = opened?.id ?? (await db.selectFrom("filings").select("id").where("organizationId", "=", org.id).where("contractId", "=", c.id).executeTakeFirst())?.id;
      if (!filingId) continue;
      await prepareFilingById(compliance, org.id, filingId, officeId);
      contractFilings.push({ filingId, startOn: c.startOn });
    }
    let contractsFiled = 0;
    for (const [n, cf] of contractFilings.entries()) {
      clockAt = new Date(`${addDays(cf.startOn, 1)}T17:00:00Z`);
      const filed = await fileFiling(cf.filingId, `DEMO-C-${1001 + n}`);
      if (filed?.status === "sent") contractsFiled++;
    }

    // ---- The year so far: past visits inspected on their day, reported and filed ----
    const history = await db
      .selectFrom("serviceObligations as o")
      .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "o.siteId").onRef("s.organizationId", "=", "o.organizationId"))
      .select(["o.id", "o.siteId", "o.dueOn", "s.lat", "s.lng", "s.county"])
      .where("o.organizationId", "=", org.id)
      .where("o.serviceType", "=", "aerobic_inspection")
      .where("o.status", "=", "open")
      // Older than a week: the deliberately overdue visits (one to five days) are left for the inbox.
      .where("o.dueOn", "<", addDays(today, -6))
      .orderBy("o.dueOn")
      .execute();
    let historyConfirmed = 0;
    for (const [n, visit] of history.entries()) {
      // Done ten days before it was due, mid-afternoon.
      const day = addDays(visit.dueOn, -10);
      // The server's clock sits just after that afternoon's work, as a phone syncing at the end of the stop would find it.
      clockAt = new Date(`${day}T19:45:00Z`);
      const done = await inspectVisit(visit, day, {
        times: ["19:00", "19:10", "19:35"],
        chlorine: [1.5, 2.0, 1.0, 2.5][n % 4]!,
        airPressure: [4.5, 3.8, 4.1, 4.9][n % 4]!,
        notes: ["Everything working. Tablets topped up.", "Working well; spray heads cleared.", "Filter rinsed; tablets topped up.", "Everything working."][n % 4]!,
      });
      await worker();
      const filing = await fileFiling(await filingOfInspection(done.id), `DEMO-R-${1001 + n}`);
      // The example county replies to filings (LCRA publishes no acknowledgment): three days on,
      // the office recorded its reference.
      if (filing?.status === "sent" && visit.county === "Example County") {
        clockAt = new Date(`${addDays(day, 3)}T15:00:00Z`);
        await office.post(`/filings/${filing.id}/confirm`, { reference: `EC-DEMO-${1001 + n}`, note: "Fictional: the county clerk replied by email." });
        historyConfirmed++;
      }
    }
    clockAt = null;

    // ---- Yesterday: two overdue visits inspected and filed ----
    // Blanco sites, so the fictional county's automatic email files them and one is confirmed.
    const overdue = await db
      .selectFrom("serviceObligations as o")
      .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "o.siteId").onRef("s.organizationId", "=", "o.organizationId"))
      .select(["o.id", "o.siteId", "s.lat", "s.lng", "s.county"])
      .where("o.organizationId", "=", org.id)
      .where("o.serviceType", "=", "aerobic_inspection")
      .where("o.status", "=", "open")
      .where("o.dueOn", "<", today)
      .where("s.county", "=", "Example County")
      .orderBy("o.dueOn")
      .limit(2)
      .execute();
    const inspections: string[] = [];
    for (const [n, visit] of overdue.entries()) {
      const done = await inspectVisit(visit, yesterday, {
        times: n === 0 ? ["19:00", "19:10", "19:40"] : ["20:30", "20:40", "21:05"],
        chlorine: n === 0 ? 1.5 : 2.0,
        airPressure: n === 0 ? 4.5 : 3.8,
        pumping: n === 1,
        notes: n === 1 ? "Sludge is near the top of the pretreatment tank; pumping recommended before the next visit." : "Everything working. Tablets topped up.",
        // What the technician noted for the office to follow up, when there is work to turn it into.
        issues: !work
          ? []
          : n === 0
            ? [{ clientId: randomUUID(), type: "repair_needed", severity: "medium", description: "Alarm light flickers; float switch wiring looks loose." }]
            : [{ clientId: randomUUID(), type: "pump_out", severity: "high", description: "Sludge near the top of the pretreatment tank." }],
      });
      inspections.push(done.id);
    }
    if (inspections.length === 0) throw new Error("demo story: no visits from yesterday to inspect (was the demo seeded today?)");
    // Reports made, filings emailed to the county's outbox.
    await worker();
    const filings = await db.selectFrom("filings").select(["id", "status", "inspectionId"]).where("organizationId", "=", org.id).where("inspectionId", "in", inspections).execute();
    const first = filings.find((f) => f.inspectionId === inspections[0]);
    if (first?.status === "sent") await office.post(`/filings/${first.id}/confirm`, { reference: "EC-DEMO-0042", note: "Fictional: the county clerk replied by email." });

    // ---- A renewal for the contract that ends in three weeks ----
    const ending = await db
      .selectFrom("contracts")
      .select("id")
      .where("organizationId", "=", org.id)
      .where("endOn", ">", today)
      .where("endOn", "<=", addDays(today, 30))
      .orderBy("endOn")
      .limit(1)
      .executeTakeFirst();
    if (ending) await office.post(`/contracts/${ending.id}/renewal`, { send: true });

    // ---- Invoices: one for each of yesterday's visits; the first paid by card ----
    // Online payments on (the Stripe stand-in), so the invoices carry a pay link.
    await owner.post("/billing/stripe/connect");
    await owner.post("/billing/stripe/refresh");
    const invoiced: { id: string; token: string }[] = [];
    for (const visit of overdue) {
      const site = await db.selectFrom("sites").select("customerId").where("id", "=", visit.siteId).executeTakeFirstOrThrow();
      const draft = await office.post("/invoices", { customerId: site.customerId, siteId: visit.siteId, lines: [{ description: "Aerobic maintenance visit", quantity: 1, unitPriceCents: 9500 }, { description: "Chlorine tablets", quantity: 2, unitPriceCents: 1250, taxable: true }] });
      const issued = await office.post(`/invoices/${draft.id}/issue`, { send: true });
      invoiced.push({ id: issued.id, token: String(issued.payUrl).split("/pay/")[1]! });
    }
    await worker();
    const paying = invoiced[0];
    if (paying) {
      const visitor = as(app, "");
      const checkout = await visitor.post(`/pay/${paying.token}/checkout`);
      const sessionId = new URL(checkout.url).searchParams.get("session");
      if (sessionId) await visitor.post(`/pay/${paying.token}/test-checkout`, { sessionId, outcome: "card" });
    }
    await worker();

    // ---- Work orders, when switched on: through the same conversions the office uses ----
    let workOrders = 0;
    if (work) {
      const issues = await db.selectFrom("issues").select(["id", "type", "siteId"]).where("organizationId", "=", org.id).where("inspectionId", "in", inspections).execute();
      const pumpOut = issues.find((i) => i.type === "pump_out");
      if (pumpOut) {
        const wo = await office.post(`/issues/${pumpOut.id}/work-order`);
        if (catalog) {
          // Fictional prices for the demo company's catalog.
          const pumping = await office.post("/service-items", { name: "Pumping", unit: "gallon", unitPriceCents: 35, category: "pumping" });
          const labor = await office.post("/service-items", { name: "Labor", unit: "hour", unitPriceCents: 9500, category: "repair" });
          await office.post("/service-items", { name: "Float switch", unit: "each", unitPriceCents: 6800, taxable: true, category: "repair" });
          await office.patch(`/work-orders/${wo.id}`, {
            lines: [
              { description: "Pumping: pretreatment and aerobic tanks", quantity: 1000, unitPriceCents: 35, serviceItemId: pumping.id },
              { description: "Labor", quantity: 1.5, unitPriceCents: 9500, serviceItemId: labor.id },
            ],
          });
        }
        const visit = await office.post(`/work-orders/${wo.id}/schedule`, { technicianId: techId, scheduledDate: yesterday, notes: "Pump the pretreatment and aerobic tanks." });
        const jobId = visit.visits[0].jobId as string;
        if (pumping) await pumpedOnThePhone(owner, tech, jobId, yesterday);
        else await office.post(`/work-orders/${wo.id}/complete`, { reason: "Fictional: pumped yesterday; the technician's phone records arrive with the next phone update." });
        let invoiceId: string;
        if (catalog) {
          invoiceId = (await office.post(`/work-orders/${wo.id}/invoice`)).invoiceId;
        } else {
          const site = await db.selectFrom("sites").select("customerId").where("id", "=", pumpOut.siteId).executeTakeFirstOrThrow();
          invoiceId = (await office.post("/invoices", { customerId: site.customerId, siteId: pumpOut.siteId, lines: [{ description: "Pumping: pretreatment and aerobic tanks", quantity: 1, unitPriceCents: 42500, jobId }] })).id;
        }
        await office.post(`/invoices/${invoiceId}/issue`, { send: false });
        workOrders++;
      }
      const repair = issues.find((i) => i.type === "repair_needed");
      if (repair) {
        const wo = await office.post(`/issues/${repair.id}/work-order`);
        await office.post(`/work-orders/${wo.id}/schedule`, { technicianId: techId, scheduledDate: addDays(today, 1), notes: "Bring a float switch." });
        workOrders++;
      }
      // A homeowner asks from their portal; the office turns it into a work order.
      const site = await db.selectFrom("sites").select(["id", "customerId"]).where("organizationId", "=", org.id).orderBy("addressLine1").limit(1).executeTakeFirst();
      if (site) {
        const link = await office.post(`/customers/${site.customerId}/portal-link`, { send: false });
        const token = String(link.url).split("/").pop()!;
        const asked = await as(app, "").post(`/portal/${token}/service-requests`, { siteId: site.id, kind: "odor", description: "Smell near the spray heads after the rain." });
        await office.post(`/service-requests/${asked.id}/work-order`);
        workOrders++;
      }
      // SW-7, with field work on: a two-visit installation finished yesterday and signed off once.
      if (fieldWork) {
        const installSite = await db.selectFrom("sites").select("id").where("organizationId", "=", org.id).orderBy("addressLine1").offset(1).limit(1).executeTakeFirst();
        if (installSite && (await installedOnThePhone(office, tech, techId, installSite.id, [addDays(today, -3), yesterday]))) workOrders++;
      }
      await worker();
    }

    // ---- Estimates, when switched on: one waiting on the homeowner, one they signed ----
    let estimates = 0;
    if (work && features.has("estimates")) {
      const quoted = await db.selectFrom("sites").select(["id"]).where("organizationId", "=", org.id).orderBy("addressLine1", "desc").limit(2).execute();
      const [waiting, signed] = quoted;
      const lines = [
        { description: "Replace the aerator", quantity: 1, unitPriceCents: 48500 },
        { description: "Upgrade to a remote alarm", quantity: 1, unitPriceCents: 16500, optional: true, selectedByDefault: false },
      ];
      if (waiting) {
        const e = await office.post("/estimates", { siteId: waiting.id, title: "Aerator replacement", lines, expiresOn: addDays(today, 30) });
        await office.post(`/estimates/${e.id}/send`, { email: false });
        estimates++;
      }
      if (signed) {
        const e = await office.post("/estimates", {
          siteId: signed.id,
          title: "Spray head replacement",
          lines: [{ description: "Replace four spray heads", quantity: 4, unitPriceCents: 3500 }, ...lines.slice(1)],
          expiresOn: addDays(today, 30),
          // With deposits on, it asks for one on acceptance.
          ...(features.has("deposits") ? { depositCents: 10000 } : {}),
        });
        const sent = await office.post(`/estimates/${e.id}/send`, { email: false });
        const link = await office.post(`/estimates/${e.id}/link`);
        const token = String(link.url).split("/").pop()!;
        const optional = (sent.versions.at(-1).lines as { id: string; optional: boolean }[]).filter((l) => l.optional).map((l) => l.id);
        // A fictional homeowner signs with a typed name and adds the alarm.
        await as(app, "").post(`/estimate/${token}/accept`, { version: 1, selectedOptionalLineIds: optional, signerName: "Fictional Homeowner", signature: { kind: "typed" }, agree: true });
        estimates++;
        // The homeowner pays the deposit by card on the test checkout.
        const pub = await as(app, "").get(`/estimate/${token}`);
        const payToken = pub.deposit?.payUrl ? String(pub.deposit.payUrl).split("/pay/")[1] : null;
        if (payToken) {
          const visitor = as(app, "");
          const checkout = await visitor.post(`/pay/${payToken}/checkout`);
          const sessionId = new URL(checkout.url).searchParams.get("session");
          if (sessionId) await visitor.post(`/pay/${payToken}/test-checkout`, { sessionId, outcome: "card" });
        }
      }
      await worker();
    }

    // ---- Fictional plan tiers, when the plan builder is on (SW-8) ----
    let tierCount = 0;
    if (tiers) {
      const intake = await owner.post("/intake-forms", {
        key: "demo-renewal-intake",
        name: "Before you renew (demo)",
        definition: {
          photos: [],
          fields: [
            { key: "property_changes", label: "Anything changed at the property since last year?", section: "Before you sign", type: "boolean", required: true },
            { key: "change_notes", label: "What changed?", section: "Before you sign", type: "text", maxLength: 500, showWhen: { field: "property_changes", in: [true] } },
            { key: "access_notes", label: "Gate code or access notes", section: "Before you sign", type: "text", maxLength: 500 },
            {
              key: "visit_time",
              label: "Preferred visit time",
              section: "Before you sign",
              type: "select",
              options: [
                { value: "morning", label: "Morning" },
                { value: "afternoon", label: "Afternoon" },
                { value: "any", label: "No preference" },
              ],
            },
          ],
        },
      });
      const terms = (tier: string) =>
        `DEMO ONLY. "${tier}" is a fictional plan of a fictional company, shown to demonstrate the plan builder. It is not a real agreement, and no service or coverage is promised.`;
      const TIERS = [
        {
          name: "Basic (demo)",
          visitsPerTerm: 3,
          priceCents: 27500,
          options: [],
          coverage: [{ ruleKey: "pumping-discount", label: "Pumping discount", match: { category: "pumping" }, effect: "percent_off", percentOff: 10, limit: null }],
          intakeTemplateId: null,
        },
        {
          name: "Gold (demo)",
          visitsPerTerm: 3,
          priceCents: 39500,
          options: [{ optionKey: "filter-cleaning", name: "Annual filter cleaning (fictional)", description: null, priceCents: 4500, taxable: false, required: false, default: true }],
          coverage: [
            { ruleKey: "repairs", label: "Repairs", match: { category: "repair" }, effect: "included", percentOff: null, limit: { count: 1, per: "term" } },
            { ruleKey: "pumping-discount", label: "Pumping discount", match: { category: "pumping" }, effect: "percent_off", percentOff: 15, limit: null },
          ],
          intakeTemplateId: intake.id,
        },
        {
          name: "Platinum (demo)",
          visitsPerTerm: 4,
          priceCents: 59500,
          options: [
            { optionKey: "priority", name: "Priority scheduling (fictional)", description: null, priceCents: 2500, taxable: false, required: true, default: true },
            { optionKey: "filter-cleaning", name: "Annual filter cleaning (fictional)", description: null, priceCents: 4500, taxable: false, required: false, default: true },
          ],
          coverage: [
            { ruleKey: "repairs", label: "Repairs", match: { category: "repair" }, effect: "included", percentOff: null, limit: { count: 3, per: "term" } },
            { ruleKey: "pumping", label: "One pump-out", match: { category: "pumping" }, effect: "included", percentOff: null, limit: { count: 1, per: "term" } },
            { ruleKey: "service-calls", label: "Service calls", match: { category: "other" }, effect: "included", percentOff: null, limit: null },
          ],
          intakeTemplateId: intake.id,
        },
      ];
      for (const t of TIERS) {
        const plan = await owner.post("/plans", { name: t.name, termMonths: 12, visitsPerTerm: t.visitsPerTerm, priceCents: t.priceCents });
        await owner.post(`/plans/${plan.id}/versions`, { termsText: terms(t.name), options: t.options, coverage: t.coverage, intakeTemplateId: t.intakeTemplateId });
        tierCount++;
      }
    }
    // ---- A pumping-only contract, when service cycles are on (SW-9) ----
    let cycleOrders = 0;
    if (cycles) {
      const types = await owner.get("/work-types");
      const pumpType = (types.items as { id: string; key: string }[]).find((t) => t.key === "pumping")!;
      const plan = await owner.post("/plans", { name: "Pumping only (demo)", termMonths: 12, visitsPerTerm: 1, priceCents: 45000 });
      await owner.post(`/plans/${plan.id}/versions`, {
        termsText: `DEMO ONLY. "Pumping only (demo)" is a fictional plan of a fictional company, shown to demonstrate pumping visits on a contract. It is not a real agreement, and no service is promised.`,
        options: [],
        coverage: [],
        aerobic: false,
        serviceCycles: [{ cycleKey: "pumping", label: "Tank pumping", serviceType: "pumping", workTypeId: pumpType.id, schedule: { kind: "every_months", everyMonths: 6, windowDays: 30 }, allowNoVisit: false }],
      });
      const customer = await office.post("/customers", { displayName: "Riley Pumpwell (demo)" });
      const site = await office.post(`/customers/${customer.id}/sites`, { addressLine1: "48 Fictional Hollow Rd", city: "Dripping Springs", state: "TX", postalCode: "78620" });
      await office.post(`/sites/${site.id}/systems`, { systemCategory: "conventional", manufacturer: "Fictional tank (demo)" });
      const contract = await office.post(`/sites/${site.id}/contracts`, { planId: plan.id, startOn: addMonths(today, -5) });
      const first = (contract.obligations as { id: string; serviceType: string; sequence: number }[]).find((o) => o.serviceType === "pumping" && o.sequence === 1);
      if (first) {
        await office.post(`/obligations/${first.id}/work-order`);
        cycleOrders++;
      }
    }
    log(`demo story: ${assigned} sites assigned to real authorities, ${contractsFiled} contracts filed, ${history.length} past inspections filed (${historyConfirmed} confirmed), ${inspections.length} inspections filed yesterday (one confirmed), ${ending ? 1 : 0} renewal sent, ${invoiced.length} invoices (one paid), ${workOrders} work orders, ${estimates} estimates${tiers ? `, ${tierCount} fictional plan tiers` : ""}${cycles ? `, a pumping-only contract with ${cycleOrders} visit booked` : ""}`);
    return true;
  } finally {
    // The story's own sign-ins end with it.
    await db.deleteFrom("sessions").where("organizationId", "=", org.id).execute();
    await app.close();
  }
}
