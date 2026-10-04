import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";

const ctx = setupTestApp();

/** A tenant with a technician, a contract and its visits. Today is 2026-03-01. */
async function setup(c: TestContext, name = "Org A") {
  const t = await createTenant(c, name);
  await t.api.patch(`/sites/${t.site.id}`, { safetyFlags: ["dog"], schedulingNotes: "Call 30 minutes ahead", gateCode: "4821" });
  const plan = (await t.api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
  const contract = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2025-12-01" })).json();
  const tech = await createUser(c.db, t.org.id, "technician");
  const techApi = client(c.app, await login(c.app, tech.email));
  const visit = contract.obligations[0];
  return { ...t, plan, contract, tech, techApi, visit };
}

// Acceptance tests: due obligation appears in unscheduled work; job assignment updates
// the tech's route; customer scheduling restrictions are visible.
describe("scheduling a due visit", () => {
  it("moves the visit from unscheduled work onto the technician's route", async () => {
    const t = await setup(ctx);
    const unscheduled = (await t.api.get("/obligations/due?unscheduledOnly=true")).json();
    expect(unscheduled.items.map((o: { id: string }) => o.id)).toEqual([t.visit.id]);
    expect(unscheduled.items[0].site).toMatchObject({ safetyFlags: ["dog"], schedulingNotes: "Call 30 minutes ahead" });

    const res = await t.api.post("/jobs", { obligationId: t.visit.id, technicianId: t.tech.id, scheduledDate: "2026-03-02" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "scheduled", routePosition: 1, technicianId: t.tech.id, obligation: { id: t.visit.id } });

    expect((await t.api.get("/obligations/due?unscheduledOnly=true")).json().items).toHaveLength(0);
    const due = (await t.api.get("/obligations/due")).json();
    expect(due.items[0].job).toMatchObject({ scheduledDate: "2026-03-02", technicianId: t.tech.id });

    const route = (await t.techApi.get("/route?date=2026-03-02")).json();
    expect(route.items).toHaveLength(1);
    expect(route.items[0]).toMatchObject({
      site: { addressLine1: "1 Main St", gateCode: "4821", safetyFlags: ["dog"], schedulingNotes: "Call 30 minutes ahead" },
      customer: { displayName: "Org A customer" },
      system: { manufacturer: "Acme" },
    });
  });

  it("defaults the route to today in the organization's timezone", async () => {
    const t = await setup(ctx);
    await t.api.post("/jobs", { obligationId: t.visit.id, technicianId: t.tech.id, scheduledDate: "2026-03-01" });
    const route = (await t.techApi.get("/route")).json();
    expect(route.date).toBe("2026-03-01");
    expect(route.items).toHaveLength(1);
  });

  it("refuses to schedule the same visit twice", async () => {
    const t = await setup(ctx);
    await t.api.post("/jobs", { obligationId: t.visit.id, technicianId: t.tech.id, scheduledDate: "2026-03-02" });
    const again = await t.api.post("/jobs", { obligationId: t.visit.id, technicianId: t.tech.id, scheduledDate: "2026-03-03" });
    expect(again.statusCode).toBe(409);
  });

  it("only assigns active technicians or owners", async () => {
    const t = await setup(ctx);
    const office = await createUser(ctx.db, t.org.id, "office");
    const gone = await createUser(ctx.db, t.org.id, "technician", { membershipActive: false });
    for (const technicianId of [office.id, gone.id]) {
      const res = await t.api.post("/jobs", { obligationId: t.visit.id, technicianId, scheduledDate: "2026-03-02" });
      expect(res.statusCode).toBe(422);
    }
    expect((await t.api.post("/jobs", { obligationId: t.visit.id, technicianId: t.owner.id, scheduledDate: "2026-03-02" })).statusCode).toBe(201);
    const techs = (await t.api.get("/technicians")).json().items.map((x: { id: string }) => x.id);
    expect(techs).toEqual([t.tech.id, t.owner.id]);
  });

  it("refuses visits that are not open", async () => {
    const t = await setup(ctx);
    await t.api.post(`/contracts/${t.contract.id}/cancel`, { reason: "Moved" });
    const res = await t.api.post("/jobs", { obligationId: t.visit.id, technicianId: t.tech.id, scheduledDate: "2026-03-02" });
    expect(res.statusCode).toBe(422);
  });
});

describe("changing the schedule", () => {
  it("moves a job to another day at the end of that day's route", async () => {
    const t = await setup(ctx);
    const [a, b] = [t.contract.obligations[0], t.contract.obligations[1]];
    await t.api.post("/jobs", { obligationId: a.id, technicianId: t.tech.id, scheduledDate: "2026-03-03" });
    const jb = (await t.api.post("/jobs", { obligationId: b.id, technicianId: t.tech.id, scheduledDate: "2026-03-02" })).json();
    const moved = (await t.api.patch(`/jobs/${jb.jobId}`, { scheduledDate: "2026-03-03" })).json();
    expect(moved).toMatchObject({ scheduledDate: "2026-03-03", routePosition: 2 });
    expect((await t.techApi.get("/route?date=2026-03-02")).json().items).toHaveLength(0);
    expect((await t.techApi.get("/route?date=2026-03-03")).json().items.map((s: { jobId: string }) => s.jobId).at(-1)).toBe(jb.jobId);
  });

  it("reorders a technician's day", async () => {
    const t = await setup(ctx);
    const ids: string[] = [];
    for (const o of t.contract.obligations) {
      ids.push((await t.api.post("/jobs", { obligationId: o.id, technicianId: t.tech.id, scheduledDate: "2026-03-02" })).json().jobId);
    }
    const reversed = [...ids].reverse();
    const res = await t.api.post("/schedule/reorder", { technicianId: t.tech.id, scheduledDate: "2026-03-02", jobIds: reversed });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((s: { jobId: string }) => s.jobId)).toEqual(reversed);
    expect((await t.techApi.get("/route?date=2026-03-02")).json().items.map((s: { jobId: string }) => s.jobId)).toEqual(reversed);
    // Partial or duplicated lists are rejected.
    const bad = await t.api.post("/schedule/reorder", { technicianId: t.tech.id, scheduledDate: "2026-03-02", jobIds: [ids[0], ids[0], ids[1]] });
    expect(bad.statusCode).toBe(422);
  });

  it("puts a cancelled job's visit back into unscheduled work", async () => {
    const t = await setup(ctx);
    const job = (await t.api.post("/jobs", { obligationId: t.visit.id, technicianId: t.tech.id, scheduledDate: "2026-03-02" })).json();
    expect((await t.api.post(`/jobs/${job.jobId}/cancel`, { reason: "Customer asked to move it" })).statusCode).toBe(204);
    expect((await t.api.get("/obligations/due?unscheduledOnly=true")).json().items).toHaveLength(1);
    expect((await t.api.post(`/jobs/${job.jobId}/cancel`, { reason: "again" })).statusCode).toBe(409);
    expect((await t.api.post("/jobs", { obligationId: t.visit.id, technicianId: t.tech.id, scheduledDate: "2026-03-04" })).statusCode).toBe(201);
  });

  it("shows the office a date range of jobs across technicians", async () => {
    const t = await setup(ctx);
    await t.api.post("/jobs", { obligationId: t.contract.obligations[0].id, technicianId: t.tech.id, scheduledDate: "2026-03-02" });
    await t.api.post("/jobs", { obligationId: t.contract.obligations[1].id, technicianId: t.owner.id, scheduledDate: "2026-03-05" });
    const week = (await t.api.get("/schedule?from=2026-03-02&to=2026-03-08")).json();
    expect(week.items.map((s: { scheduledDate: string }) => s.scheduledDate)).toEqual(["2026-03-02", "2026-03-05"]);
    expect((await t.api.get(`/schedule?from=2026-03-02&to=2026-03-08&technicianId=${t.tech.id}`)).json().items).toHaveLength(1);
    expect((await t.api.get("/schedule?from=2026-03-08&to=2026-03-02")).statusCode).toBe(400);
  });
});

