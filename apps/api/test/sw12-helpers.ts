import { snapshotSha256 } from "@aerowise/domain";
import { sql } from "kysely";
import { expect } from "vitest";
import type { App } from "../src/app.ts";
import { client, createUser, type TestContext } from "./helpers.ts";
import { completeValues, JPEG, payload, setup, uploadRequiredPhotos } from "./inspection-helpers.ts";

// Shared by the SW-12 route sweeps (plan §12 rows 17 and 18): the service-workflow routes from the
// app's own route table, and a company with one of everything those routes take an id for.

/** The service-workflow surface (plan §12 row 17), plus the older routes those slices extended. */
export const SCOPE = [
  /^\/work(\/|-orders|-types|-records|-files|$)/,
  /^\/form-templates/,
  /^\/estimates/,
  /^\/service-items/,
  /^\/plans/,
  /^\/intake-forms/,
  /^\/contracts\/:id/,
  /^\/sites\/:id\/contract-terms/,
  /^\/invoices\/:id\/(deposit|refund-job)/,
  /^\/(issues|service-requests)\/:id\/(work-order|estimate)/,
  /^\/jobs\/:id\/work-record/,
  // SW-6 (flag pumping).
  /^\/(vehicles|disposal|pumping)/,
];

/** Each route Fastify knows, as [method, full path], from its printed route tree. */
export function routeTable(tree: string): [string, string][] {
  const out: [string, string][] = [];
  const stack: string[] = [];
  for (const line of tree.split("\n")) {
    const i = line.indexOf("/");
    if (i < 0) continue;
    const m = line.slice(i).match(/^(\S+)(?: \(([^)]*)\))?/)!;
    stack.length = Math.round(i / 4) - 1;
    stack.push(m[1]!);
    for (const method of m[2]?.split(", ") ?? []) if (method !== "HEAD") out.push([method, stack.join("")]);
  }
  return out;
}

/**
 * Each registered route as [method, path] with its own parameter names. The printed route tree
 * merges parameter names that share a node (":groupId|:clientId"), so each tree route is matched
 * to the OpenAPI path registered with it; a route with no OpenAPI entry keeps its tree path.
 */
export async function registeredRoutes(app: App): Promise<[string, string][]> {
  const spec = (await app.inject({ method: "GET", url: "/openapi.json" })).json() as { paths: Record<string, Record<string, unknown>> };
  const specRoutes = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => [m.toUpperCase(), p.replace(/\{([A-Za-z]+)\}/g, ":$1")] as [string, string]));
  return routeTable(app.printRoutes({ commonPrefix: false })).map(([method, path]) => {
    const pattern = new RegExp(`^${path.replace(/:[A-Za-z]+(\|:[A-Za-z]+)*/g, (names) => `:(${names.replaceAll(":", "")})`)}$`);
    const found = specRoutes.filter(([m, p]) => m === method && pattern.test(p));
    return found.length === 1 ? found[0]! : [method, path];
  });
}

