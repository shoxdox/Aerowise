import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { OutboxTransport } from "@aerowise/compliance";
import { DEMO_ORG_NAME, DEMO_PASSWORD, DEMO_USERS, type Database } from "@aerowise/db";
import { addDays, DEFAULT_TEMPLATE } from "@aerowise/domain";
import type { ObjectStore } from "@aerowise/storage";
import { drainTasks } from "@aerowise/tasks";
import { buildApp, type App } from "./app.ts";

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
    photo: (url: string, body: Buffer, headers: Record<string, string>) =>
      app.inject({ method: "PUT", url, payload: body, headers: { cookie, "content-type": "image/jpeg", ...headers } }).then((r) => {
        if (r.statusCode >= 300) throw new Error(`demo story: photo ${url} answered ${r.statusCode} ${r.body}`);
      }),
    raw: call,
  };
}

async function signIn(app: App, email: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  const cookie = res.cookies.find((c) => c.name === "aw_session");
  if (res.statusCode !== 200 || !cookie) throw new Error(`demo story: could not sign in as ${email}: ${res.statusCode} ${res.body}`);
  return as(app, `aw_session=${cookie.value}`);
}

const chicagoDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
/** An afternoon time on a Central date, as UTC (Central is UTC-5 or -6; 20:00Z is mid-afternoon either way). */
const afternoon = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00Z`).toISOString();

/** Plays the story once. Returns false when there is no demo company or it was already played. */
export async function playDemoStory(opts: { db: Database; store: ObjectStore; now?: () => Date; log?: (msg: string) => void }): Promise<boolean> {
  const { db, store, now = () => new Date(), log = () => {} } = opts;
  const org = await db.selectFrom("organizations").select(["id", "demo"]).where("name", "=", DEMO_ORG_NAME).executeTakeFirst();
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
  const app = await buildApp({ db, store, now, mail, appUrl, production: false, loginRateLimit: 1000, logger: false });
  // Only the demo company's own tasks: any other company's stay queued for the real worker.
  const worker = () => drainTasks({ db, store, now, mail, appUrl }, "demo-story", org.id);
  try {
    const [ownerUser, officeUser, techUser] = DEMO_USERS.map((u) => u.email);
    const owner = await signIn(app, ownerUser!);
    const office = await signIn(app, officeUser!);
    const tech = await signIn(app, techUser!);
    const today = chicagoDate(now());
    const yesterday = addDays(today, -1);
    const members = await db
      .selectFrom("memberships as m")
      .innerJoin("users as u", "u.id", "m.userId")
      .select(["u.id", "u.name", "m.role"])
      .where("m.organizationId", "=", org.id)
      .execute();
    const ownerId = members.find((m) => m.role === "owner")!.id;
    const techId = members.find((m) => m.role === "technician")!.id;

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
      const done = await tech.put("/inspections/sync", { ...base, status: "completed", completedAt: afternoon(yesterday, n === 0 ? "19:40" : "21:05"), values });
      if (done.status !== "completed") throw new Error(`demo story: inspection did not complete: ${JSON.stringify(done.validationProblems ?? done)}`);
      inspections.push(done.id);
    }
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
    log(`demo story: ${inspections.length} inspections filed (one confirmed), ${ending ? 1 : 0} renewal sent, ${invoiced.length} invoices (one paid)`);
    return true;
  } finally {
    await app.close();
  }
}

