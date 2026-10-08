import { type Feature, snapshotSha256 } from "@aerowise/domain";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { reseedDemo } from "@aerowise/db";
import { client, createTenant, createUser, login, setupTestApp } from "./helpers.ts";
import { eraseOrganization } from "../src/lib/org-erase.ts";
import { JPEG } from "./inspection-helpers.ts";

// SW-9: pumping and maintenance cycles on a contract (service workflows plan §4.4). Each
// cycle numbers its own visits; a visit is booked as one work order, never as an
// inspection, and follows that order when it closes. The pinned clock is 2026-03-01.

const ON: Feature[] = ["work_orders", "service_items", "field_work", "plan_builder", "service_cycles"];
const ctx = setupTestApp({ features: ON });

type Tenant = Awaited<ReturnType<typeof createTenant>>;
type Api = Tenant["api"];

/** The same database through an app with service cycles off (the plan builder still on). */
const appWithout = () => buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store, loginRateLimit: 1000, features: new Set<Feature>(["work_orders", "service_items", "field_work", "plan_builder"]) });

const workTypeId = async (api: Api, key: string) => ((await api.get("/work-types")).json().items as { id: string; key: string }[]).find((t) => t.key === key)!.id;

/** A maintenance kind of work that uses the repair form, so its visits are recorded like any repair. */
async function maintenanceType(api: Api) {
  const r = await api.post("/work-types", { key: "maintenance_visit", name: "Maintenance visit", category: "maintenance", defaultFormTemplateKey: "work-repair" });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

const pumpingCycle = (workTypeId: string, extra: object = {}) => ({ cycleKey: "pumping", label: "Tank pumping", serviceType: "pumping", workTypeId, schedule: { kind: "every_months", everyMonths: 6, windowDays: 30 }, ...extra });

/** A 12-month plan with 2 inspections and the given cycles (and inspections unless `aerobic` is false). */
async function cyclePlan(api: Api, cycles: object[], aerobic = true, name = aerobic ? "Aerobic plus pumping" : "Pumping only") {
  const plan = (await api.post("/plans", { name, termMonths: 12, visitsPerTerm: 2, priceCents: 40000 })).json();
  const res = await api.post(`/plans/${plan.id}/versions`, { termsText: null, options: [], coverage: [], serviceCycles: cycles, aerobic });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; currentVersionId: string; versions: { aerobic: boolean; serviceCycles: { cycleKey: string }[] }[] };
}

async function contractOn(t: Pick<Tenant, "api" | "site">, planId: string, startOn = "2026-01-01", siteId = t.site.id) {
  const res = await t.api.post(`/sites/${siteId}/contracts`, { planId, startOn });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as ContractDetail;
}

interface Obligation {
  id: string;
  serviceType: string;
  cycleKey: string;
  sequence: number;
  windowStart: string;
  windowEnd: string;
  dueOn: string;
  status: string;
  workOrder: { id: string; label: string; status: string } | null;
}
interface ContractDetail {
  id: string;
  serviceType: string;
  obligations: Obligation[];
  cycles: { cycleKey: string; serviceType: string; label: string; summary: string; workType: { id: string } | null }[];
}

