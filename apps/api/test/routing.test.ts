import { TestGeocoder } from "@aerowise/routing";
import { drainTasks } from "@aerowise/tasks";
import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";

const ctx = setupTestApp();
const geocoder = new TestGeocoder();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, geocoder });

// Sites on a north-south line, about 7 road miles apart (0.1 degree of latitude × 1.3).
const north = (i: number) => ({ lat: 30 + i / 10, lng: -97.7 });

/** A tenant whose yard is at the south end, with a technician and one due visit per site. Today is 2026-03-01. */
async function setup(c: TestContext, name = "Org A") {
  const t = await createTenant(c, name);
  const plan = (await t.api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
  const tech = await createUser(c.db, t.org.id, "technician");
  const techApi = client(c.app, await login(c.app, tech.email));
  await t.api.patch("/routing/settings", { start: { addressLine1: "100 Yard Rd", city: "Austin", ...north(0) }, stopMinutes: 30, speedMph: 30 });
  const addSite = async (label: string, at: { lat: number; lng: number } | null) => {
    const site = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: `${label} Ranch Rd`, city: "Austin", ...(at ?? {}) })).json();
    const contract = (await t.api.post(`/sites/${site.id}/contracts`, { planId: plan.id, startOn: "2025-12-01" })).json();
    return { site, visit: contract.obligations[0] };
  };
  const schedule = async (visitId: string, day = "2026-03-02") =>
    (await t.api.post("/jobs", { obligationId: visitId, technicianId: tech.id, scheduledDate: day })).json();
  return { ...t, plan, tech, techApi, addSite, schedule };
}

describe("finding sites on the map", () => {
  it("looks up new sites in the background and keeps typed coordinates", async () => {
    const t = await createTenant(ctx, "Org A");
    expect(t.site).toMatchObject({ lat: null, lng: null, locationSource: null, geocodeStatus: null });
    const typed = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "2 Oak", city: "Austin", lat: 30.1, lng: -97.6 })).json();
    expect(typed).toMatchObject({ lat: 30.1, lng: -97.6, locationSource: "manual" });

    expect((await t.api.get("/routing/settings")).json().sites).toEqual({ located: 1, pending: 1, notFound: 0 });
    await runWorker(ctx);
    const found = (await t.api.get(`/sites/${t.site.id}`)).json();
    expect(found).toMatchObject({ locationSource: "geocoder", geocodeStatus: null });
    expect(found.lat).toBeCloseTo((await geocoder.geocode({ addressLine1: "1 Main St", city: "Austin", state: "TX" }))!.lat, 5);
    expect((await t.api.get(`/sites/${typed.id}`)).json()).toMatchObject({ lat: 30.1, lng: -97.6 });
  });

  it("finds a site again when its address changes, unless a person placed it", async () => {
    const t = await createTenant(ctx, "Org A");
    await runWorker(ctx);
    const before = (await t.api.get(`/sites/${t.site.id}`)).json();
    const moved = (await t.api.patch(`/sites/${t.site.id}`, { addressLine1: "77 Elsewhere Ln", city: "Bastrop" })).json();
    expect(moved).toMatchObject({ lat: null, locationSource: null });
    await runWorker(ctx);
    const after = (await t.api.get(`/sites/${t.site.id}`)).json();
    expect(after.locationSource).toBe("geocoder");
    expect(after.lat).not.toBe(before.lat);

    // Placed by hand: an address correction keeps the pin.
    await t.api.patch(`/sites/${t.site.id}`, { lat: 30.5, lng: -97.5 });
    const kept = (await t.api.patch(`/sites/${t.site.id}`, { addressLine1: "77 Elsewhere Lane" })).json();
    expect(kept).toMatchObject({ lat: 30.5, lng: -97.5, locationSource: "manual" });

    // Clearing the pin hands the site back to the geocoder.
    expect((await t.api.patch(`/sites/${t.site.id}`, { lat: null, lng: null })).json()).toMatchObject({ lat: null, locationSource: null });
    await runWorker(ctx);
    expect((await t.api.get(`/sites/${t.site.id}`)).json().locationSource).toBe("geocoder");

    expect((await t.api.patch(`/sites/${t.site.id}`, { lat: 30.5 })).statusCode).toBe(422);
  });

  it("marks an address that cannot be found, and tries again when asked or when it changes", async () => {
    const t = await createTenant(ctx, "Org A");
    await t.api.patch(`/sites/${t.site.id}`, { postalCode: "00000" });
    await runWorker(ctx);
    expect((await t.api.get(`/sites/${t.site.id}`)).json()).toMatchObject({ lat: null, geocodeStatus: "not_found" });
    expect((await t.api.get("/routing/settings")).json().sites).toEqual({ located: 0, pending: 0, notFound: 1 });

    const retry = await t.api.post("/routing/locate-sites", { retryNotFound: true });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual({ pending: 1 });
    await runWorker(ctx);
    expect((await t.api.get(`/sites/${t.site.id}`)).json().geocodeStatus).toBe("not_found");

    await t.api.patch(`/sites/${t.site.id}`, { postalCode: "78701" });
    await runWorker(ctx);
    expect((await t.api.get(`/sites/${t.site.id}`)).json()).toMatchObject({ geocodeStatus: null, locationSource: "geocoder" });
  });

  it("finds imported sites", async () => {
    const t = await createTenant(ctx, "Org A");
    const csv = "Customer,Address,City,ZIP\nAnn Lee,5 Pecan St,Bastrop,78602\nBo Diaz,9 Elm St,Elgin,78621\n";
    const up = await t.api.post("/imports", { filename: "c.csv", contentBase64: Buffer.from(csv).toString("base64") });
    expect(up.statusCode).toBe(201);
    expect((await t.api.post(`/imports/${up.json().id}/commit`, {})).statusCode).toBe(200);
    await runWorker(ctx);
    const sites = (await t.api.get("/sites?search=St")).json().items;
    expect(sites.filter((s: { city: string }) => s.city !== "Austin").every((s: { locationSource: string }) => s.locationSource === "geocoder")).toBe(true);
  });
});