/** Company B with one of everything the swept routes take an id for. */
export async function richTenant(c: TestContext) {
  const s = await setup(c, "Org B");
  // An inspection issue.
  await s.techApi.put("/inspections/sync", payload(s));
  await uploadRequiredPhotos(s, payload(s).clientId);
  const inspected = await s.techApi.put(
    "/inspections/sync",
    payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: completeValues(), issues: [{ clientId: crypto.randomUUID(), type: "pump_out", severity: "high", description: "Sludge near the top" }] }),
  );
  expect(inspected.statusCode, inspected.body).toBe(200);
  const issueId = inspected.json().issues[0].id as string;
  const request = (await s.api.post("/service-requests", { siteId: s.site.id, kind: "repair", description: "Pump hums", receivedAt: "2026-02-28T15:00:00Z" })).json();
  const workType = (await s.api.post("/work-types", { key: "jetting", name: "Line jetting", category: "maintenance" })).json();
  const item = (await s.api.post("/service-items", { name: "Riser", unitPriceCents: 1000 })).json();
  const form = await s.api.post("/form-templates/work-repair/versions", { name: "Org B private repair form", definition: (await s.api.get("/form-templates/work-repair")).json().definition });

  // An accepted estimate with a deposit, which makes a work order and a deposit invoice.
  const est = await s.api.post("/estimates", { siteId: s.site.id, lines: [{ description: "Replace aerator", quantity: 1, unitPriceCents: 60000 }], depositCents: 15000, expiresOn: "2026-03-31" });
  expect(est.statusCode, est.body).toBe(201);
  const acc = await s.api.post(`/estimates/${est.json().id}/record-acceptance`, { evidence: "Signed paper copy" });
  expect(acc.statusCode, acc.body).toBe(200);

  // A repair done on the phone (record, photos, signature), and one held after a reassignment.
  const repair = (await s.api.get("/work-types")).json().items.find((t: { key: string }) => t.key === "repair");
  const other = await createUser(c.db, s.org.id, "technician");
  const visit = async (title: string) => {
    const wo = (await s.api.post("/work-orders", { siteId: s.site.id, workTypeId: repair.id, title })).json();
    const sch = await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-01" });
    expect(sch.statusCode, sch.body).toBe(201);
    return { wo, jobId: sch.json().visits[0].jobId as string, clientId: crypto.randomUUID() };
  };
  const tmpl = (await s.techApi.get("/form-templates/work-repair")).json();
  const summary = { workDone: "Reset alarm", parts: [], notes: "" };
  const sendAll = async (v: { jobId: string; clientId: string }) => {
    const sync = (status: string, revision: number) =>
      s.techApi.put("/work/sync", { clientId: v.clientId, jobId: v.jobId, templateId: tmpl.id, status, revision, arrivedAt: "2026-03-01T15:00:00Z", completedAt: status === "completed" ? "2026-03-01T16:00:00Z" : null, values: { problem: "Alarm", work_performed: "Reset alarm", follow_up_needed: false }, summary });
    await sync("draft", 1);
    for (const key of ["before", "after"]) await s.techApi.putImage(`/work/${v.clientId}/photos/${crypto.randomUUID()}`, JPEG, { "x-photo-key": key });
    await s.techApi.put(`/work/${v.clientId}/signatures/${crypto.randomUUID()}`, { requirementKey: "customer_signoff", signerName: "Pat", capture: { kind: "typed" }, summary, summarySha256: await snapshotSha256(summary), consentText: "I confirm this work was done.", signedAt: "2026-03-01T15:55:00Z" });
    return sync("completed", 2);
  };
  const done = await visit("Done on the phone");
  expect((await sendAll(done)).statusCode).toBe(200);
  const held = await visit("Held after reassignment");
  expect((await s.api.patch(`/jobs/${held.jobId}`, { technicianId: other.id })).statusCode).toBe(200);
  await sendAll(held);

  // SW-6: a truck, a facility, a pump-out recorded with its visit, and a disposal load with its
  // manifest photo, all on the technician's phone.
  const truck = (await s.api.post("/vehicles", { name: "Truck 1", capacityGallons: 3000 })).json();
  const facility = (await s.api.post("/disposal-facilities", { name: "Example Water Reclamation", kind: "wastewater_treatment_plant", city: "Austin" })).json();
  const pumpingGroup = await pumpOut(s.api, s.techApi, { techId: s.tech.id, siteId: s.site.id, truckId: truck.id });
  // A second pump-out kept out of every load, for the disposal item probes.
  const unloadedGroup = await pumpOut(s.api, s.techApi, { techId: s.tech.id, siteId: s.site.id, truckId: truck.id });
  const loadClient = crypto.randomUUID();
  const loaded = await s.techApi.put("/disposal/loads/sync", { clientId: loadClient, vehicleId: truck.id, facilityId: facility.id, deliveredOn: "2026-03-01", manifestReference: "M-1001", total: 1000, unit: "gallons", pumpingGroupIds: [pumpingGroup] });
  expect(loaded.statusCode, loaded.body).toBe(201);
  const manifest = await s.techApi.putImage(`/disposal/loads/${loadClient}/photos/${crypto.randomUUID()}`, JPEG, { "x-photo-key": "manifest" });
  expect(manifest.statusCode, manifest.body).toBe(201);

  // SW-7: a two-visit installation finished on its final visit with the completion sign-off.
  const installation = await install(s.api, s.techApi, { techId: s.tech.id, siteId: s.site.id });

  const one = async (q: ReturnType<typeof sql<{ id: string }>>) => (await q.execute(c.db)).rows[0]?.id;
  const org = s.org.id;
  const ids: Record<string, string | undefined> = {
    "work-orders": done.wo.id,
    "work-types": workType.id,
    "work-records": await one(sql`select id from work_records where organization_id = ${org} and job_id = ${done.jobId}`),
    "work-files": await one(sql`select id from work_attachments where organization_id = ${org} limit 1`),
    "work/conflicts": await one(sql`select id from work_sync_conflicts where organization_id = ${org} limit 1`),
    work: done.clientId,
    estimates: est.json().id,
    invoices: acc.json().deposit.invoice.id,
    issues: issueId,
    "service-requests": request.id,
    "service-items": item.id,
    plans: s.contract.planId ?? (await one(sql`select id from plans where organization_id = ${org} limit 1`)),
    contracts: s.contract.id,
    sites: s.site.id,
    jobs: done.jobId,
    vehicles: truck.id,
    "disposal-facilities": facility.id,
    "pumping-records": pumpingGroup,
    "pumping-records:unloaded": unloadedGroup,
    "disposal/loads": loaded.json().groupId,
    // Keyed by parameter name where one path prefix takes two kinds of id.
    "disposal/loads:clientId": loadClient,
  };
  return { ...s, ids, installation, formSaved: form.statusCode };
}