const visitsOf = (c: ContractDetail, kind: string) => c.obligations.filter((o) => o.serviceType === kind).map((o) => [o.cycleKey, o.sequence, o.windowStart, o.windowEnd, o.dueOn]);
const book = (api: Api, obligationId: string) => api.post(`/obligations/${obligationId}/work-order`, {});
const workOrdersFor = (obligationId: string) => ctx.db.selectFrom("workOrders").select(["id", "status", "sourceKind", "sourceId", "obligationServiceType"]).where("obligationId", "=", obligationId).execute();
const obligationStatus = async (id: string) => (await ctx.db.selectFrom("serviceObligations").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;

describe("the database's cycle rules", () => {
  it("gives an older writer's contract one aerobic cycle, refuses unnamed or mismatched cycles, and numbers each cycle from 1", async () => {
    const t = await createTenant(ctx, "Org A");
    // A contract and two visits inserted the way a release before cycles did.
    const k = await sql<{ id: string }>`
      insert into contracts (organization_id, site_id, plan_name, start_on, end_on, term_months, visits_per_term, price_cents, billing_frequency, service_type)
      values (${t.org.id}, ${t.site.id}, 'Old writer', '2026-01-01', '2026-12-31', 12, 2, 30000, 'annual', 'aerobic_inspection') returning id`.execute(ctx.db);
    const contractId = k.rows[0]!.id;
    const visit = (seq: number, type = "aerobic_inspection", cycle: string | null = null) =>
      sql`insert into service_obligations (organization_id, contract_id, site_id, service_type, sequence, window_start, window_end, due_on, cycle_id)
          values (${t.org.id}, ${contractId}, ${t.site.id}, ${type}, ${seq}, '2026-01-01', '2026-06-30', '2026-06-30', ${cycle})`.execute(ctx.db);
    await visit(1);
    await visit(2);
    const cycles = await ctx.db.selectFrom("contractServiceCycles").selectAll().where("contractId", "=", contractId).execute();
    expect(cycles).toEqual([expect.objectContaining({ cycleKey: "aerobic", serviceType: "aerobic_inspection", workTypeId: null, planVersionId: null, schedule: { kind: "visits_per_term", visitsPerTerm: 2 } })]);
    const assigned = await ctx.db.selectFrom("serviceObligations").select("cycleId").where("contractId", "=", contractId).execute();
    expect(assigned.map((a) => a.cycleId)).toEqual([cycles[0]!.id, cycles[0]!.id]);

    // Aerobic numbering per contract is exactly as before.
    await expect(visit(2)).rejects.toThrow(/service_obligations_aerobic_sequence|cycle_sequence/);
    // A pumping visit must name its cycle, and that cycle must be of its contract and its kind.
    await expect(visit(1, "pumping")).rejects.toThrow(/must name its service cycle/);
    const pumpType = await workTypeId(t.api, "pumping");
    const pump = await sql<{ id: string }>`
      insert into contract_service_cycles (organization_id, contract_id, cycle_key, service_type, work_type_id, schedule, snapshot)
      values (${t.org.id}, ${contractId}, 'pumping', 'pumping', ${pumpType}, '{"kind":"every_months","everyMonths":6}', '{}') returning id`.execute(ctx.db);
    await expect(visit(3, "aerobic_inspection", pump.rows[0]!.id)).rejects.toThrow(/service_obligations_cycle_fkey/);
    await visit(1, "pumping", pump.rows[0]!.id);
    const other = await sql<{ id: string }>`
      insert into contracts (organization_id, site_id, plan_name, start_on, end_on, term_months, visits_per_term, price_cents, billing_frequency, service_type)
      values (${t.org.id}, ${t.site.id}, 'Other', '2027-01-01', '2027-12-31', 12, 2, 30000, 'annual', 'aerobic_inspection') returning id`.execute(ctx.db);
    await expect(
      sql`insert into service_obligations (organization_id, contract_id, site_id, service_type, sequence, window_start, window_end, due_on, cycle_id)
          values (${t.org.id}, ${other.rows[0]!.id}, ${t.site.id}, 'pumping', 2, '2027-01-01', '2027-06-30', '2027-06-30', ${pump.rows[0]!.id})`.execute(ctx.db),
    ).rejects.toThrow(/service_obligations_cycle_fkey/);

    // A visit never moves, and a cycle never changes.
    await expect(sql`update service_obligations set cycle_id = ${pump.rows[0]!.id} where contract_id = ${contractId} and sequence = 1 and service_type = 'aerobic_inspection'`.execute(ctx.db)).rejects.toThrow(/never change/);
    await expect(sql`update contract_service_cycles set schedule = '{}' where contract_id = ${contractId}`.execute(ctx.db)).rejects.toThrow(/never change/);
    // An aerobic cycle is always the one called "aerobic" and has no kind of work.
    await expect(
      sql`insert into contract_service_cycles (organization_id, contract_id, cycle_key, service_type, schedule, snapshot) values (${t.org.id}, ${contractId}, 'second', 'aerobic_inspection', '{}', '{}')`.execute(ctx.db),
    ).rejects.toThrow(/check constraint/);
  });

  it("keeps inspections and work orders on their own kind of visit", async () => {
    const t = await createTenant(ctx, "Org A");
    const plan = await cyclePlan(t.api, [pumpingCycle(await workTypeId(t.api, "pumping"))]);
    const c = await contractOn(t, plan.id);
    const pump = c.obligations.find((o) => o.serviceType === "pumping")!;
    const aerobic = c.obligations.find((o) => o.serviceType === "aerobic_inspection")!;
    const tech = await createUser(ctx.db, t.org.id, "technician");
    // An inspection job on a pumping visit, by the API (friendly) and directly (refused).
    const res = await t.api.post("/jobs", { obligationId: pump.id, technicianId: tech.id, scheduledDate: "2026-03-02" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "not_an_inspection" });
    await expect(
      sql`insert into jobs (organization_id, site_id, obligation_id, type, scheduled_date, technician_user_id) values (${t.org.id}, ${t.site.id}, ${pump.id}, 'inspection', '2026-03-02', ${tech.id})`.execute(ctx.db),
    ).rejects.toThrow(/jobs_inspection_aerobic_only/);
    // A work order for an inspection visit, by the API (friendly) and directly (refused).
    expect((await book(t.api, aerobic.id)).statusCode).toBe(422);
    const wo = (await book(t.api, pump.id)).json();
    await expect(sql`update work_orders set obligation_id = ${aerobic.id} where id = ${wo.id}`.execute(ctx.db)).rejects.toThrow(/never moves/);
    const insertWo = (obligationId: string, siteId = t.site.id, source = obligationId) =>
      sql`insert into work_orders (organization_id, number, customer_id, site_id, work_type_id, category, title, source_kind, source_id, obligation_id)
          select ${t.org.id}, 9000 + (random() * 999)::int, ${t.customer.id}, ${siteId}, id, category, 'Direct', 'contract_cycle', ${source}, ${obligationId} from work_types where organization_id = ${t.org.id} and key = 'pumping'`.execute(ctx.db);
    await expect(insertWo(aerobic.id)).rejects.toThrow(/work_orders_obligation_not_aerobic/);
    // One order per visit, its source naming the same visit, at the visit's site.
    await expect(insertWo(pump.id)).rejects.toThrow(/work_orders_one_(per_obligation|live_per_source)/);
    const pump2 = c.obligations.find((o) => o.serviceType === "pumping" && o.sequence === 2)!;
    await expect(insertWo(pump2.id, t.site.id, pump.id)).rejects.toThrow(/work_orders_cycle_source/);
    const otherSite = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "2 Main St", city: "Austin" })).json();
    await expect(insertWo(pump2.id, otherSite.id)).rejects.toThrow(/at that visit's site/);
  });
});