describe("scheduling permissions and tenancy", () => {
  it("lets technicians read their route but not change the schedule", async () => {
    const t = await setup(ctx);
    const job = (await t.api.post("/jobs", { obligationId: t.visit.id, technicianId: t.tech.id, scheduledDate: "2026-03-02" })).json();
    expect((await t.techApi.post("/jobs", { obligationId: t.contract.obligations[1].id, technicianId: t.tech.id, scheduledDate: "2026-03-02" })).statusCode).toBe(403);
    expect((await t.techApi.patch(`/jobs/${job.jobId}`, { scheduledDate: "2026-03-09" })).statusCode).toBe(403);
    expect((await t.techApi.post(`/jobs/${job.jobId}/cancel`, { reason: "x" })).statusCode).toBe(403);
    expect((await t.techApi.post("/schedule/reorder", { technicianId: t.tech.id, scheduledDate: "2026-03-02", jobIds: [job.jobId] })).statusCode).toBe(403);
  });

  it("shows each technician only their own route", async () => {
    const t = await setup(ctx);
    await t.api.post("/jobs", { obligationId: t.visit.id, technicianId: t.owner.id, scheduledDate: "2026-03-02" });
    expect((await t.techApi.get("/route?date=2026-03-02")).json().items).toHaveLength(0);
  });

  it("keeps jobs, technicians and visits inside their organization", async () => {
    const a = await setup(ctx, "Org A");
    const b = await setup(ctx, "Org B");
    const bJob = (await b.api.post("/jobs", { obligationId: b.visit.id, technicianId: b.tech.id, scheduledDate: "2026-03-02" })).json();

    // A cannot schedule B's visit, or assign B's technician to its own visit.
    expect((await a.api.post("/jobs", { obligationId: b.visit.id, technicianId: a.tech.id, scheduledDate: "2026-03-02" })).statusCode).toBe(422);
    expect((await a.api.post("/jobs", { obligationId: a.visit.id, technicianId: b.tech.id, scheduledDate: "2026-03-02" })).statusCode).toBe(422);
    expect((await a.api.patch(`/jobs/${bJob.jobId}`, { scheduledDate: "2026-03-09" })).statusCode).toBe(404);
    expect((await a.api.post(`/jobs/${bJob.jobId}/cancel`, { reason: "x" })).statusCode).toBe(404);
    expect((await a.api.post("/schedule/reorder", { technicianId: b.tech.id, scheduledDate: "2026-03-02", jobIds: [bJob.jobId] })).statusCode).toBe(422);
    expect((await a.api.get("/schedule?from=2026-03-01&to=2026-03-31")).json().items).toHaveLength(0);
    expect((await a.api.get("/technicians")).json().items.map((x: { id: string }) => x.id)).not.toContain(b.tech.id);
    expect((await b.techApi.get("/route?date=2026-03-02")).json().items).toHaveLength(1);
  });
});