describe("routing settings", () => {
  it("finds the start address, or takes coordinates", async () => {
    const t = await createTenant(ctx, "Org A");
    const s = (await t.api.patch("/routing/settings", { start: { addressLine1: "100 Yard Rd", city: "Bastrop", postalCode: "78602" } })).json();
    expect(s).toMatchObject({ geocoder: "test", returnToStart: true, stopMinutes: 30, dayMinutes: 480, speedMph: 35 });
    expect(s.start.address).toBe("100 Yard Rd, Bastrop, TX 78602");
    expect(typeof s.start.lat).toBe("number");

    const notFound = await t.api.patch("/routing/settings", { start: { addressLine1: "1 Nowhere", city: "Bastrop", postalCode: "00000" } });
    expect(notFound.statusCode).toBe(422);
    const typed = (await t.api.patch("/routing/settings", { start: { addressLine1: "1 Nowhere", city: "Bastrop", lat: 30, lng: -97 }, dayMinutes: 600 })).json();
    expect(typed).toMatchObject({ start: { lat: 30, lng: -97 }, dayMinutes: 600 });
    expect((await t.api.patch("/routing/settings", { start: null })).json().start).toBeNull();
  });

  it("is changed only by the owner", async () => {
    const t = await createTenant(ctx, "Org A");
    const office = await createUser(ctx.db, t.org.id, "office");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    expect((await officeApi.get("/routing/settings")).statusCode).toBe(200);
    expect((await officeApi.patch("/routing/settings", { speedMph: 50 })).statusCode).toBe(403);
  });
});

describe("a day's routes", () => {
  it("estimates driving, time on site and whether the day fits", async () => {
    const t = await setup(ctx);
    const a = await t.addSite("A", north(1));
    const b = await t.addSite("B", north(2));
    const x = await t.addSite("X", null);
    for (const s of [a, b, x]) await t.schedule(s.visit.id);

    const day = (await t.api.get("/routing/day?date=2026-03-02")).json();
    expect(day.start).toMatchObject(north(0));
    expect(day.technicians).toHaveLength(1);
    const r = day.technicians[0];
    expect(r.technicianId).toBe(t.tech.id);
    expect(r.legs).toHaveLength(3); // yard → A → B → yard; X has no location yet
    expect(r.driveMiles).toBeCloseTo(36, 0);
    expect(r.driveMinutes).toBeGreaterThanOrEqual(70);
    expect(r.serviceMinutes).toBe(90);
    expect(r.totalMinutes).toBe(r.driveMinutes + 90);
    expect(r.overCapacity).toBe(false);
    expect(r.unlocatedJobIds).toHaveLength(1);

    await t.api.patch("/routing/settings", { dayMinutes: 120 });
    expect((await t.api.get("/routing/day?date=2026-03-02")).json().technicians[0].overCapacity).toBe(true);
    expect((await t.api.get("/routing/day?date=2026-03-03")).json().technicians).toEqual([]);
  });
});