/**
 * SW-7: an installation work order of two visits on the technician's phone; the second is the
 * final visit and carries the customer's completion sign-off, which completes the work order.
 * Returns the work order id.
 */
export async function install(office: Api, phone: Api, at: { techId: string; siteId: string }) {
  const type = ((await office.get("/work-types")).json().items as { id: string; key: string }[]).find((t) => t.key === "installation")!;
  const wo = (await office.post("/work-orders", { siteId: at.siteId, workTypeId: type.id, title: "New conventional system" })).json();
  const form = (await phone.get("/form-templates/work-installation")).json();
  for (const [day, finalVisit] of [["2026-03-01", false], ["2026-03-08", true]] as const) {
    const sch = await office.post(`/work-orders/${wo.id}/schedule`, { technicianId: at.techId, scheduledDate: day });
    expect(sch.statusCode, sch.body).toBe(201);
    const jobId = (sch.json().visits as { jobId: string }[]).at(-1)!.jobId;
    const clientId = crypto.randomUUID();
    const summary = { workOrder: wo.title, visit: jobId, anotherVisitNeeded: !finalVisit };
    const sync = (status: "draft" | "completed", revision: number) =>
      phone.put("/work/sync", { clientId, jobId, templateId: form.id, status, revision, arrivedAt: `${day}T15:00:00Z`, completedAt: status === "completed" ? `${day}T17:00:00Z` : null, values: { system_status: "new", bedrooms: 3, tank_sizes: "1,000 gal", work_performed: "Set the tank" }, summary, finalVisit });
    await sync("draft", 1);
    for (const key of finalVisit ? ["install_location", "as_built"] : ["install_location"]) {
      expect((await phone.putImage(`/work/${clientId}/photos/${crypto.randomUUID()}`, JPEG, { "x-photo-key": key })).statusCode).toBe(201);
    }
    if (finalVisit) {
      const signed = await phone.put(`/work/${clientId}/signatures/${crypto.randomUUID()}`, { requirementKey: "customer_completion", signerName: "Pat Homeowner", capture: { kind: "typed" }, summary, summarySha256: await snapshotSha256(summary), consentText: "I confirm this work was done.", signedAt: `${day}T16:55:00Z` });
      expect(signed.statusCode, signed.body).toBe(201);
    }
    const done = await sync("completed", 2);
    expect(done.json(), done.body).toMatchObject({ status: "completed", validationStatus: "valid", finalVisit });
  }
  expect((await office.get(`/work-orders/${wo.id}`)).json().status).toBe("completed");
  return wo.id as string;
}

