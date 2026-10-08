import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";

const ctx = setupTestApp({ features: ["work_orders", "field_work"] });

type Api = ReturnType<typeof client>;
const north = (i: number) => ({ lat: 30 + i / 10, lng: -97.7 });
const DAY = "2026-03-02";

/**
 * One technician's day, south to north: an inspection at A, a pumping visit at B (its kind of
 * work says 60 minutes), and at C a kind of work with no minutes of its own. Average stop: 30.
 */
async function mixedDay(c: TestContext) {
  const t = await createTenant(c, "Org A");
  const tech = await createUser(c.db, t.org.id, "technician");
  const techApi = client(c.app, await login(c.app, tech.email));
  await t.api.patch("/routing/settings", { start: { addressLine1: "100 Yard Rd", city: "Austin", ...north(0) }, stopMinutes: 30, speedMph: 30 });
  const plan = (await t.api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
  const site = async (label: string, i: number) => (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: `${label} Ranch Rd`, city: "Austin", ...north(i) })).json();
  const [a, b, cSite] = [await site("A", 3), await site("B", 1), await site("C", 2)];
  const contract = (await t.api.post(`/sites/${a.id}/contracts`, { planId: plan.id, startOn: "2025-12-01" })).json();
  const inspection = (await t.api.post("/jobs", { obligationId: contract.obligations[0].id, technicianId: tech.id, scheduledDate: DAY })).json();
  const types = (await t.api.get("/work-types")).json().items as { id: string; key: string }[];
  const pumping = types.find((x) => x.key === "pumping")!.id;
  const jetting = (await t.api.post("/work-types", { key: "jetting", name: "Line jetting", category: "maintenance" })).json();
  const work = async (siteId: string, workTypeId: string) => {
    const wo = (await t.api.post("/work-orders", { siteId, workTypeId })).json();
    const scheduled = await t.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: tech.id, scheduledDate: DAY });
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    return scheduled.json().nextVisit.jobId as string;
  };
  const pump = await work(b.id, pumping);
  const jet = await work(cSite.id, jetting.id);
  return { ...t, tech, techApi, inspection: inspection.jobId as string, pump, jet };
}

const routeOf = async (api: Api) => (await api.get(`/routing/day?date=${DAY}`)).json().technicians[0];

describe("work visits on a technician's route", () => {
  it("counts each work visit's own minutes on site and the average for the rest", async () => {
    const d = await mixedDay(ctx);
    const r = await routeOf(d.api);
    expect(r.stops.map((s: { jobId: string }) => s.jobId)).toEqual([d.inspection, d.pump, d.jet]);
    // Inspection 30 (average) + pumping 60 (its kind of work) + jetting 30 (no minutes of its own: average).
    expect(r.serviceMinutes).toBe(120);
    expect(r.totalMinutes).toBe(r.driveMinutes + 120);
    expect(r.overCapacity).toBe(false);

    // The day fits on driving plus these minutes, not on stops × average.
    await d.api.patch("/routing/settings", { dayMinutes: r.driveMinutes + 100 });
    expect((await routeOf(d.api)).overCapacity).toBe(true);
    await d.api.patch("/routing/settings", { dayMinutes: r.driveMinutes + 120 });
    expect((await routeOf(d.api)).overCapacity).toBe(false);
  });

  it("orders work and inspection stops together by straight-line distance", async () => {
    const d = await mixedDay(ctx);
    const res = (await d.api.post("/routing/optimize", { technicianId: d.tech.id, scheduledDate: DAY, apply: true })).json();
    // South to north from the yard: B (pumping), C (jetting), A (inspection).
    expect(res.proposedJobIds).toEqual([d.pump, d.jet, d.inspection]);
    expect(res.applied).toBe(true);
    const day = (await d.api.get(`/schedule?from=${DAY}&to=${DAY}`)).json().items as { jobId: string; routePosition: number }[];
    expect(day.map((s) => [s.jobId, s.routePosition])).toEqual([
      [d.pump, 1],
      [d.jet, 2],
      [d.inspection, 3],
    ]);
  });

  it("gives stops their minutes on site, and the phone its work stops' kind, while its inspection route stays inspections only", async () => {
    const d = await mixedDay(ctx);
    const items = (await d.api.get(`/schedule?from=${DAY}&to=${DAY}`)).json().items as { jobId: string; kind: string; durationMinutes: number | null; workOrder: { category: string } | null }[];
    expect(items.map((s) => [s.kind, s.workOrder?.category ?? null, s.durationMinutes])).toEqual([
      ["inspection", null, null],
      ["work", "pumping", 60],
      ["work", "maintenance", null],
    ]);

    // Phones on the rollback floor read every /route stop as an inspection.
    const route = (await d.techApi.get(`/route?date=${DAY}`)).json().items as { jobId: string }[];
    expect(route.map((s) => s.jobId)).toEqual([d.inspection]);
    const work = (await d.techApi.get(`/work/route?date=${DAY}`)).json().items as { jobId: string; category: string; durationMinutes: number | null; routePosition: number }[];
    expect(work.map((s) => [s.jobId, s.category, s.durationMinutes, s.routePosition])).toEqual([
      [d.pump, "pumping", 60, 2],
      [d.jet, "maintenance", null, 3],
    ]);
  });
});