describe("optimizing a route", () => {
  it("shows a shorter order, then puts it in place", async () => {
    const t = await setup(ctx);
    const sites = await Promise.all([3, 1, 4, 2].map((i) => t.addSite(`S${i}`, north(i))));
    const jobs = [];
    for (const s of sites) jobs.push(await t.schedule(s.visit.id));
    const [j3, j1, j4, j2] = jobs.map((j) => j.jobId);

    const preview = await t.api.post("/routing/optimize", { technicianId: t.tech.id, scheduledDate: "2026-03-02" });
    expect(preview.statusCode).toBe(200);
    const p = preview.json();
    expect(p).toMatchObject({ applied: false, changed: true, currentJobIds: [j3, j1, j4, j2], proposedJobIds: [j1, j2, j3, j4] });
    expect(p.after.driveMiles).toBeLessThan(p.before.driveMiles);
    // Nothing moved yet.
    expect((await t.techApi.get("/route?date=2026-03-02")).json().items.map((s: { jobId: string }) => s.jobId)).toEqual([j3, j1, j4, j2]);

    const applied = (await t.api.post("/routing/optimize", { technicianId: t.tech.id, scheduledDate: "2026-03-02", apply: true })).json();
    expect(applied).toMatchObject({ applied: true, proposedJobIds: [j1, j2, j3, j4] });
    const route = (await t.techApi.get("/route?date=2026-03-02")).json().items;
    expect(route.map((s: { jobId: string }) => s.jobId)).toEqual([j1, j2, j3, j4]);
    expect(route.map((s: { routePosition: number }) => s.routePosition)).toEqual([1, 2, 3, 4]);

    const audit = await ctx.db.selectFrom("auditEvents").select("action").where("organizationId", "=", t.org.id).where("action", "=", "route.optimized").execute();
    expect(audit).toHaveLength(1);

    // Already the best order: nothing changes and nothing is written.
    const again = (await t.api.post("/routing/optimize", { technicianId: t.tech.id, scheduledDate: "2026-03-02", apply: true })).json();
    expect(again).toMatchObject({ applied: false, changed: false });
  });

  it("keeps started stops first and unlocated stops last", async () => {
    const t = await setup(ctx);
    const far = await t.addSite("Far", north(4));
    const near = await t.addSite("Near", north(1));
    const lost = await t.addSite("Lost", null);
    const mid = await t.addSite("Mid", north(2));
    const jFar = (await t.schedule(far.visit.id)).jobId;
    const jLost = (await t.schedule(lost.visit.id)).jobId;
    const jNear = (await t.schedule(near.visit.id)).jobId;
    const jMid = (await t.schedule(mid.visit.id)).jobId;
    // The technician has already started at the far site.
    await ctx.db.updateTable("jobs").set({ status: "in_progress" }).where("id", "=", jFar).execute();

    const r = (await t.api.post("/routing/optimize", { technicianId: t.tech.id, scheduledDate: "2026-03-02" })).json();
    expect(r.proposedJobIds).toEqual([jFar, jMid, jNear, jLost]);
    expect(r.unlocatedJobIds).toEqual([jLost]);
  });

  it("is limited to the organization and to people who schedule", async () => {
    const t = await setup(ctx);
    const other = await setup(ctx, "Org B");
    const s = await t.addSite("A", north(1));
    await t.schedule(s.visit.id);
    // Another organization's technician has no stops here.
    const r = (await other.api.post("/routing/optimize", { technicianId: t.tech.id, scheduledDate: "2026-03-02", apply: true })).json();
    expect(r).toMatchObject({ applied: false, currentJobIds: [] });
    expect((await other.api.get("/routing/day?date=2026-03-02")).json().technicians).toEqual([]);
    expect((await t.techApi.post("/routing/optimize", { technicianId: t.tech.id, scheduledDate: "2026-03-02" })).statusCode).toBe(403);
  });
});

describe("visits near a route", () => {
  it("ranks unscheduled visits by the driving they add", async () => {
    const t = await setup(ctx);
    const on = await t.addSite("On", north(3));
    await t.schedule(on.visit.id);
    const close = await t.addSite("Close", north(2));
    const off = await t.addSite("Off", { lat: 30.2, lng: -97.3 });
    const lost = await t.addSite("Lost", null);
    void lost;

    const r = (await t.api.get(`/routing/nearby?technicianId=${t.tech.id}&date=2026-03-02`)).json();
    const ids = r.items.map((i: { obligationId: string }) => i.obligationId);
    expect(ids.indexOf(close.visit.id)).toBeLessThan(ids.indexOf(off.visit.id));
    const c = r.items.find((i: { obligationId: string }) => i.obligationId === close.visit.id);
    expect(c).toMatchObject({ detourMiles: 0, detourMinutes: 0, fits: true });
    expect(r.items.find((i: { obligationId: string }) => i.obligationId === off.visit.id).detourMiles).toBeGreaterThan(20);
    // The scheduled visit is not offered; the tenant's first site and "Lost" have no location.
    expect(ids).not.toContain(on.visit.id);
    expect(r.unlocated).toBe(1);
  });
});
