import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { OutboxTransport } from "@aerowise/compliance";
import { DEMO_ORG_NAME, type Database } from "@aerowise/db";
import { addDays, DEFAULT_TEMPLATE, parseFeatures, type Feature } from "@aerowise/domain";
import type { ObjectStore } from "@aerowise/storage";
import { drainTasks } from "@aerowise/tasks";
import { buildApp, type App } from "./app.ts";
import { createSession, SESSION_COOKIE } from "./auth/sessions.ts";

// The demo's five-minute path, played once on top of the seed: what a provider would have
// done before a prospect opens the demo. Everything goes through the API as the demo users,
// with every outside service a stand-in, so the records are exactly what the product makes.
//
//   - The owner's MP license and the technician's registration on file, the owner as the
//     company's responsible MP (so reports can be signed and filings released).
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
//
// Today's and tomorrow's route is left alone for the visitor to work through.

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
  const { db, store, now = () => new Date(), log = () => {}, features = parseFeatures(process.env.AEROWISE_FEATURES) } = opts;
  const work = features.has("work_orders");
  const catalog = work && features.has("service_items");
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
    const today = chicagoDate(now());
    const yesterday = addDays(today, -1);

    // ---- Licenses on file ----
    const mp = await owner.post("/credentials", { userId: ownerId, holderName: "Olivia Owner", kind: "tceq_maintenance_provider", number: "MP-DEMO-0001", verifiedOn: addDays(today, -30), verificationSource: "Fictional: demo company" });
    await owner.post("/credentials", { userId: techId, holderName: "Tess Tech", kind: "tceq_maintenance_technician", number: "MT-DEMO-0001", expiresOn: addDays(today, 365) });
    await owner.put("/settings/responsible-provider", { credentialId: mp.id });

    // ---- Yesterday: two overdue visits inspected and filed ----
    const overdue = await db
      .selectFrom("serviceObligations as o")
      .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "o.siteId").onRef("s.organizationId", "=", "o.organizationId"))
      .select(["o.id", "o.siteId", "s.lat", "s.lng"])
      .where("o.organizationId", "=", org.id)
      .where("o.status", "=", "open")
      .where("o.dueOn", "<", today)
      .orderBy("o.dueOn")
      .limit(2)
      .execute();
    const template = await tech.get("/inspection-template");
    const inspections: string[] = [];
    for (const [n, visit] of overdue.entries()) {
      const job = await office.post("/jobs", { obligationId: visit.id, technicianId: techId, scheduledDate: yesterday });
      const clientId = randomUUID();
      const arrivedAt = afternoon(yesterday, n === 0 ? "19:00" : "20:30");
      const base = { clientId, jobId: job.jobId, templateId: template.id, arrivedAt, arrivalGps: { lat: visit.lat ?? 30.19, lng: visit.lng ?? -98.09, accuracyM: 8 } };
      await tech.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
      for (const key of ["overview", "chlorinator"] as const) {
        await tech.photo(`/inspections/${clientId}/photos/${randomUUID()}`, PHOTOS[key], { "x-photo-key": key, "x-captured-at": afternoon(yesterday, n === 0 ? "19:10" : "20:40") });
      }
      const values: Record<string, string | number | boolean> = {};
      for (const f of DEFAULT_TEMPLATE.definition.fields) if (f.type === "pass_fail") values[f.key] = "pass";
      Object.assign(values, {
        // Every demo unit has a tablet or liquid chlorinator (seed.ts), and it was working.
        chlorinator: "working",
        chlorine_level: n === 0 ? 1.5 : 2.0,
        chlorine_added: 2,
        air_pressure: n === 0 ? 4.5 : 3.8,
        odor: "none",
        pumping_needed: n === 1,
        notes: n === 1 ? "Sludge is near the top of the pretreatment tank; pumping recommended before the next visit." : "Everything working. Tablets topped up.",
      });
      // What the technician noted for the office to follow up, when there is work to turn it into.
      const issues = !work
        ? []
        : n === 0
          ? [{ clientId: randomUUID(), type: "repair_needed", severity: "medium", description: "Alarm light flickers; float switch wiring looks loose." }]
          : [{ clientId: randomUUID(), type: "pump_out", severity: "high", description: "Sludge near the top of the pretreatment tank." }];
      const done = await tech.put("/inspections/sync", { ...base, status: "completed", completedAt: afternoon(yesterday, n === 0 ? "19:40" : "21:05"), values, issues });
      if (done.status !== "completed") throw new Error(`demo story: inspection did not complete: ${JSON.stringify(done.validationProblems ?? done)}`);
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
        await office.post(`/work-orders/${wo.id}/complete`, { reason: "Fictional: pumped yesterday; the technician's phone records arrive with the next phone update." });
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
      await worker();
    }
    log(`demo story: ${inspections.length} inspections filed (one confirmed), ${ending ? 1 : 0} renewal sent, ${invoiced.length} invoices (one paid), ${workOrders} work orders`);
    return true;
  } finally {
    // The story's own sign-ins end with it.
    await db.deleteFrom("sessions").where("organizationId", "=", org.id).execute();
    await app.close();
  }
}