describe("plan cycles", () => {
  it("saves cycles in the builder, keeps them through plan edits and saves that leave them out, and checks them", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const pumpType = await workTypeId(a.api, "pumping");
    const plan = await cyclePlan(a.api, [pumpingCycle(pumpType)]);
    expect(plan.versions[0]).toMatchObject({ aerobic: true, serviceCycles: [{ cycleKey: "pumping", label: "Tank pumping" }] });

    // A term change rebuilds the inspections and keeps the pumping cycle.
    const edited = await a.api.patch(`/plans/${plan.id}`, { visitsPerTerm: 4, priceCents: 45000 });
    expect(edited.statusCode, edited.body).toBe(200);
    const stored = await ctx.db.selectFrom("planVersions").select(["serviceCycles", "version"]).where("planId", "=", plan.id).orderBy("version", "desc").executeTakeFirstOrThrow();
    expect(stored.serviceCycles).toEqual([
      { cycleKey: "aerobic", serviceType: "aerobic_inspection", schedule: { kind: "visits_per_term", visitsPerTerm: 4 } },
      expect.objectContaining({ cycleKey: "pumping", workTypeId: pumpType, schedule: { kind: "every_months", everyMonths: 6, windowDays: 30 } }),
    ]);
    // A builder save that does not mention cycles keeps them, even with cycles switched off.
    const off = client(await appWithout(), a.cookie);
    expect((await off.post(`/plans/${plan.id}/versions`, { termsText: null, options: [], coverage: [] })).statusCode).toBe(201);
    const kept = (await a.api.get(`/plans/${plan.id}`)).json();
    expect(kept.versions[0]).toMatchObject({ aerobic: true, serviceCycles: [{ cycleKey: "pumping" }] });
    expect(kept.preview.cycles.map((c: { label: string }) => c.label)).toEqual(["Aerobic inspections", "Tank pumping"]);
    // Saving cycles needs the switch.
    const refused = await off.post(`/plans/${plan.id}/versions`, { termsText: null, options: [], coverage: [], serviceCycles: [pumpingCycle(pumpType)] });
    expect(refused.statusCode).toBe(409);

    const save = (cycles: object[], extra: object = {}) => a.api.post(`/plans/${plan.id}/versions`, { termsText: null, options: [], coverage: [], serviceCycles: cycles, ...extra });
    // Every 36 months on a 12-month plan has no visit unless the office accepts that.
    const rare = pumpingCycle(pumpType, { schedule: { kind: "every_months", everyMonths: 36 } });
    expect((await save([rare])).statusCode).toBe(422);
    expect((await save([{ ...rare, allowNoVisit: true }])).statusCode).toBe(201);
    // The kind of work must be the company's own, offered, and of the cycle's kind.
    expect((await save([pumpingCycle(await workTypeId(b.api, "pumping"))])).statusCode).toBe(422);
    expect((await save([pumpingCycle(await workTypeId(a.api, "repair"))])).json().message).toMatch(/must be pumping work/);
    expect((await save([pumpingCycle(pumpType), pumpingCycle(pumpType)])).statusCode).toBe(400);
    expect((await save([{ ...pumpingCycle(pumpType), cycleKey: "aerobic" }])).statusCode).toBe(400);
    // No inspections needs at least one cycle.
    expect((await save([], { aerobic: false })).statusCode).toBe(422);
  });

  it("freezes each cycle on the contract and numbers its visits from 1, leaving the inspections exactly as before", async () => {
    const t = await createTenant(ctx, "Org A");
    const pumpType = await workTypeId(t.api, "pumping");
    const maintType = await maintenanceType(t.api);
    const plain = (await t.api.post("/plans", { name: "Plain", termMonths: 12, visitsPerTerm: 2, priceCents: 40000 })).json();
    const plan = await cyclePlan(t.api, [pumpingCycle(pumpType), { cycleKey: "maint", label: "Maintenance", serviceType: "maintenance", workTypeId: maintType, schedule: { kind: "every_months", everyMonths: 4, windowDays: 10 } }]);
    const site2 = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "2 Main St", city: "Austin" })).json();
    const before = await contractOn(t, plain.id, "2026-01-01", site2.id);
    const c = await contractOn(t, plan.id);

    expect(visitsOf(c, "aerobic_inspection")).toEqual(visitsOf(before, "aerobic_inspection"));
    expect(visitsOf(c, "pumping")).toEqual([
      ["pumping", 1, "2026-05-31", "2026-07-30", "2026-06-30"],
      ["pumping", 2, "2026-12-01", "2026-12-31", "2026-12-31"],
    ]);
    expect(visitsOf(c, "maintenance")).toEqual([
      ["maint", 1, "2026-04-20", "2026-05-10", "2026-04-30"],
      ["maint", 2, "2026-08-21", "2026-09-10", "2026-08-31"],
      ["maint", 3, "2026-12-21", "2026-12-31", "2026-12-31"],
    ]);
    expect(c.cycles.map((y) => [y.cycleKey, y.serviceType, y.workType?.id ?? null])).toEqual([
      ["aerobic", "aerobic_inspection", null],
      ["maint", "maintenance", maintType],
      ["pumping", "pumping", pumpType],
    ]);
    const snapshot = (await ctx.db.selectFrom("contracts").select("agreementSnapshot").where("id", "=", c.id).executeTakeFirstOrThrow()).agreementSnapshot as { cycles: { label: string }[] };
    expect(snapshot.cycles.map((y) => y.label)).toEqual(["Aerobic inspections", "Tank pumping", "Maintenance"]);
    // A plan without cycles makes a contract whose snapshot reads as before.
    expect(((await ctx.db.selectFrom("contracts").select("agreementSnapshot").where("id", "=", before.id).executeTakeFirstOrThrow()).agreementSnapshot as object)).not.toHaveProperty("cycles");

    // A later plan change never touches the contract's frozen cycles.
    await t.api.post(`/plans/${plan.id}/versions`, { termsText: null, options: [], coverage: [], serviceCycles: [] });
    expect((await t.api.get(`/contracts/${c.id}`)).json().cycles).toHaveLength(3);
  });

  it("makes a pumping-only plan a pumping contract with no inspections, and refuses it with cycles off", async () => {
    const t = await createTenant(ctx, "Org A");
    const plan = await cyclePlan(t.api, [pumpingCycle(await workTypeId(t.api, "pumping"))], false);
    const off = client(await appWithout(), t.cookie);
    const refused = await off.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2026-01-01" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("feature_off");

    const c = await contractOn(t, plan.id);
    expect(c.serviceType).toBe("pumping");
    expect(c.obligations.map((o) => o.serviceType)).toEqual(["pumping", "pumping"]);
    expect(c.cycles.map((y) => y.cycleKey)).toEqual(["pumping"]);
    expect(await ctx.db.selectFrom("filings").select("id").where("contractId", "=", c.id).execute()).toEqual([]);

    // A plan with inspections and pumping, made with cycles off, gets only its inspections.
    const mixed = await cyclePlan(t.api, [pumpingCycle(await workTypeId(t.api, "pumping"))]);
    const site2 = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "2 Main St", city: "Austin" })).json();
    const made = await off.post(`/sites/${site2.id}/contracts`, { planId: mixed.id, startOn: "2026-01-01" });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().obligations.map((o: Obligation) => o.serviceType)).toEqual(["aerobic_inspection", "aerobic_inspection"]);
  });
});

