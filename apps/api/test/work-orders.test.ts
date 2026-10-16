import { readFile } from "node:fs/promises";
import { drainTasks } from "@aerowise/tasks";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, payload, setup, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

const ctx = setupTestApp({ features: ["work_orders"] });

type Api = ReturnType<typeof client>;

const workTypes = async (api: Api) => (await api.get("/work-types")).json().items as { id: string; key: string; name: string; category: string }[];
const typeId = async (api: Api, key: string) => (await workTypes(api)).find((t) => t.key === key)!.id;

/** What the compliance path holds for the company: none of it may move when work is done. */
async function complianceCounts(c: TestContext, organizationId: string) {
  const n = async (table: string, where = sql``) =>
    Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(table)} where organization_id = ${organizationId} ${where}`.execute(c.db)).rows[0]!.n);
  return {
    filings: await n("filings"),
    reports: await n("reports"),
    complianceEvents: await n("compliance_events"),
    inspections: await n("inspections"),
    openVisits: await n("service_obligations", sql`and status = 'open'`),
    completedVisits: await n("service_obligations", sql`and status = 'completed'`),
    tasks: await n("background_tasks"),
  };
}

describe("work orders", () => {
  it("runs each kind of work from creation to completion without touching filings, reports or aerobic visits", async () => {
    const s = await setup(ctx);
    const before = await complianceCounts(ctx, s.org.id);
    const types = await workTypes(s.api);
    expect(types.map((t) => [t.key, t.category])).toEqual([
      ["pumping", "pumping"],
      ["repair", "repair"],
      ["installation", "installation"],
      ["service_call", "other"],
      ["conventional_service", "maintenance"],
    ]);

    for (const [i, t] of types.entries()) {
      const created = await s.api.post("/work-orders", { siteId: s.site.id, workTypeId: t.id, description: "From the office", lines: [{ description: "Labor", quantity: 1.5, unitPriceCents: 9000 }] });
      expect(created.statusCode, created.body).toBe(201);
      const wo = created.json();
      expect(wo).toMatchObject({ number: 1001 + i, label: `WO-${1001 + i}`, title: t.name, category: t.category, status: "open", sourceKind: "office", linesTotalCents: 13500 });
      expect(wo.lines[0]).toMatchObject({ quantityMilli: 1500, quantity: 1.5, amountCents: 13500 });

      const scheduled = await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-02" });
      expect(scheduled.statusCode, scheduled.body).toBe(201);
      expect(scheduled.json()).toMatchObject({ status: "scheduled", nextVisit: { scheduledDate: "2026-03-02", technicianId: s.tech.id }, visits: [{ visitNumber: 1, status: "scheduled" }] });

      const done = await s.api.post(`/work-orders/${wo.id}/complete`, { reason: "Recorded on the paper ticket" });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toMatchObject({ status: "completed", completedWithoutRecordReason: "Recorded on the paper ticket", nextVisit: null, visits: [{ status: "cancelled" }] });
      expect(done.json().events.map((e: { eventType: string }) => e.eventType)).toEqual(["created", "visit_scheduled", "completed"]);
    }
    await drainTasks({ db: ctx.db, store: ctx.store, now: () => ctx.now });
    expect(await complianceCounts(ctx, s.org.id)).toEqual(before);
    // The inspection visit scheduled in setup is still the one live job on its obligation.
    expect((await s.api.get("/obligations/due?through=2026-12-31")).json().items[0]).toMatchObject({ id: s.visit.id });
  });

  it("puts work visits on the office schedule with their kind, but not on the technician's phone route yet", async () => {
    const s = await setup(ctx);
    const wo = (await s.api.post("/work-orders", { siteId: s.site.id, workTypeId: await typeId(s.api, "pumping") })).json();
    await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-01" });

    const schedule = (await s.api.get("/schedule?from=2026-03-01&to=2026-03-01")).json().items as { jobId: string; kind: string; workOrder: { label: string; workTypeName: string } | null; routePosition: number }[];
    expect(schedule.map((x) => [x.kind, x.workOrder?.label ?? null, x.routePosition])).toEqual([
      ["inspection", null, 1],
      ["work", "WO-1001", 2],
    ]);
    expect(schedule[1]!.workOrder).toMatchObject({ workTypeName: "Pumping" });

    const route = (await s.techApi.get("/route?date=2026-03-01")).json().items as { jobId: string; kind: string }[];
    expect(route.map((x) => x.kind)).toEqual(["inspection"]);

    // The office still orders the whole day, both kinds.
    const workJob = schedule[1]!.jobId;
    const reordered = await s.api.post("/schedule/reorder", { technicianId: s.tech.id, scheduledDate: "2026-03-01", jobIds: [workJob, s.job.jobId] });
    expect(reordered.statusCode, reordered.body).toBe(200);
    expect(reordered.json().items.map((x: { kind: string }) => x.kind)).toEqual(["work", "inspection"]);

    // Today's stops on the dashboard count both.
    expect((await s.api.get("/inbox")).json().routes).toMatchObject([{ technicianId: s.tech.id, stops: 2, done: 0 }]);
    // The phone cannot open a work visit as an inspection.
    const asInspection = await s.techApi.put("/inspections/sync", payload(s, { jobId: workJob }));
    expect(asInspection.statusCode).toBe(404);
    // "On the way" works for a work visit as for an inspection.
    expect((await s.techApi.post(`/jobs/${workJob}/on-the-way`, {})).statusCode).toBe(200);
  });

  it("returns a work order to ready to schedule when its visit is unscheduled, and numbers the next visit", async () => {
    const s = await setup(ctx);
    const wo = (await s.api.post("/work-orders", { siteId: s.site.id, workTypeId: await typeId(s.api, "repair") })).json();
    const first = (await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-02" })).json();
    expect((await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-03" })).statusCode).toBe(409);

    const moved = await s.api.patch(`/jobs/${first.visits[0].jobId}`, { scheduledDate: "2026-03-04" });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ kind: "work", workOrder: { label: "WO-1001", visitNumber: 1 } });

    expect((await s.api.post(`/jobs/${first.visits[0].jobId}/cancel`, { reason: "Customer away" })).statusCode).toBe(204);
    const reopened = (await s.api.get(`/work-orders/${wo.id}`)).json();
    expect(reopened).toMatchObject({ status: "open", nextVisit: null });
    expect(reopened.events.map((e: { eventType: string }) => e.eventType)).toEqual(["created", "visit_scheduled", "visit_moved", "visit_cancelled"]);

    const second = (await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-05" })).json();
    expect(second.visits.map((v: { visitNumber: number; status: string }) => [v.visitNumber, v.status])).toEqual([
      [1, "cancelled"],
      [2, "scheduled"],
    ]);

    // Cancelling the order unschedules its open visit and keeps the history.
    const cancelled = (await s.api.post(`/work-orders/${wo.id}/cancel`, { reason: "Customer fixed it themselves" })).json();
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "Customer fixed it themselves", visits: [{ status: "cancelled" }, { status: "cancelled" }] });
    expect((await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-06" })).statusCode).toBe(409);
    expect((await s.api.post(`/work-orders/${wo.id}/complete`, { reason: "x" })).statusCode).toBe(409);
    expect((await s.api.patch(`/work-orders/${wo.id}`, { title: "Too late" })).statusCode).toBe(409);
  });

  it("keeps drafts off the schedule until they are ready, and edits planned lines", async () => {
    const t = await createTenant(ctx, "Org A");
    const tech = await createUser(ctx.db, t.org.id, "technician");
    const wo = (await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: await typeId(t.api, "installation"), draft: true, title: "New aerobic unit" })).json();
    expect(wo.status).toBe("draft");
    expect((await t.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: tech.id, scheduledDate: "2026-03-02" })).json()).toMatchObject({ error: "not_ready" });
    const edited = await t.api.patch(`/work-orders/${wo.id}`, { ready: true, priority: "urgent", lines: [{ description: "Unit", quantity: 1, unitPriceCents: 650000, taxable: true }, { description: "Haul-off", quantity: 0.25, unitPriceCents: 10001 }] });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ status: "open", priority: "urgent", linesTotalCents: 650000 + 2500 });
    expect((await t.api.patch(`/work-orders/${wo.id}`, { lines: [{ description: "Bad", quantity: 0.0001, unitPriceCents: 1 }] })).statusCode).toBe(400);
  });

  it("numbers work orders without gaps per company", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const pump = await typeId(a.api, "pumping");
    expect((await a.api.post("/work-orders", { siteId: a.site.id, workTypeId: pump })).json().number).toBe(1001);
    // A refused create gives no number away.
    expect((await a.api.post("/work-orders", { siteId: a.site.id, workTypeId: await typeId(b.api, "pumping") })).statusCode).toBe(422);
    expect((await b.api.post("/work-orders", { siteId: b.site.id, workTypeId: await typeId(b.api, "pumping") })).json().number).toBe(1001);
    expect((await a.api.post("/work-orders", { siteId: a.site.id, workTypeId: pump })).json().number).toBe(1002);
  });

  it("lets the owner add, rename and switch off kinds of work, and refuses a switched-off one", async () => {
    const t = await createTenant(ctx, "Org A");
    const added = await t.api.post("/work-types", { key: "jetting", name: "Line jetting", category: "maintenance", defaultDurationMinutes: 120 });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({ key: "jetting", position: 6, active: true });
    expect((await t.api.post("/work-types", { key: "jetting", name: "Again", category: "other" })).statusCode).toBe(409);
    const off = await t.api.patch(`/work-types/${added.json().id}`, { active: false, name: "Jetting" });
    expect(off.json()).toMatchObject({ name: "Jetting", active: false });
    expect((await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: added.json().id })).statusCode).toBe(422);
  });
});

describe("turning issues and requests into work", () => {
  async function inspectedWithIssue(): Promise<Setup & { issueId: string }> {
    const s = await setup(ctx);
    await s.techApi.put("/inspections/sync", payload(s));
    await uploadRequiredPhotos(s, payload(s).clientId);
    const done = await s.techApi.put(
      "/inspections/sync",
      payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: completeValues(), issues: [{ clientId: "2b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d01", type: "pump_out", severity: "high", description: "Sludge near the top" }] }),
    );
    expect(done.json().status).toBe("completed");
    return { ...s, issueId: done.json().issues[0].id };
  }

  it("makes one work order per issue however often it is asked, and links both ways", async () => {
    const s = await inspectedWithIssue();
    const [a, b] = await Promise.all([s.api.post(`/issues/${s.issueId}/work-order`, {}), s.api.post(`/issues/${s.issueId}/work-order`, {})]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().id).toBe(b.json().id);
    const wo = a.json();
    expect(wo).toMatchObject({ title: "Pump-out needed", category: "pumping", priority: "urgent", description: "Sludge near the top", sourceKind: "inspection_issue", sourceId: s.issueId, source: { label: "Inspection issue: Pump-out needed" } });
    const again = await s.api.post(`/issues/${s.issueId}/work-order`, {});
    expect([again.statusCode, again.json().id]).toEqual([200, wo.id]);
    expect((await ctx.db.selectFrom("workOrders").select("id").where("organizationId", "=", s.org.id).execute()).length).toBe(1);

    const item = ((await s.api.get("/inbox")).json().items as { kind: string; target: { id: string }; workOrder: unknown }[]).find((x) => x.kind === "issue_open" && x.target.id === s.issueId);
    expect(item!.workOrder).toEqual({ id: wo.id, label: "WO-1001", status: "open" });

    // After a cancellation, asking again makes a new one.
    await s.api.post(`/work-orders/${wo.id}/cancel`, { reason: "Wrong site" });
    const fresh = await s.api.post(`/issues/${s.issueId}/work-order`, { workTypeId: await typeId(s.api, "repair"), title: "Pump and inspect baffle" });
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json()).toMatchObject({ number: 1002, category: "repair", title: "Pump and inspect baffle" });
  });

  it("makes one work order per service request and leaves the request's own response alone", async () => {
    const t = await createTenant(ctx, "Org A");
    const sr = (await t.api.post("/service-requests", { siteId: t.site.id, kind: "alarm", description: "Red light on the panel", receivedAt: "2026-02-28T15:00:00Z" })).json();
    const first = await t.api.post(`/service-requests/${sr.id}/work-order`, {});
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ category: "other", priority: "urgent", sourceKind: "portal_request" });
    const second = await t.api.post(`/service-requests/${sr.id}/work-order`, {});
    expect([second.statusCode, second.json().id]).toEqual([200, first.json().id]);
    const request = await ctx.db.selectFrom("serviceRequests").select(["status", "workOrderId", "responseAction"]).where("id", "=", sr.id).executeTakeFirstOrThrow();
    expect(request).toEqual({ status: "open", workOrderId: first.json().id, responseAction: null });
  });

  it("follows the work in the inbox: low once on a route, closed with its issue and request when the work is done", async () => {
    const s = await inspectedWithIssue();
    const sr = (await s.api.post("/service-requests", { siteId: s.site.id, kind: "alarm", description: "Red light on the panel", receivedAt: "2026-02-28T15:00:00Z" })).json();
    const fromIssue = (await s.api.post(`/issues/${s.issueId}/work-order`, {})).json();
    const fromRequest = (await s.api.post(`/service-requests/${sr.id}/work-order`, {})).json();
    type Item = { kind: string; severity: string; target: { id: string }; workOrder?: { status: string } | null; groupKey?: string };
    const item = async (kind: string, id: string) => ((await s.api.get("/inbox")).json().items as Item[]).find((x) => x.kind === kind && x.target.id === id);
    expect(await item("issue_open", s.issueId)).toMatchObject({ severity: "high", workOrder: { status: "open" } });
    expect(await item("service_request", sr.id)).toMatchObject({ severity: "high", groupKey: `service_request:${sr.id}` });

    // Booked: the office has dealt with them, so they drop to the bottom.
    for (const wo of [fromIssue, fromRequest]) await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-02" });
    expect(await item("issue_open", s.issueId)).toMatchObject({ severity: "low", workOrder: { status: "scheduled" } });
    expect(await item("service_request", sr.id)).toMatchObject({ severity: "low", workOrder: { status: "scheduled" } });

    // Done: what each was made for is closed in the same step.
    for (const wo of [fromIssue, fromRequest]) expect((await s.api.post(`/work-orders/${wo.id}/complete`, { reason: "Recorded on the paper ticket" })).statusCode).toBe(200);
    expect(await item("issue_open", s.issueId)).toBeUndefined();
    expect(await item("service_request", sr.id)).toBeUndefined();
    expect(await ctx.db.selectFrom("issues").select(["status", "resolution", "resolvedBy"]).where("id", "=", s.issueId).executeTakeFirstOrThrow()).toEqual({ status: "resolved", resolution: "Done: WO-1001 completed", resolvedBy: s.owner.id });
    expect(await ctx.db.selectFrom("serviceRequests").select(["status", "resolution", "closedBy"]).where("id", "=", sr.id).executeTakeFirstOrThrow()).toEqual({ status: "closed", resolution: "Done: WO-1002 completed", closedBy: s.owner.id });
    expect(await ctx.db.selectFrom("auditEvents").select("action").where("action", "in", ["issue.resolved", "service_request.closed"]).execute()).toHaveLength(2);
  });

  it("links one call's dispatch and its reportable response as one card", async () => {
    const t = await createTenant(ctx, "Org A");
    const sr = (await t.api.post("/service-requests", { siteId: t.site.id, kind: "odor", description: "Neighbor complained about smell", receivedAt: "2026-02-28T15:00:00Z" })).json();
    expect((await t.api.post(`/service-requests/${sr.id}/classify`, { classification: "owner_complaint" })).statusCode).toBe(200);
    const items = ((await t.api.get("/inbox")).json().items as { kind: string; groupKey?: string; site: { id: string } }[]).filter((x) => x.groupKey === `service_request:${sr.id}`);
    expect(items.map((x) => x.kind).sort()).toEqual(["complaint_unresolved", "service_request"]);
    expect(new Set(items.map((x) => x.site.id))).toEqual(new Set([t.site.id]));
  });

  it("lets a request's response cite a work visit or a retest, not only a contract visit", async () => {
    const t = await createTenant(ctx, "Org A");
    const tech = await createUser(ctx.db, t.org.id, "technician");
    const sr = (await t.api.post("/service-requests", { siteId: t.site.id, kind: "repair", description: "Pump hums", receivedAt: "2026-02-28T15:00:00Z" })).json();
    const wo = (await t.api.post(`/service-requests/${sr.id}/work-order`, {})).json();
    const visit = (await t.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: tech.id, scheduledDate: "2026-03-02" })).json().visits[0];
    const res = await t.api.post(`/service-requests/${sr.id}/response`, { action: "Visit booked", respondedAt: "2026-03-01T15:00:00Z", jobId: visit.jobId, outcome: "outstanding" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ responseJobId: visit.jobId });
  });
});

describe("data from before finished work closed its issues (migration 0067)", () => {
  it("closes the issues and requests of finished work, and moves each site's next visit to the authority's date", async () => {
    const s = await setup(ctx);
    await s.api.patch(`/sites/${s.site.id}`, { county: "Example County" });
    await ctx.db.updateTable("memberships").set({ technicianLicense: "MP-0001" }).where("userId", "=", s.tech.id).execute();
    await s.techApi.put("/inspections/sync", payload(s));
    await uploadRequiredPhotos(s, payload(s).clientId);
    const done = (
      await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values: { ...completeValues(), air_pressure: 4 }, issues: [{ clientId: "2b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d01", type: "pump_out", severity: "high", description: "Sludge near the top" }] }))
    ).json();
    const issueId = done.issues[0].id as string;
    const sr = (await s.api.post("/service-requests", { siteId: s.site.id, kind: "alarm", description: "Red light", receivedAt: "2026-02-28T15:00:00Z" })).json();
    const open = (await s.api.post(`/service-requests/${sr.id}/work-order`, {})).json();
    const finished = (await s.api.post(`/issues/${issueId}/work-order`, {})).json();
    await s.api.post(`/work-orders/${finished.id}/complete`, { reason: "Paper ticket" });
    const visit2 = s.contract.obligations[1];

    // As the earlier release left it: the finished work's issue still open, the visit on the contract's date.
    await ctx.db.updateTable("issues").set({ status: "open", resolvedAt: null, resolvedBy: null, resolution: null }).where("id", "=", issueId).execute();
    await ctx.db.updateTable("serviceObligations").set({ dueOn: visit2.dueOn, windowEnd: visit2.windowEnd }).where("id", "=", visit2.id).execute();
    const file = await readFile(new URL("../../../packages/db/migrations/0067_follow_up_issues_and_next_due.sql", import.meta.url), "utf8");
    await sql.raw(file.replace(/^alter table issues add column field_key text;$/m, "")).execute(ctx.db);

    expect(await ctx.db.selectFrom("issues").select(["status", "resolution"]).where("id", "=", issueId).executeTakeFirstOrThrow()).toEqual({ status: "resolved", resolution: "Done: WO-1002 completed" });
    // A request whose work is not done stays open.
    expect((await ctx.db.selectFrom("serviceRequests").select("status").where("id", "=", sr.id).executeTakeFirstOrThrow()).status).toBe("open");
    expect(open.status).toBe("open");
    expect(await ctx.db.selectFrom("serviceObligations").select(["dueOn", "windowStart", "windowEnd"]).where("id", "=", visit2.id).executeTakeFirstOrThrow()).toEqual({ dueOn: "2026-07-01", windowStart: "2026-04-01", windowEnd: "2026-07-01" });
    // The visit after it keeps the contract's date.
    expect((await ctx.db.selectFrom("serviceObligations").select("dueOn").where("id", "=", s.contract.obligations[2].id).executeTakeFirstOrThrow()).dueOn).toBe("2026-11-30");
  });
});

describe("work order access", () => {
  it("answers another company's ids as not found everywhere", async () => {
    const s = await setup(ctx);
    const other = await createTenant(ctx, "Org B");
    const wo = (await s.api.post("/work-orders", { siteId: s.site.id, workTypeId: await typeId(s.api, "repair") })).json();
    const sr = (await s.api.post("/service-requests", { siteId: s.site.id, kind: "repair", description: "Pump hums loudly", receivedAt: "2026-02-28T15:00:00Z" })).json();
    const otherTech = await createUser(ctx.db, other.org.id, "technician");
    const calls = [
      other.api.get(`/work-orders/${wo.id}`),
      other.api.patch(`/work-orders/${wo.id}`, { title: "Mine" }),
      other.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: otherTech.id, scheduledDate: "2026-03-02" }),
      other.api.post(`/work-orders/${wo.id}/cancel`, { reason: "x" }),
      other.api.post(`/work-orders/${wo.id}/complete`, { reason: "x" }),
      other.api.post(`/work-orders/${wo.id}/notes`, { body: "x" }),
      other.api.post(`/service-requests/${sr.id}/work-order`, {}),
      other.api.patch(`/work-types/${await typeId(s.api, "repair")}`, { name: "Mine" }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode, res.body).toBe(404);
    // Their own site with this company's kind of work, and this company's site, are refused too.
    expect((await other.api.post("/work-orders", { siteId: other.site.id, workTypeId: await typeId(s.api, "repair") })).statusCode).toBe(422);
    expect((await other.api.post("/work-orders", { siteId: s.site.id, workTypeId: await typeId(other.api, "repair") })).statusCode).toBe(404);
    expect((await other.api.get("/work-orders")).json()).toEqual({ items: [], total: 0 });
  });

  it("shows a technician only the work orders they have a visit on, and keeps changes to the office", async () => {
    const s = await setup(ctx);
    const otherTech = await createUser(ctx.db, s.org.id, "technician");
    const mine = (await s.api.post("/work-orders", { siteId: s.site.id, workTypeId: await typeId(s.api, "pumping") })).json();
    const theirs = (await s.api.post("/work-orders", { siteId: s.site.id, workTypeId: await typeId(s.api, "repair") })).json();
    await s.api.post(`/work-orders/${mine.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-02" });
    await s.api.post(`/work-orders/${theirs.id}/schedule`, { technicianId: otherTech.id, scheduledDate: "2026-03-02" });

    expect((await s.techApi.get("/work-orders")).json().items.map((w: { id: string }) => w.id)).toEqual([mine.id]);
    expect((await s.techApi.get(`/work-orders/${theirs.id}`)).statusCode).toBe(404);
    expect((await s.techApi.get(`/work-orders/${mine.id}`)).statusCode).toBe(200);
    expect((await s.techApi.post("/work-orders", { siteId: s.site.id, workTypeId: mine.workType.id })).statusCode).toBe(403);
    expect((await s.techApi.post(`/work-orders/${mine.id}/complete`, { reason: "x" })).statusCode).toBe(403);

    const reader = await createUser(ctx.db, s.org.id, "read_only");
    const readApi = client(ctx.app, await login(ctx.app, reader.email));
    expect((await readApi.get("/work-orders")).json().total).toBe(2);
    expect((await readApi.post(`/work-orders/${mine.id}/notes`, { body: "x" })).statusCode).toBe(403);

    const office = await createUser(ctx.db, s.org.id, "office");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    expect((await officeApi.post("/work-orders", { siteId: s.site.id, workTypeId: mine.workType.id })).statusCode).toBe(201);
    expect((await officeApi.post("/work-types", { key: "x", name: "X", category: "other" })).statusCode).toBe(403);

    const note = await officeApi.post(`/work-orders/${mine.id}/notes`, { body: "Gate code changed", visibility: "customer" });
    expect(note.json().notes).toMatchObject([{ body: "Gate code changed", visibility: "customer" }]);
  });

  it("refuses new work while the feature is off but lets existing work be read and finished", async () => {
    const s = await setup(ctx);
    const wo = (await s.api.post("/work-orders", { siteId: s.site.id, workTypeId: await typeId(s.api, "repair") })).json();
    const sr = (await s.api.post("/service-requests", { siteId: s.site.id, kind: "repair", description: "Pump hums loudly", receivedAt: "2026-02-28T15:00:00Z" })).json();
    await s.api.post(`/service-requests/${sr.id}/work-order`, {});

    const off = await buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store, loginRateLimit: 1000, features: new Set() });
    try {
      const api = client(off, await login(off, s.owner.email));
      expect((await api.get("/app-info")).json().features).toEqual([]);
      expect((await ctx.app.inject({ method: "GET", url: "/app-info" })).json().features).toEqual(["work_orders"]);
      expect((await api.post("/work-orders", { siteId: s.site.id, workTypeId: wo.workType.id })).json()).toMatchObject({ error: "feature_off" });
      expect((await api.post("/work-types", { key: "x", name: "X", category: "other" })).statusCode).toBe(409);
      // Converting something already converted just finds it; a new conversion is refused.
      expect((await api.post(`/service-requests/${sr.id}/work-order`, {})).statusCode).toBe(200);
      const sr2 = (await api.post("/service-requests", { siteId: s.site.id, kind: "repair", description: "Grass is wet", receivedAt: "2026-02-28T15:00:00Z" })).json();
      expect((await api.post(`/service-requests/${sr2.id}/work-order`, {})).statusCode).toBe(409);
      expect((await api.get(`/work-orders/${wo.id}`)).statusCode).toBe(200);
      expect((await api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-02" })).statusCode).toBe(201);
      expect((await api.post(`/work-orders/${wo.id}/complete`, { reason: "Done on paper" })).json().status).toBe("completed");
    } finally {
      await off.close();
    }
  });
});