type Api = ReturnType<typeof client>;

/** A pumping visit scheduled for the technician and completed on their phone with a pump-out on
 * `truckId`; returns the pump-out's group id. */
export async function pumpOut(office: Api, phone: Api, o: { techId: string; siteId: string; truckId: string }) {
  const pumpingType = (await office.get("/work-types")).json().items.find((t: { key: string }) => t.key === "pumping");
  const pumpingForm = (await phone.get("/form-templates/work-pumping")).json();
  const wo = (await office.post("/work-orders", { siteId: o.siteId, workTypeId: pumpingType.id })).json();
  const scheduled = await office.post(`/work-orders/${wo.id}/schedule`, { technicianId: o.techId, scheduledDate: "2026-03-01" });
  expect(scheduled.statusCode, scheduled.body).toBe(201);
  const clientId = crypto.randomUUID();
  const pumpOutId = crypto.randomUUID();
  const body = (status: string, revision: number) => ({
    clientId,
    jobId: scheduled.json().visits[0].jobId,
    templateId: pumpingForm.id,
    status,
    revision,
    arrivedAt: "2026-03-01T15:00:00Z",
    completedAt: status === "completed" ? "2026-03-01T16:00:00Z" : null,
    values: { tank_count: 1, lid_condition: "good" },
    pumpOut: { clientId: pumpOutId, volume: 1000, unit: "gallons", wasteType: "septage", tanks: [{ label: "Tank 1", volume: 1000 }], vehicleId: o.truckId },
  });
  await phone.put("/work/sync", body("draft", 1));
  expect((await phone.put("/work/sync", body("completed", 2))).json().status).toBe("completed");
  return (await office.get(`/pumping-records?workOrderId=${wo.id}`)).json().items[0].groupId as string;
}

/** A hash of every row company B owns, table by table. */
export async function fingerprint(c: TestContext, org: string) {
  const tables = (
    await sql<{ t: string }>`select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'organization_id' and table_name not in ('sessions', 'audit_events', 'login_attempts') order by 1`.execute(c.db)
  ).rows.map((r) => r.t);
  const out: Record<string, string> = {};
  for (const t of tables) {
    out[t] = (await sql<{ h: string }>`select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as h from ${sql.table(t)} x where organization_id = ${org}`.execute(c.db)).rows[0]!.h;
  }
  return out;
}

/** The URL for a swept route: its first id is the company's record, found by the segments before
 * it; any later id (a photo or signature under it) is one nobody sent. Null: no fixture for it. */
export function urlFor(path: string, ids: Record<string, string | undefined>, target?: string): string | null {
  const segs = path.split("/");
  const first = segs.findIndex((x) => x.startsWith(":"));
  if (first < 0) return path;
  const lit = segs.slice(1, first);
  const name = segs[first]!.slice(1);
  const id = target ?? ids[`${lit.slice(-2).join("/")}:${name}`] ?? ids[lit.slice(-2).join("/")] ?? ids[lit.at(-1)!];
  if (!id) return null;
  // Required query strings, filled with the company's values or a well-formed nonsense signature.
  const query = path === "/sites/:id/contract-terms" ? `?planId=${ids.plans}&startOn=2026-03-01` : path === "/work-files/:id" ? `?exp=${Date.now() + 60_000}&sig=x` : "";
  return segs.map((x, i) => (i === first ? id : x.startsWith(":") ? crypto.randomUUID() : x)).join("/") + query;
}