describe("pumping and maintenance visits as work", () => {
  it("keeps them out of the inspection lists and shows them by kind", async () => {
    const t = await createTenant(ctx, "Org A");
    const plan = await cyclePlan(t.api, [pumpingCycle(await workTypeId(t.api, "pumping"))]);
    // From 2025-06-01: the first inspection and the first pumping were due 2025-11-30.
    const c = await contractOn(t, plan.id, "2025-06-01");
    const due = (await t.api.get("/obligations/due?through=2026-12-31")).json();
    expect(due.items.map((o: Obligation) => o.serviceType)).toEqual(["aerobic_inspection", "aerobic_inspection"]);
    const pumps = (await t.api.get("/obligations/due?through=2026-12-31&serviceType=pumping")).json();
    expect(pumps.items.map((o: Obligation) => [o.cycleKey, o.sequence, o.workOrder])).toEqual([
      ["pumping", 1, null],
      ["pumping", 2, null],
    ]);

    const inbox = (await t.api.get("/inbox")).json();
    expect(inbox.counts.overdue).toBe(1);
    const kinds = inbox.items.map((e: { kind: string; target: { id: string } }) => [e.kind, e.target.id]);
    expect(kinds).toContainEqual(["inspection_overdue", c.obligations.find((o) => o.serviceType === "aerobic_inspection")!.id]);
    expect(kinds).toContainEqual(["service_visit_overdue", c.id]);
    expect(kinds.filter(([k]: [string]) => k === "inspection_overdue")).toHaveLength(1);

    // Booked, it leaves the unbooked list and the overdue item.
    await book(t.api, pumps.items[0].id);
    const unbooked = (await t.api.get("/obligations/due?through=2026-12-31&serviceType=pumping&unscheduledOnly=true")).json();
    expect(unbooked.items.map((o: Obligation) => o.sequence)).toEqual([2]);
    expect((await t.api.get("/inbox")).json().items.map((e: { kind: string }) => e.kind)).not.toContain("service_visit_overdue");
  });

  it("books a visit as one work order however often or concurrently it is asked", async () => {
    const t = await createTenant(ctx, "Org A");
    const pumpType = await workTypeId(t.api, "pumping");
    const c = await contractOn(t, (await cyclePlan(t.api, [pumpingCycle(pumpType)])).id);
    const pump = c.obligations.find((o) => o.serviceType === "pumping")!;
    const results = await Promise.all(Array.from({ length: 8 }, () => book(t.api, pump.id)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    const ids = new Set(results.map((r) => r.json().id));
    expect(ids.size).toBe(1);
    expect(results[0]!.json()).toMatchObject({ sourceKind: "contract_cycle", sourceId: pump.id, requestedOn: "2026-06-30", title: "Tank pumping, visit 1", workType: { id: pumpType }, status: "open" });
    expect(await workOrdersFor(pump.id)).toEqual([expect.objectContaining({ status: "open", obligationServiceType: "pumping" })]);
    const detail: ContractDetail = (await t.api.get(`/contracts/${c.id}`)).json();
    expect(detail.obligations.find((o) => o.id === pump.id)!.workOrder).toMatchObject({ id: [...ids][0], status: "open" });
    // Another company cannot book it.
    const b = await createTenant(ctx, "Org B");
    expect((await book(b.api, pump.id)).statusCode).toBe(404);
  });

  it("with service cycles off, books no new cycle work but still returns, finishes and cancels orders already booked", async () => {
    const t = await createTenant(ctx, "Org A");
    const c = await contractOn(t, (await cyclePlan(t.api, [pumpingCycle(await workTypeId(t.api, "pumping"))])).id);
    const [first, second] = c.obligations.filter((o) => o.serviceType === "pumping");
    const booked = await book(t.api, first!.id);
    expect(booked.statusCode).toBe(201);
    const created = await ctx.db.selectFrom("auditEvents").select("changes").where("organizationId", "=", t.org.id).where("action", "=", "work_order.created").execute();
    expect(created.map((a) => a.changes)).toEqual([expect.objectContaining({ sourceKind: "contract_cycle", sourceId: first!.id })]);

    const off = client(await appWithout(), t.cookie);
    // A new order for a visit is refused, and nothing is written.
    const refused = await book(off, second!.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("feature_off");
    expect(await workOrdersFor(second!.id)).toEqual([]);
    expect(await ctx.db.selectFrom("auditEvents").select("id").where("organizationId", "=", t.org.id).where("action", "=", "work_order.created").execute()).toHaveLength(1);
    // A replay for the visit already booked returns its order.
    const replay = await book(off, first!.id);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(booked.json().id);
    // The booked order is still read, finished and cancelled as any work order, and the contract keeps its cycles.
    expect((await off.get(`/work-orders/${booked.json().id}`)).statusCode).toBe(200);
    expect((await off.post(`/work-orders/${booked.json().id}/complete`, { reason: "Paper ticket" })).statusCode).toBe(200);
    expect(await obligationStatus(first!.id)).toBe("completed");
    const detail = (await off.get(`/contracts/${c.id}`)).json() as ContractDetail;
    expect(detail.cycles.map((y) => y.cycleKey)).toEqual(["aerobic", "pumping"]);
    expect((await off.get("/obligations/due?through=2026-12-31&serviceType=pumping")).json().items.map((o: Obligation) => o.id)).toEqual([second!.id]);
  });

  it("completes the visit only with the order's final visit, and never books it again", async () => {
    const t = await createTenant(ctx, "Org A");
    const maint = await maintenanceType(t.api);
    const c = await contractOn(t, (await cyclePlan(t.api, [{ cycleKey: "maint", label: "Maintenance", serviceType: "maintenance", workTypeId: maint, schedule: { kind: "every_months", everyMonths: 6 } }])).id);
    const visit = c.obligations.find((o) => o.serviceType === "maintenance")!;
    const wo = (await book(t.api, visit.id)).json();
    const tech = await createUser(ctx.db, t.org.id, "technician");
    const techApi = client(ctx.app, await login(ctx.app, tech.email));
    const form = (await techApi.get("/form-templates/work-repair")).json();

    async function phoneVisit(finalVisit: boolean) {
      const s = await t.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: tech.id, scheduledDate: "2026-03-01" });
      expect(s.statusCode, s.body).toBe(201);
      const jobId = (s.json().visits as { jobId: string; status: string }[]).find((v) => v.status === "scheduled")!.jobId;
      const clientId = crypto.randomUUID();
      const summary = { workDone: "Serviced aerator", parts: [], notes: "Checked" };
      const sync = (status: "draft" | "completed", revision: number) =>
        techApi.put("/work/sync", {
          clientId,
          jobId,
          templateId: form.id,
          status,
          revision,
          finalVisit,
          arrivedAt: "2026-03-01T15:00:00Z",
          completedAt: status === "completed" ? "2026-03-01T16:00:00Z" : null,
          values: { problem: "Routine", work_performed: "Serviced aerator", follow_up_needed: false },
          summary,
        });
      expect((await sync("draft", 1)).statusCode).toBe(200);
      for (const key of ["before", "after"]) expect((await techApi.putImage(`/work/${clientId}/photos/${crypto.randomUUID()}`, JPEG, { "x-photo-key": key })).statusCode).toBe(201);
      const signed = await techApi.put(`/work/${clientId}/signatures/${crypto.randomUUID()}`, {
        requirementKey: "customer_signoff",
        signerName: "Pat Homeowner",
        capture: { kind: "typed" },
        summary,
        summarySha256: await snapshotSha256(summary),
        consentText: "I confirm this work was done.",
        signedAt: "2026-03-01T15:55:00Z",
      });
      expect(signed.statusCode, signed.body).toBe(201);
      const done = await sync("completed", 2);
      expect(done.statusCode, done.body).toBe(200);
    }

    await phoneVisit(false);
    expect((await t.api.get(`/work-orders/${wo.id}`)).json().status).toBe("open");
    expect(await obligationStatus(visit.id)).toBe("open");
    await phoneVisit(true);
    expect((await t.api.get(`/work-orders/${wo.id}`)).json().status).toBe("completed");
    expect(await obligationStatus(visit.id)).toBe("completed");

    // Asking again returns the finished order; nothing new can be made for the visit.
    const again = await book(t.api, visit.id);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(wo.id);
    expect(await workOrdersFor(visit.id)).toHaveLength(1);
    await expect(sql`update work_orders set status = 'cancelled', cancelled_at = now(), completed_at = null where id = ${wo.id}`.execute(ctx.db).then(() => sql`
      insert into work_orders (organization_id, number, customer_id, site_id, work_type_id, category, title, source_kind, source_id, obligation_id)
      values (${t.org.id}, 9999, ${t.customer.id}, ${t.site.id}, ${maint}, 'maintenance', 'Again', 'contract_cycle', ${visit.id}, ${visit.id})`.execute(ctx.db))).rejects.toThrow(/this visit is completed/);
    // The inspections were untouched.
    expect((await t.api.get(`/contracts/${c.id}`)).json().obligations.filter((o: Obligation) => o.serviceType === "aerobic_inspection").map((o: Obligation) => o.status)).toEqual(["open", "open"]);
  });

  it("a cancelled order leaves the visit to book again while the contract serves it", async () => {
    const t = await createTenant(ctx, "Org A");
    const c = await contractOn(t, (await cyclePlan(t.api, [pumpingCycle(await workTypeId(t.api, "pumping"))])).id);
    const pump = c.obligations.find((o) => o.serviceType === "pumping")!;
    const first = (await book(t.api, pump.id)).json();
    expect((await t.api.post(`/work-orders/${first.id}/cancel`, { reason: "Customer asked for later" })).statusCode).toBe(200);
    expect(await obligationStatus(pump.id)).toBe("open");
    const second = await book(t.api, pump.id);
    expect(second.statusCode).toBe(201);
    expect(second.json().id).not.toBe(first.id);
  });
});

describe("a contract ending with cycle work booked", () => {
  /** A contract with pumping coverage, its first pumping visit booked with coverage applied, a draft invoice and a technician's visit. */
  async function bookedWithMoney() {
    const t = await createTenant(ctx, "Org A");
    const pumpType = await workTypeId(t.api, "pumping");
    const plan = (await t.api.post("/plans", { name: "Aerobic plus pumping", termMonths: 12, visitsPerTerm: 2, priceCents: 40000 })).json();
    const saved = await t.api.post(`/plans/${plan.id}/versions`, {
      termsText: null,
      options: [],
      coverage: [{ ruleKey: "pump", label: "Pumping", match: { category: "pumping" }, effect: "percent_off", percentOff: 20 }],
      serviceCycles: [pumpingCycle(pumpType)],
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const c = await contractOn(t, plan.id);
    const pump = c.obligations.find((o) => o.serviceType === "pumping" && o.sequence === 1)!;
    const unbooked = c.obligations.find((o) => o.serviceType === "pumping" && o.sequence === 2)!;
    const wo = (await book(t.api, pump.id)).json();
    // Requested on its due date, inside the term: the contract's coverage applies.
    expect((await t.api.post(`/work-orders/${wo.id}/coverage/apply`, {})).statusCode).toBe(200);
    expect((await t.api.patch(`/work-orders/${wo.id}`, { lines: [{ description: "Pump tank", quantity: 1, unitPriceCents: 30000 }] })).statusCode).toBe(200);
    const inv = await t.api.post(`/work-orders/${wo.id}/invoice`, {});
    expect(inv.statusCode, inv.body).toBe(201);
    const tech = await createUser(ctx.db, t.org.id, "technician");
    const scheduled = await t.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: tech.id, scheduledDate: "2026-03-02" });
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    return { t, c, pump, unbooked, wo, invoiceId: inv.json().invoiceId as string, jobId: scheduled.json().visits[0].jobId as string };
  }

  const money = async (woId: string, invoiceId: string) => ({
    wo: await ctx.db.selectFrom("workOrders").select(["status", "billingStatus"]).where("id", "=", woId).executeTakeFirstOrThrow(),
    invoice: (await ctx.db.selectFrom("invoices").select(["status", "totalCents"]).where("id", "=", invoiceId).executeTakeFirst()) ?? null,
    uses: await ctx.db.selectFrom("coverageUses").select("state").where("workOrderId", "=", woId).execute(),
    jobs: await ctx.db.selectFrom("jobs").select("status").where("workOrderId", "=", woId).execute(),
  });

  it("keeps the booked visit, its order, coverage, invoice and route visit; the office's cancel then settles them", async () => {
    const s = await bookedWithMoney();
    const before = await money(s.wo.id, s.invoiceId);
    expect(before).toMatchObject({ wo: { status: "scheduled", billingStatus: "invoiced" }, invoice: { status: "draft" }, uses: [{ state: "reserved" }], jobs: [{ status: "scheduled" }] });

    const cancelled = await s.t.api.post(`/contracts/${s.c.id}/cancel`, { reason: "Owner sold the house" });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    // Unbooked visits and the inspections are cancelled as before; the booked one waits on the office.
    const after = (await s.t.api.get(`/contracts/${s.c.id}`)).json() as ContractDetail;
    expect(after.obligations.map((o) => [o.cycleKey, o.sequence, o.status])).toEqual([
      ["aerobic", 1, "cancelled"],
      ["aerobic", 2, "cancelled"],
      ["pumping", 1, "open"],
      ["pumping", 2, "cancelled"],
    ]);
    expect(await money(s.wo.id, s.invoiceId)).toEqual(before);
    const inbox = (await s.t.api.get("/inbox")).json();
    expect(inbox.items).toContainEqual(expect.objectContaining({ kind: "cycle_work_contract_ended", workOrder: expect.objectContaining({ id: s.wo.id }) }));
    // The contract no longer serves the unbooked visit.
    expect((await book(s.t.api, s.unbooked.id)).statusCode).toBe(409);

    // The office's cancel goes through the work order hooks: visit cancelled, coverage released.
    expect((await s.t.api.post(`/invoices/${s.invoiceId}/discard`, {})).statusCode).toBe(204);
    expect((await s.t.api.post(`/work-orders/${s.wo.id}/cancel`, { reason: "Contract ended" })).statusCode).toBe(200);
    expect(await obligationStatus(s.pump.id)).toBe("cancelled");
    expect((await money(s.wo.id, s.invoiceId)).uses).toEqual([{ state: "released" }]);
    expect((await s.t.api.get("/inbox")).json().items.map((e: { kind: string }) => e.kind)).not.toContain("cycle_work_contract_ended");
  });

  it("a visit the phone records after the contract ended still completes the work and its visit", async () => {
    const s = await bookedWithMoney();
    // The office first ends service after a last day before the visit window.
    const ending = await s.t.api.post(`/contracts/${s.c.id}/cancel`, { reason: "Moving", serviceEndsOn: "2026-03-15" });
    expect(ending.statusCode, ending.body).toBe(200);
    expect(await obligationStatus(s.pump.id)).toBe("open");
    // The completion arrives through the shared close path (the phone's final visit uses it too).
    const done = await s.t.api.post(`/work-orders/${s.wo.id}/complete`, { reason: "Recorded on a paper ticket" });
    expect(done.statusCode, done.body).toBe(200);
    expect(await obligationStatus(s.pump.id)).toBe("completed");
    expect((await money(s.wo.id, s.invoiceId)).invoice?.status).toBe("draft");
  });

  it("the sweep that ends contracts after their last day keeps booked cycle work too", async () => {
    const s = await bookedWithMoney();
    await s.t.api.post(`/contracts/${s.c.id}/cancel`, { reason: "Moving", serviceEndsOn: "2026-03-15" });
    const { endContractsPastService } = await import("@aerowise/tasks");
    ctx.now = new Date("2026-03-20T18:00:00Z");
    expect(await endContractsPastService(ctx.db, s.t.org.id, ctx.now)).toBe(1);
    expect(await obligationStatus(s.pump.id)).toBe("open");
    expect((await money(s.wo.id, s.invoiceId)).wo.status).toBe("scheduled");
  });
});

/** A technician recording one visit of a work order on the phone, with the repair form. */
async function phone(t: Tenant) {
  const tech = await createUser(ctx.db, t.org.id, "technician");
  const techApi = client(ctx.app, await login(ctx.app, tech.email));
  const form = (await techApi.get("/form-templates/work-repair")).json();
  const send = async (jobId: string, finalVisit: boolean) => {
    const clientId = crypto.randomUUID();
    const summary = { workDone: "Serviced aerator", parts: [], notes: "Checked" };
    const sync = (status: "draft" | "completed", revision: number) =>
      techApi.put("/work/sync", {
        clientId,
        jobId,
        templateId: form.id,
        status,
        revision,
        finalVisit,
        arrivedAt: "2026-03-01T15:00:00Z",
        completedAt: status === "completed" ? "2026-03-01T16:00:00Z" : null,
        values: { problem: "Routine", work_performed: "Serviced aerator", follow_up_needed: false },
        summary,
      });
    await sync("draft", 1);
    for (const key of ["before", "after"]) await techApi.putImage(`/work/${clientId}/photos/${crypto.randomUUID()}`, JPEG, { "x-photo-key": key });
    await techApi.put(`/work/${clientId}/signatures/${crypto.randomUUID()}`, {
      requirementKey: "customer_signoff",
      signerName: "Pat Homeowner",
      capture: { kind: "typed" },
      summary,
      summarySha256: await snapshotSha256(summary),
      consentText: "I confirm this work was done.",
      signedAt: "2026-03-01T15:55:00Z",
    });
    return sync("completed", 2);
  };
  return { tech, send };
}

describe("held records and renewals", () => {
  it("a record held after the contract ended and its visit was unscheduled is attached, completing the work and its visit", async () => {
    const t = await createTenant(ctx, "Org A");
    const maint = await maintenanceType(t.api);
    const c = await contractOn(t, (await cyclePlan(t.api, [{ cycleKey: "maint", label: "Maintenance", serviceType: "maintenance", workTypeId: maint, schedule: { kind: "every_months", everyMonths: 6 } }])).id);
    const visit = c.obligations.find((o) => o.serviceType === "maintenance")!;
    const wo = (await book(t.api, visit.id)).json();
    const p = await phone(t);
    const scheduled = await t.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: p.tech.id, scheduledDate: "2026-03-01" });
    const jobId = scheduled.json().visits[0].jobId as string;

    // The contract is cancelled while the technician is offline; the booked visit is kept.
    expect((await t.api.post(`/contracts/${c.id}/cancel`, { reason: "Owner sold the house" })).statusCode).toBe(200);
    expect(await obligationStatus(visit.id)).toBe("open");
    expect((await ctx.db.selectFrom("jobs").select("status").where("id", "=", jobId).executeTakeFirstOrThrow()).status).toBe("scheduled");
    // The office unschedules the route visit; the phone's finished record arrives later and is held.
    expect((await t.api.post(`/jobs/${jobId}/cancel`, { reason: "Contract ended" })).statusCode).toBe(204);
    expect((await p.send(jobId, true)).statusCode).toBe(202);
    const [held] = (await t.api.get("/work/conflicts?status=held")).json().items;
    expect(held).toBeTruthy();
    expect(await obligationStatus(visit.id)).toBe("open");
    // Attaching it finishes the order through the shared hooks, and the visit with it.
    const attached = await t.api.post(`/work/conflicts/${held.id}/attach`, { note: "The work was done" });
    expect(attached.statusCode, attached.body).toBe(200);
    expect((await t.api.get(`/work-orders/${wo.id}`)).json().status).toBe("completed");
    expect(await obligationStatus(visit.id)).toBe("completed");
  });

  it("renews a cycle contract with its version's cycles, and a pumping-only one even with cycles off", async () => {
    const t = await createTenant(ctx, "Org A");
    const pumpType = await workTypeId(t.api, "pumping");
    const mixed = await cyclePlan(t.api, [pumpingCycle(pumpType)]);
    const pumpOnly = await cyclePlan(t.api, [pumpingCycle(pumpType)], false);
    const site2 = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "2 Main St", city: "Austin" })).json();
    const site3 = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "3 Main St", city: "Austin" })).json();
    const make = async (planId: string, siteId: string) => {
      const res = await t.api.post(`/sites/${siteId}/contracts`, { planId, startOn: "2025-04-01", autoRenew: true });
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as ContractDetail;
    };
    const renew = async (api: Api, contractId: string) => {
      const r = await api.post(`/contracts/${contractId}/renewal`, { send: false });
      expect(r.statusCode, r.body).toBe(201);
      const done = await api.post(`/renewals/${r.json().id}/activate`, {});
      expect(done.statusCode, done.body).toBe(200);
      const next = await ctx.db.selectFrom("contracts").select("id").where("previousContractId", "=", contractId).executeTakeFirstOrThrow();
      return (await t.api.get(`/contracts/${next.id}`)).json() as ContractDetail;
    };
    const kinds = (c: ContractDetail) => c.obligations.map((o) => o.serviceType);

    const a = await renew(t.api, (await make(mixed.id, t.site.id)).id);
    expect(kinds(a)).toEqual(["aerobic_inspection", "aerobic_inspection", "pumping", "pumping"]);
    expect(visitsOf(a, "pumping").map((v) => v[4])).toEqual(["2026-09-30", "2027-03-31"]);

    const off = client(await appWithout(), t.cookie);
    const b = await renew(off, (await make(mixed.id, site2.id)).id);
    expect(kinds(b)).toEqual(["aerobic_inspection", "aerobic_inspection"]);
    const p = await renew(off, (await make(pumpOnly.id, site3.id)).id);
    expect(p.serviceType).toBe("pumping");
    expect(kinds(p)).toEqual(["pumping", "pumping"]);

    // The homeowner's renewal page lists what the term includes.
    const r = (await t.api.post(`/contracts/${a.id}/renewal`, { send: false })).json();
    const view = (await client(ctx.app).get(`/renew/${(r.link as string).split("/renew/")[1]}`)).json();
    expect(view.cycles).toEqual(["Aerobic inspections: 2 visits per term", "Tank pumping: Every 6 months, within 30 days of the due date"]);
  });
});

describe("offers and imports never turn cycles into inspections", () => {
  it("offers a pumping-only renewal at a county that adds visits as pumping, without the county's inspection visits, through signing and activation", async () => {
    ctx.now = new Date("2026-10-07T18:00:00Z");
    const t = await createTenant(ctx, "Org A");
    await t.api.post(`/customers/${t.customer.id}/contacts`, { name: "Billing", email: "billing@orga.test", type: "billing" });
    expect((await t.api.post("/billing/stripe/connect", {})).statusCode).toBe(200);
    await t.api.post("/billing/stripe/refresh", {});
    const j = ((await t.api.get("/jurisdictions")).json().items as { id: string; key: string }[]).find((x) => x.key === "tx-hays-county")!;
    const hays = async (siteId: string) => {
      expect((await t.api.patch(`/sites/${siteId}`, { county: "Hays", state: "TX" })).statusCode).toBe(200);
      expect((await t.api.put(`/sites/${siteId}/jurisdiction`, { jurisdictionId: j.id, evidenceKind: "authority_determination", evidenceReference: "Unincorporated; confirmed by phone 2026-10-06" })).statusCode).toBe(200);
    };
    const site2 = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "2 Main St", city: "Kyle" })).json();
    await hays(t.site.id);
    await hays(site2.id);
    const pumpType = await workTypeId(t.api, "pumping");
    const pumpOnly = await cyclePlan(t.api, [pumpingCycle(pumpType)], false);
    const mixed = await cyclePlan(t.api, [pumpingCycle(pumpType)]);
    // Contracts from before the county's profile began, renewed into a term under it.
    const pumpContract = await contractOn(t, pumpOnly.id, "2025-11-01");
    const mixedContract = await contractOn(t, mixed.id, "2025-11-01", site2.id);
    const offer = async (contractId: string) => {
      const r = await t.api.post(`/contracts/${contractId}/renewal`, { send: false });
      expect(r.statusCode, r.body).toBe(201);
      return r.json() as { id: string; link: string };
    };
    const terms = (id: string) => ctx.db.selectFrom("renewals").select(["serviceType", "visitsPerTerm", "customerType", "startOn", "endOn"]).where("id", "=", id).executeTakeFirstOrThrow();

    // With inspections the county adds its visits (2 become 4); pumping only, it does not.
    const m = await offer(mixedContract.id);
    expect(await terms(m.id)).toMatchObject({ serviceType: "aerobic_inspection", visitsPerTerm: 4 });
    const p = await offer(pumpContract.id);
    expect(await terms(p.id)).toMatchObject({ serviceType: "pumping", visitsPerTerm: 2, startOn: "2026-11-01", endOn: "2027-10-31" });

    const token = p.link.split("/renew/")[1]!;
    const view = (await client(ctx.app).get(`/renew/${token}`)).json();
    expect(view.terms).toMatchObject({ serviceType: "pumping", visitsPerTerm: 2 });
    expect(view.cycles).toEqual(["Tank pumping: Every 6 months, within 30 days of the due date"]);
    const signed = await client(ctx.app).post(`/renew/${token}/sign`, { version: view.version, contact: { email: "billing@orga.test" }, signerName: "Pat Homeowner", signature: { kind: "typed" }, agree: true });
    expect(signed.statusCode, signed.body).toBe(200);
    const doc = await ctx.db.selectFrom("signedDocuments").select("content").where("renewalId", "=", p.id).executeTakeFirstOrThrow();
    expect(doc.content).toMatchObject({ term: { serviceType: "pumping", visitsPerTerm: 2 }, cycles: [{ cycleKey: "pumping", label: "Tank pumping" }] });

    const activated = await t.api.post(`/renewals/${p.id}/activate`, {});
    expect(activated.statusCode, activated.body).toBe(200);
    const next = await ctx.db.selectFrom("contracts").select("id").where("previousContractId", "=", pumpContract.id).executeTakeFirstOrThrow();
    const c = (await t.api.get(`/contracts/${next.id}`)).json() as ContractDetail;
    expect(c.serviceType).toBe("pumping");
    expect(visitsOf(c, "pumping")).toEqual([
      ["pumping", 1, "2027-03-31", "2027-05-30", "2027-04-30"],
      ["pumping", 2, "2027-10-01", "2027-10-31", "2027-10-31"],
    ]);
    expect(c.obligations.filter((o) => o.serviceType === "aerobic_inspection")).toEqual([]);
    expect(await ctx.db.selectFrom("filings").select("id").where("contractId", "=", next.id).execute()).toEqual([]);
  });

  it("a pumping-only version on a conventional site in a county that adds visits asks no aerobic confirmation and gets no inspection terms", async () => {
    const t = await createTenant(ctx, "Org A");
    const j = ((await t.api.get("/jurisdictions")).json().items as { id: string; key: string }[]).find((x) => x.key === "tx-hays-county")!;
    expect((await t.api.patch(`/sites/${t.site.id}`, { county: "Hays", state: "TX" })).statusCode).toBe(200);
    expect((await t.api.put(`/sites/${t.site.id}/jurisdiction`, { jurisdictionId: j.id, evidenceKind: "authority_determination", evidenceReference: "Unincorporated; confirmed by phone 2026-10-06" })).statusCode).toBe(200);
    expect((await t.api.patch(`/systems/${t.system.id}`, { systemCategory: "conventional" })).statusCode).toBe(200);
    const pumpType = await workTypeId(t.api, "pumping");
    const pumpOnly = await cyclePlan(t.api, [pumpingCycle(pumpType)], false);
    const mixed = await cyclePlan(t.api, [pumpingCycle(pumpType)]);

    // The plan's scalar terms still say aerobic inspections; the pinned version does not.
    expect((await ctx.db.selectFrom("plans").select("serviceType").where("id", "=", pumpOnly.id).executeTakeFirstOrThrow()).serviceType).toBe("aerobic_inspection");
    const preview = await t.api.get(`/sites/${t.site.id}/contract-terms?planId=${pumpOnly.id}&startOn=2026-11-01`);
    expect(preview.json()).toEqual({ planVisits: 2, visitsPerTerm: 2, warning: null, scheduleNotice: null, systemWarning: null });
    // With inspections, the conventional system is still a warning to confirm.
    expect((await t.api.get(`/sites/${t.site.id}/contract-terms?planId=${mixed.id}&startOn=2026-11-01`)).json().systemWarning).toEqual(expect.any(String));
    expect((await t.api.post(`/sites/${t.site.id}/contracts`, { planId: mixed.id, startOn: "2026-11-01" })).json()).toMatchObject({ error: "system_not_aerobic" });

    const c = await contractOn(t, pumpOnly.id, "2026-11-01");
    expect(c.serviceType).toBe("pumping");
    expect(visitsOf(c, "pumping")).toEqual([
      ["pumping", 1, "2027-03-31", "2027-05-30", "2027-04-30"],
      ["pumping", 2, "2027-10-01", "2027-10-31", "2027-10-31"],
    ]);
    expect(c.obligations.filter((o) => o.serviceType === "aerobic_inspection")).toEqual([]);
    const row = await ctx.db.selectFrom("contracts").select(["serviceType", "visitsPerTerm"]).where("id", "=", c.id).executeTakeFirstOrThrow();
    expect(row.serviceType).toBe("pumping");
    expect(await ctx.db.selectFrom("filings").select("id").where("contractId", "=", c.id).execute()).toEqual([]);
  });

  it("an import names plans with pumping or maintenance and creates no contract from them", async () => {
    const t = await createTenant(ctx, "Org A");
    const pumpType = await workTypeId(t.api, "pumping");
    await t.api.post("/plans", { name: "Annual Aerobic", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 });
    await cyclePlan(t.api, [pumpingCycle(pumpType)], false);
    await cyclePlan(t.api, [pumpingCycle(pumpType)]);
    const csv = ["Name,Address,City,Plan,Start Date", "Plain,1 A St,Austin,Annual Aerobic,3/1/2026", "Pumper,2 B St,Austin,Pumping only,3/1/2026", "Mixed,3 C St,Austin,Aerobic plus pumping,3/1/2026"].join("\n");
    const imp = (await t.api.post("/imports", { filename: "c.csv", contentBase64: Buffer.from(csv).toString("base64") })).json();
    const messages = (imp.rows as { messages: string[] }[]).map((r) => r.messages.filter((m) => /pumping or maintenance/.test(m)));
    expect(messages).toEqual([[], [expect.stringContaining('Plan "Pumping only" includes pumping or maintenance')], [expect.stringContaining('Plan "Aerobic plus pumping" includes pumping or maintenance')]]);
    const done = (await t.api.post(`/imports/${imp.id}/commit`, {})).json();
    expect(done.result).toEqual({ customers: 3, sites: 3, contracts: 1 });
    const kinds = await ctx.db.selectFrom("serviceObligations").select("serviceType").distinct().where("organizationId", "=", t.org.id).execute();
    expect(kinds).toEqual([{ serviceType: "aerobic_inspection" }]);
  });
});