/** Valid bodies for each swept write. `a` holds company A's own ids, so only company B's id in the
 * URL (or named in the body) can be what is refused. */
export type Own = { workTypeId: string; techId: string; siteId: string; truckId: string; facilityId: string; pumpOut: string; b: Record<string, string | undefined> };
const req = () => ({ requestId: crypto.randomUUID(), amountCents: 100, reason: "Sweep" });
const summary = { workDone: "Reset alarm", parts: [], notes: "" };
export const BODIES: Record<string, (a: Own) => object> = {
  "POST /invoices/:id/deposit/refund": req,
  "POST /invoices/:id/deposit/retain": req,
  "POST /invoices/:id/deposit/shortfall": () => ({ ...req(), kind: "write_off" }),
  "POST /invoices/:id/refund-job": req,
  "POST /issues/:id/work-order": (a) => ({ workTypeId: a.workTypeId, title: "Sweep" }),
  "POST /issues/:id/estimate": () => ({ lines: [{ description: "Sweep", quantity: 1, unitPriceCents: 100 }] }),
  "POST /service-requests/:id/work-order": (a) => ({ workTypeId: a.workTypeId, title: "Sweep" }),
  "POST /service-requests/:id/estimate": () => ({ lines: [{ description: "Sweep", quantity: 1, unitPriceCents: 100 }] }),
  "POST /contracts/:id/renew": () => ({ priceCents: 100 }),
  "POST /contracts/:id/cancel": () => ({ reason: "Sweep" }),
  "POST /contracts/:id/invoice": () => ({}),
  "POST /contracts/:id/document": () => ({ filename: "sweep.pdf", contentBase64: Buffer.from("%PDF-1.4 sweep").toString("base64") }),
  "POST /contracts/:id/discontinuation-notice": () => ({ sentOn: "2026-03-01", note: "Sweep notice" }),
  "PUT /contracts/:id/filing-basis": () => ({ basis: "renewal", basisOn: "2026-03-01" }),
  "PUT /contracts/:id/provider": () => ({ credentialId: null }),
  "PATCH /service-items/:id": () => ({ name: "Sweep" }),
  "PATCH /plans/:id": () => ({ name: "Sweep" }),
  "POST /plans/:id/versions": () => ({ termsText: "Fictional sweep terms text.", options: [], coverage: [] }),
  "PATCH /work-types/:id": () => ({ name: "Sweep" }),
  "PATCH /work-orders/:id": () => ({ title: "Sweep" }),
  "POST /work-orders/:id/schedule": (a) => ({ technicianId: a.techId, scheduledDate: "2026-03-02" }),
  "POST /work-orders/:id/cancel": () => ({ reason: "Sweep" }),
  "POST /work-orders/:id/complete": () => ({ reason: "Sweep" }),
  "POST /work-orders/:id/coverage/apply": () => ({}),
  "POST /work-orders/:id/coverage/decline": () => ({ reason: "Sweep" }),
  "POST /work-orders/:id/coverage/restore": () => ({ reason: "Sweep" }),
  "POST /work-orders/:id/invoice": () => ({}),
  "POST /work-orders/:id/notes": () => ({ body: "Sweep" }),
  "POST /work/conflicts/:id/attach": () => ({ note: "Sweep" }),
  "POST /work/conflicts/:id/dismiss": () => ({ reason: "Sweep" }),
  "PUT /work/:clientId/signatures/:signatureClientId": () => ({
    requirementKey: "customer_signoff",
    signerName: "Pat",
    capture: { kind: "typed" },
    summary,
    summarySha256: "0".repeat(64),
    consentText: "I confirm this work was done.",
    signedAt: "2026-03-01T15:55:00Z",
  }),
  "PATCH /estimates/:id": () => ({ title: "Sweep" }),
  "POST /estimates/:id/send": () => ({ email: false }),
  "POST /estimates/:id/link": () => ({}),
  "POST /estimates/:id/revise": () => ({}),
  "POST /estimates/:id/record-acceptance": () => ({ evidence: "Sweep" }),
  "POST /estimates/:id/void": () => ({ reason: "Sweep" }),
  "POST /estimates/:id/cancel": () => ({ reason: "Sweep" }),
  // SW-6.
  "PATCH /vehicles/:id": () => ({ name: "Sweep" }),
  "PATCH /disposal-facilities/:id": () => ({ name: "Sweep" }),
  "POST /pumping-records/:groupId/correct": (a) => ({ volume: 900, unit: "gallons", wasteType: "septage", vehicleId: a.truckId, serviceDate: "2026-03-01", reason: "Sweep" }),
  "POST /disposal/loads/:groupId/correct": (a) => ({ vehicleId: a.truckId, facilityId: a.facilityId, deliveredOn: "2026-03-02", manifestReference: "M-9", total: 900, unit: "gallons", reason: "Sweep" }),
  // Real pump-outs: the caller's own, not in any load (the one the office would add).
  "POST /disposal/loads/:groupId/items": (a) => ({ pumpingGroupId: a.pumpOut }),
  // Real pump-outs: the one actually in company B's load (what a missing guard would remove).
  "POST /disposal/loads/:groupId/items/remove": (a) => ({ pumpingGroupId: a.b["pumping-records"], reason: "Sweep" }),
  // Writes with no id in the URL that name company B's records in the body.
  "POST /work-orders": (a) => ({ siteId: a.b.sites, workTypeId: a.workTypeId }),
  "POST /estimates": (a) => ({ siteId: a.b.sites, lines: [{ description: "Sweep", quantity: 1, unitPriceCents: 100 }] }),
  "PUT /disposal/loads/sync": (a) => ({ clientId: crypto.randomUUID(), vehicleId: a.truckId, facilityId: a.facilityId, deliveredOn: "2026-03-01", manifestReference: "M-9", total: 1000, unit: "gallons", pumpingGroupIds: [a.b["pumping-records"]] }),
  "PUT /work/sync": (a) => ({ clientId: crypto.randomUUID(), jobId: a.b.jobs, templateId: crypto.randomUUID(), status: "draft", revision: 1, arrivedAt: "2026-03-01T15:00:00Z", completedAt: null, values: {}, summary }),
};
/** More probes for routes where one body cannot show every way a missing tenant guard would act:
 * each must be refused like the main body. */