describe("demo cleanup with service cycles", () => {
  /** Rows per tenant table for one organization. */
  async function rowsByTable(organizationId: string) {
    const tables = (
      await sql<{ name: string }>`
        select c.table_name as name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = current_schema() and c.column_name = 'organization_id' and c.table_name not in ('organizations', 'platform_audit_events', 'audit_events')
        order by 1`.execute(ctx.db)
    ).rows.map((r) => r.name);
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(t)} where organization_id = ${organizationId}`.execute(ctx.db)).rows[0]!.n;
    return counts;
  }

  /** A company with a mixed contract, one pumping visit booked and one booked then cancelled. */
  async function withCycleWork(name: string, demo = false) {
    let t: Pick<Tenant, "api" | "org" | "site">;
    if (demo) {
      // A demo company is one from the moment it is made.
      const org = await ctx.db.insertInto("organizations").values({ name, demo: true } as never).returning("id").executeTakeFirstOrThrow();
      const api = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, org.id, "owner")).email));
      const customer = (await api.post("/customers", { displayName: `${name} customer` })).json();
      t = { org, api, site: (await api.post(`/customers/${customer.id}/sites`, { addressLine1: "1 Main St", city: "Austin" })).json() };
    } else t = await createTenant(ctx, name);
    const plan = await cyclePlan(t.api, [pumpingCycle(await workTypeId(t.api, "pumping"))]);
    const c = await contractOn(t, plan.id);
    const [first, second] = c.obligations.filter((o) => o.serviceType === "pumping");
    expect((await book(t.api, first!.id)).statusCode).toBe(201);
    const wo = (await book(t.api, second!.id)).json();
    expect((await t.api.post(`/work-orders/${wo.id}/cancel`, { reason: "Customer asked to wait" })).statusCode).toBeLessThan(300);
    return t;
  }

  it("a visitor demo's erase and the nightly reseed remove cycles, their visits and their work orders, and leave a real company as it was", async () => {
    const real = await withCycleWork("Real Septic");
    const realBefore = await rowsByTable(real.org.id);
    expect(realBefore).toMatchObject({ contract_service_cycles: 2, work_orders: 2 });

    const visitor = await withCycleWork("Visitor Demo", true);
    const nightly = await withCycleWork("Public Demo", true);
    expect((await rowsByTable(visitor.org.id)).contract_service_cycles).toBe(2);

    await ctx.db.transaction().execute((trx) => eraseOrganization(trx, visitor.org.id));
    expect(Object.entries(await rowsByTable(visitor.org.id)).filter(([, n]) => n > 0)).toEqual([]);

    const r = await reseedDemo(ctx.db);
    expect(r.removed).toContain(nightly.org.id);
    expect(Object.entries(await rowsByTable(nightly.org.id)).filter(([, n]) => n > 0)).toEqual([]);
    expect(await rowsByTable(real.org.id)).toEqual(realBefore);
  });
});