export const EXTRA_PROBES: Record<string, ((a: Own) => object)[]> = {
  // Company B's pump-out that is in no load, added to company B's load.
  "POST /disposal/loads/:groupId/items": [(a) => ({ pumpingGroupId: a.b["pumping-records:unloaded"] })],
  // The caller's own pump-out, "removed" from company B's load.
  "POST /disposal/loads/:groupId/items/remove": [(a) => ({ pumpingGroupId: a.pumpOut, reason: "Sweep" })],
};

/** Writes whose body names no record at all: nothing of another company to reach. */
export const NO_FOREIGN_IDS: Record<string, string> = {
  "POST /service-items": "creates the caller's own item from plain fields",
  "POST /plans": "creates the caller's own plan from plain fields",
  "POST /work-types": "creates the caller's own work type from plain fields",
  "POST /intake-forms": "creates the caller's own form from plain fields",
  "POST /vehicles": "creates the caller's own truck from plain fields",
  "POST /disposal-facilities": "creates the caller's own facility from plain fields",
  "PATCH /pumping/settings": "changes the caller's own company setting",
  "POST /form-templates/:key/versions": "forms are keyed per company: the key names the caller's own form (checked below)",
};
/** Query strings some lists require. */
export const LIST_QUERY: Record<string, string> = {
  "/work/route": "?date=2026-03-01",
  "/disposal/log.csv": "?from=2026-02-01&to=2026-03-31",
  "/disposal/log.pdf": "?from=2026-02-01&to=2026-03-31",
};
