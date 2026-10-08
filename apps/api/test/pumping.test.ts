import { toMilligallons } from "@aerowise/domain";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { emptyEndedDemo } from "../src/lib/demo-lifecycle.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { JPEG } from "./inspection-helpers.ts";

// SW-6: pump-outs recorded with their visit, disposal loads with manifest photos, corrections by
// revision, and the overdue item (service workflows plan §2.5).

const ctx = setupTestApp({ features: ["work_orders", "service_items", "field_work", "pumping"] });

type Api = ReturnType<typeof client>;
const uuid = () => crypto.randomUUID();
const VALUES = { tank_count: 1, lid_condition: "good" };

const count = async (table: string, organizationId: string) =>
  Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(table)} where organization_id = ${organizationId}`.execute(ctx.db)).rows[0]!.n);

/** A demo company, made demo from the start as every demo company is. */
async function createDemoTenant(c: TestContext, name: string) {
  const org = await c.db.insertInto("organizations").values({ name, demo: true } as never).returning("id").executeTakeFirstOrThrow();
  const owner = await createUser(c.db, org.id, "owner");
  const cookie = await login(c.app, owner.email);
  const api = client(c.app, cookie);
  const customer = (await api.post("/customers", { displayName: `${name} customer` })).json();
  const site = (await api.post(`/customers/${customer.id}/sites`, { addressLine1: "1 Main St", city: "Austin" })).json();
  return { org, owner, cookie, api, customer, site };
}

/** A company with a truck, a facility and technicians A and B. */
async function company(c: TestContext, name = "Org A", demo = false) {
  const t = demo ? await createDemoTenant(c, name) : await createTenant(c, name);
  const a = await createUser(c.db, t.org.id, "technician");
  const b = await createUser(c.db, t.org.id, "technician");
  const aApi = client(c.app, await login(c.app, a.email));
  const bApi = client(c.app, await login(c.app, b.email));
  const truck = (await t.api.post("/vehicles", { name: "Truck 1", plate: "ABC-123", capacityGallons: 3000 })).json();
  const truck2 = (await t.api.post("/vehicles", { name: "Truck 2" })).json();
  const facility = (await t.api.post("/disposal-facilities", { name: "Example Water Reclamation", kind: "wastewater_treatment_plant", city: "Austin" })).json();
  const pumping = ((await t.api.get("/work-types")).json().items as { id: string; key: string }[]).find((x) => x.key === "pumping")!;
  const form = (await aApi.get("/form-templates/work-pumping")).json();
  return { ...t, a, b, aApi, bApi, truck, truck2, facility, pumping, form };
}
type Company = Awaited<ReturnType<typeof company>>;

/** A pumping work order scheduled for `tech`, and the phone's record for its visit. */
async function pumpingVisit(s: Company, tech: { id: string } = s.a, pumpOut: Record<string, unknown> | null = {}) {
  const wo = (await s.api.post("/work-orders", { siteId: s.site.id, workTypeId: s.pumping.id })).json();
  const scheduled = await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: tech.id, scheduledDate: "2026-03-01" });
  expect(scheduled.statusCode, scheduled.body).toBe(201);
  const jobId = scheduled.json().visits[0].jobId as string;
  const clientId = uuid();
  const pumpOutId = uuid();
  const body = (status: "draft" | "completed", revision = 1) => ({
    clientId,
    jobId,
    templateId: s.form.id,
    status,
    revision,
    arrivedAt: "2026-03-01T15:00:00Z",
    completedAt: status === "completed" ? "2026-03-01T16:00:00Z" : null,
    values: VALUES,
    pumpOut: pumpOut === null ? null : { clientId: pumpOutId, volume: 1000, unit: "gallons", wasteType: "septage", tanks: [{ label: "Tank 1", volume: 1000 }], vehicleId: s.truck.id, ...pumpOut },
  });
  return { wo, jobId, clientId, pumpOutId, sync: (api: Api, status: "draft" | "completed" = "draft", revision?: number) => api.put("/work/sync", body(status, revision)) };
}

/** Pumps a visit to completion on A's phone and returns its pump-out group. */
async function pumped(s: Company, pumpOut: Record<string, unknown> = {}, tech: { id: string } = s.a, api: Api = s.aApi) {
  const v = await pumpingVisit(s, tech, pumpOut);
  expect((await v.sync(api, "draft")).statusCode).toBe(200);
  const done = await v.sync(api, "completed", 2);
  expect(done.json(), done.body).toMatchObject({ status: "completed" });
  const [p] = (await s.api.get(`/pumping-records?workOrderId=${v.wo.id}`)).json().items;
  return { ...v, groupId: p.groupId as string };
}

const load = (s: Company, groupIds: string[], extra: Record<string, unknown> = {}) => ({
  clientId: uuid(),
  vehicleId: s.truck.id,
  facilityId: s.facility.id,
  deliveredOn: "2026-03-01",
  manifestReference: "M-1001",
  total: 1000,
  unit: "gallons",
  pumpingGroupIds: groupIds,
  ...extra,
});

describe("a pump-out recorded with its visit", () => {
  it("is recorded once when the record completes, and every replay changes nothing", async () => {
    const s = await company(ctx);
    const route = (await s.aApi.get("/work/route?date=2026-03-01")).json();
    const v = await pumpingVisit(s);
    expect((await s.aApi.get("/work/route?date=2026-03-01")).json().items).toEqual([expect.objectContaining({ jobId: v.jobId, requiresDisposalRecord: true, templateId: s.form.id })]);
    expect(route.items).toEqual([]);
    expect((await v.sync(s.aApi, "draft")).statusCode).toBe(200);
    // A draft carries the pump-out but records nothing until the visit is done.
    expect(await count("pumping_records", s.org.id)).toBe(0);
    expect((await v.sync(s.aApi, "completed", 2)).json()).toMatchObject({ status: "completed", validationStatus: "valid" });
    for (let i = 0; i < 2; i++) expect((await v.sync(s.aApi, "completed", 2)).statusCode).toBe(200);
    expect(await count("pumping_records", s.org.id)).toBe(1);
    const [p] = (await s.api.get(`/sites/${s.site.id}`).then(() => s.api.get(`/pumping-records?siteId=${s.site.id}`))).json().items;
    expect(p).toMatchObject({
      revision: 1,
      workOrderId: v.wo.id,
      jobId: v.jobId,
      technicianId: s.a.id,
      vehicleName: "Truck 1",
      serviceDate: "2026-03-01",
      enteredVolume: 1000,
      enteredUnit: "gallons",
      volumeMilligallons: 1_000_000,
      tanks: [{ label: "Tank 1", volume: 1000 }],
      loadGroupId: null,
    });
    // A pumping job never touches aerobic obligations, inspections or filings.
    expect([await count("service_obligations", s.org.id), await count("inspections", s.org.id), await count("filings", s.org.id)]).toEqual([0, 0, 0]);
  });

  it("keeps a pumping visit a draft until its pump-out is there, and refuses another company's truck", async () => {
    const s = await company(ctx);
    const v = await pumpingVisit(s, s.a, null);
    await v.sync(s.aApi, "draft");
    const res = await v.sync(s.aApi, "completed", 2);
    expect(res.json()).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.json().validationProblems).toEqual([expect.objectContaining({ key: "pump_out", message: "Pump-out volume is required" })]);
    expect(await count("pumping_records", s.org.id)).toBe(0);

    const other = await company(ctx, "Org B");
    const w = await pumpingVisit(s, s.a, { vehicleId: other.truck.id });
    await w.sync(s.aApi, "draft");
    const bad = await w.sync(s.aApi, "completed", 2);
    expect(bad.json()).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(bad.json().validationProblems).toEqual([expect.objectContaining({ key: "pump_out", problem: "invalid" })]);
    expect(await count("pumping_records", s.org.id)).toBe(0);
  });

  it("held when the visit changed: recorded once when the office accepts it, never from the hold itself", async () => {
    const s = await company(ctx);
    const v = await pumpingVisit(s);
    expect((await s.api.post(`/jobs/${v.jobId}/cancel`, { reason: "Wrong day" })).statusCode).toBe(204);
    expect((await v.sync(s.aApi, "completed", 2)).statusCode).toBe(202);
    expect((await v.sync(s.aApi, "completed", 2)).statusCode).toBe(202);
    expect(await count("pumping_records", s.org.id)).toBe(0);
    const [c] = (await s.api.get("/work/conflicts?status=held")).json().items;
    const attached = await s.api.post(`/work/conflicts/${c.id}/attach`, {});
    expect(attached.statusCode, attached.body).toBe(200);
    expect((await v.sync(s.aApi, "completed", 3)).json()).toMatchObject({ outcome: "resolved", resolution: "attached" });
    expect(await count("pumping_records", s.org.id)).toBe(1);
    const [p] = (await s.api.get(`/pumping-records?workOrderId=${v.wo.id}`)).json().items;
    // Credited to the technician who pumped it, on the visit the office attached it to.
    expect(p).toMatchObject({ technicianId: s.a.id, jobId: attached.json().attachedJobId, volumeMilligallons: 1_000_000 });
  });

  it("refuses an office attach of a held pumping record with no pump-out, keeping it held", async () => {
    const s = await company(ctx);
    const v = await pumpingVisit(s, s.a, null);
    await s.api.patch(`/jobs/${v.jobId}`, { technicianId: s.b.id });
    expect((await v.sync(s.aApi, "completed")).statusCode).toBe(202);
    const [c] = (await s.api.get("/work/conflicts?status=held")).json().items;
    const refused = await s.api.post(`/work/conflicts/${c.id}/attach`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/Pump-out volume is required/);
    expect((await s.api.get(`/work/conflicts/${c.id}`)).json().status).toBe("held");
  });
});

describe("disposal loads", () => {
  it("records a load with its manifest photo exactly once, from the phone, in any retry order", async () => {
    const s = await company(ctx);
    const p = await pumped(s);
    const field = (await s.aApi.get("/pumping/field")).json();
    expect(field.unloaded.map((x: { groupId: string }) => x.groupId)).toEqual([p.groupId]);
    expect(field.vehicles.map((x: { name: string }) => x.name)).toEqual(["Truck 1", "Truck 2"]);
    const body = load(s, [p.groupId]);
    const photoId = uuid();
    const photo = () => s.aApi.putImage(`/disposal/loads/${body.clientId}/photos/${photoId}`, JPEG, { "x-photo-key": "manifest" });
    // A photo that overtakes its load waits for it.
    const early = await photo();
    expect([early.statusCode, early.json().error]).toEqual([409, "record_not_synced"]);
    const first = await s.aApi.put("/disposal/loads/sync", body);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ revision: 1, manifestReference: "M-1001", totalMilligallons: 1_000_000, itemsMilligallons: 1_000_000, volumesDiffer: false, items: [{ groupId: p.groupId }] });
    expect((await photo()).statusCode).toBe(201);
    // Every op again, as a phone that lost the answers.
    expect((await s.aApi.put("/disposal/loads/sync", body)).statusCode).toBe(200);
    expect((await photo()).statusCode).toBe(200);
    expect([await count("disposal_loads", s.org.id), await count("disposal_load_items", s.org.id), await count("work_attachments", s.org.id)]).toEqual([1, 1, 1]);
    const [l] = (await s.api.get("/disposal/loads")).json().items;
    expect(l.photos).toHaveLength(1);
    const file = await ctx.app.inject({ method: "GET", url: l.photos[0].url });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(JPEG)).toBe(true);
    const row = await ctx.db.selectFrom("workAttachments").select(["storageKey", "recordClientId", "disposalLoadGroupId", "photoKey"]).executeTakeFirstOrThrow();
    expect(row).toEqual({ storageKey: `${s.org.id}/work/loads/${l.groupId}/${photoId}.jpg`, recordClientId: null, disposalLoadGroupId: l.groupId, photoKey: "manifest" });
    expect((await s.aApi.get("/pumping/field")).json().unloaded).toEqual([]);
  });

  it("refuses a pump-out in a second load, on another truck, or someone else's on the phone; the office may load anyone's", async () => {
    const s = await company(ctx);
    const p = await pumped(s);
    const theirs = await pumped(s, { clientId: uuid() }, s.b, s.bApi);
    expect((await s.aApi.put("/disposal/loads/sync", load(s, [p.groupId]))).statusCode).toBe(201);
    const again = await s.aApi.put("/disposal/loads/sync", load(s, [p.groupId]));
    expect([again.statusCode, again.json().error]).toEqual([409, "already_in_load"]);
    const notMine = await s.aApi.put("/disposal/loads/sync", load(s, [theirs.groupId]));
    expect([notMine.statusCode, notMine.json().error]).toEqual([403, "not_assigned"]);
    const otherTruck = await s.bApi.put("/disposal/loads/sync", load(s, [theirs.groupId], { vehicleId: s.truck2.id }));
    expect([otherTruck.statusCode, otherTruck.json().error]).toEqual([409, "vehicle_mismatch"]);
    expect(await count("disposal_loads", s.org.id)).toBe(1);
    expect((await s.api.put("/disposal/loads/sync", load(s, [theirs.groupId]))).statusCode).toBe(201);
    // The database refuses a second membership even when the routes are bypassed.
    const [l] = (await s.api.get("/disposal/loads")).json().items;
    await expect(sql`insert into disposal_load_items (organization_id, load_group_id, pumping_group_id, added_by) values (${s.org.id}, ${l.groupId}, ${p.groupId}, ${s.owner.id})`.execute(ctx.db)).rejects.toMatchObject({ code: "23505" });
  });

  it("two loads claiming the same pump-out at once: exactly one wins", async () => {
    const s = await company(ctx);
    const p = await pumped(s);
    const [x, y] = await Promise.all([s.aApi.put("/disposal/loads/sync", load(s, [p.groupId])), s.api.put("/disposal/loads/sync", load(s, [p.groupId]))]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([201, 409]);
    expect([await count("disposal_loads", s.org.id), await count("disposal_load_items", s.org.id)]).toEqual([1, 1]);
  });

  it("adds liters and gallons exactly on the canonical volume and shows both as entered", async () => {
    const s = await company(ctx);
    const g = await pumped(s, { volume: 500, unit: "gallons" });
    const l = await pumped(s, { volume: 1000, unit: "liters" });
    const total = 500_000 + toMilligallons(1000, "liters");
    expect(toMilligallons(1000, "liters")).toBe(264_172);
    const res = await s.aApi.put("/disposal/loads/sync", load(s, [g.groupId, l.groupId], { total: 764.2, unit: "gallons" }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ itemsMilligallons: total, totalMilligallons: 764_200, volumesDiffer: true });
    const items = res.json().items.map((i: { enteredVolume: number; enteredUnit: string; volumeMilligallons: number }) => [i.enteredVolume, i.enteredUnit, i.volumeMilligallons]);
    expect(items.sort()).toEqual([
      [1000, "liters", 264_172],
      [500, "gallons", 500_000],
    ]);
    // The database computes the same canonical value, and refuses one that disagrees.
    await expect(
      sql`insert into pumping_records (id, organization_id, group_id, revision, work_order_id, job_id, work_record_id, site_id, technician_user_id, service_date, waste_type, entered_volume, entered_unit, volume_milligallons, recorded_by)
          select gen_random_uuid(), organization_id, group_id, 99, work_order_id, job_id, work_record_id, site_id, technician_user_id, service_date, waste_type, 1000, 'liters', 264173, recorded_by from pumping_records where group_id = ${l.groupId}`.execute(ctx.db),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("corrections by revision", () => {
  it("a pump-out corrected after its load: the load counts only the new volume and the item keeps its group", async () => {
    const s = await company(ctx);
    const p = await pumped(s);
    const l = (await s.aApi.put("/disposal/loads/sync", load(s, [p.groupId]))).json();
    const fix = await s.api.post(`/pumping-records/${p.groupId}/correct`, { volume: 900, unit: "gallons", wasteType: "septage", vehicleId: s.truck.id, serviceDate: "2026-03-01", reason: "Gauge misread" });
    expect(fix.statusCode, fix.body).toBe(200);
    expect(fix.json()).toMatchObject({ groupId: p.groupId, revision: 2, volumeMilligallons: 900_000, correctionReason: "Gauge misread", loadGroupId: l.groupId });
    expect(fix.json().revisions.map((r: { revision: number; current: boolean }) => [r.revision, r.current])).toEqual([
      [1, false],
      [2, true],
    ]);
    const after = (await s.api.get(`/disposal/loads/${l.groupId}`)).json();
    expect(after).toMatchObject({ itemsMilligallons: 900_000, totalMilligallons: 1_000_000, volumesDiffer: true, items: [{ groupId: p.groupId, revision: 2 }] });
    // Old and corrected volumes are never both counted, nor both eligible for a load.
    expect((await s.api.get(`/pumping-records?siteId=${s.site.id}`)).json().items).toHaveLength(1);
    const twice = await s.api.put("/disposal/loads/sync", load(s, [p.groupId]));
    expect([twice.statusCode, twice.json().error]).toEqual([409, "already_in_load"]);
    // Rows are immutable: only a correction clears is_current, and nothing deletes them.
    await expect(sql`update pumping_records set entered_volume = 1 where group_id = ${p.groupId}`.execute(ctx.db)).rejects.toThrow(/immutable/);
    await expect(sql`delete from pumping_records where group_id = ${p.groupId}`.execute(ctx.db)).rejects.toThrow(/never deleted/);
    // A load item can only name a group, never a later revision's own id.
    const rev2 = await ctx.db.selectFrom("pumpingRecords").select("id").where("groupId", "=", p.groupId).where("revision", "=", 2).executeTakeFirstOrThrow();
    await expect(sql`update disposal_load_items set pumping_group_id = ${rev2.id} where pumping_group_id = ${p.groupId}`.execute(ctx.db)).rejects.toMatchObject({ code: "23514" });
  });

  it("a load correction keeps its pump-outs and its manifest photo; membership changes are explicit and audited", async () => {
    const s = await company(ctx);
    const p = await pumped(s);
    const q = await pumped(s, { clientId: uuid() });
    const body = load(s, [p.groupId]);
    const l = (await s.aApi.put("/disposal/loads/sync", body)).json();
    expect((await s.aApi.putImage(`/disposal/loads/${body.clientId}/photos/${uuid()}`, JPEG)).statusCode).toBe(201);
    const key = (await ctx.db.selectFrom("workAttachments").select("storageKey").executeTakeFirstOrThrow()).storageKey;
    const fixed = await s.api.post(`/disposal/loads/${l.groupId}/correct`, { vehicleId: s.truck.id, facilityId: s.facility.id, deliveredOn: "2026-03-02", manifestReference: "M-1002", total: 2000, unit: "gallons", reason: "Wrong ticket number" });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(fixed.json()).toMatchObject({ groupId: l.groupId, revision: 2, manifestReference: "M-1002", deliveredOn: "2026-03-02", items: [{ groupId: p.groupId }], photos: [expect.anything()] });
    expect((await ctx.db.selectFrom("workAttachments").select("storageKey").executeTakeFirstOrThrow()).storageKey).toBe(key);
    // The phone's replay of its original load returns the group as it now stands.
    expect((await s.aApi.put("/disposal/loads/sync", body)).json()).toMatchObject({ groupId: l.groupId, revision: 2 });

    const added = await s.api.post(`/disposal/loads/${l.groupId}/items`, { pumpingGroupId: q.groupId });
    expect(added.json().items).toHaveLength(2);
    expect(added.json()).toMatchObject({ itemsMilligallons: 2_000_000, volumesDiffer: false });
    const removed = await s.api.post(`/disposal/loads/${l.groupId}/items/remove`, { pumpingGroupId: q.groupId, reason: "Went on the next load" });
    expect(removed.json().items).toHaveLength(1);
    const actions = (await ctx.db.selectFrom("auditEvents").select(["action", "changes"]).where("entityId", "=", l.groupId).orderBy("occurredAt").execute()).map((e) => e.action);
    expect(actions).toEqual(["disposal_load.recorded", "disposal_load.photo_added", "disposal_load.corrected", "disposal_load.item_added", "disposal_load.item_removed"]);
  });
});

describe("tenancy and roles", () => {
  it("another company sees and changes nothing; a technician cannot correct", async () => {
    const s = await company(ctx);
    const p = await pumped(s);
    const l = (await s.aApi.put("/disposal/loads/sync", load(s, [p.groupId]))).json();
    const other = await company(ctx, "Org B");
    expect((await other.api.get(`/pumping-records/${p.groupId}`)).statusCode).toBe(404);
    expect((await other.api.get(`/disposal/loads/${l.groupId}`)).statusCode).toBe(404);
    expect((await other.api.get("/disposal/loads")).json().items).toEqual([]);
    expect((await other.api.post(`/pumping-records/${p.groupId}/correct`, { volume: 1, unit: "gallons", wasteType: "septage", serviceDate: "2026-03-01", reason: "Not ours" })).statusCode).toBe(404);
    const steal = await other.api.put("/disposal/loads/sync", { ...load(other, [p.groupId]) });
    expect(steal.statusCode).toBe(404);
    // Another company's facility or truck on our load.
    const p2 = await pumped(s, { clientId: uuid() });
    expect((await s.api.put("/disposal/loads/sync", load(s, [p2.groupId], { facilityId: other.facility.id }))).statusCode).toBe(404);
    expect((await s.aApi.post(`/pumping-records/${p.groupId}/correct`, { volume: 1, unit: "gallons", wasteType: "septage", serviceDate: "2026-03-01", reason: "Tech fix" })).statusCode).toBe(403);
    // A photo for another company's load client id is never stored with it.
    const otherTech = client(ctx.app, await login(ctx.app, other.a.email));
    expect((await otherTech.putImage(`/disposal/loads/${l.clientId}/photos/${uuid()}`, JPEG)).statusCode).toBe(409);
    expect(await count("work_attachments", other.org.id)).toBe(0);
  });

  it("every photo has exactly one owner, under its company's folder", async () => {
    const s = await company(ctx);
    const base = sql`(organization_id, offline_client_id, photo_key, storage_key, content_type, byte_size, sha256, uploaded_by)`;
    const values = (key: string) => sql`(${s.org.id}, gen_random_uuid(), 'manifest', ${key}, 'image/jpeg', 1, 'x', ${s.owner.id})`;
    // Neither owner.
    await expect(sql`insert into work_attachments ${base} values ${values(`${s.org.id}/x.jpg`)}`.execute(ctx.db)).rejects.toMatchObject({ code: "23514" });
    const p = await pumped(s);
    const l = (await s.aApi.put("/disposal/loads/sync", load(s, [p.groupId]))).json();
    // Both owners.
    await expect(
      sql`insert into work_attachments (organization_id, offline_client_id, record_client_id, disposal_load_group_id, photo_key, storage_key, content_type, byte_size, sha256, uploaded_by)
          values (${s.org.id}, gen_random_uuid(), gen_random_uuid(), ${l.groupId}, 'manifest', ${`${s.org.id}/x.jpg`}, 'image/jpeg', 1, 'x', ${s.owner.id})`.execute(ctx.db),
    ).rejects.toMatchObject({ code: "23514" });
    // Another company's folder, or another company's load.
    const other = await createTenant(ctx, "Org B");
    await expect(
      sql`insert into work_attachments (organization_id, offline_client_id, disposal_load_group_id, photo_key, storage_key, content_type, byte_size, sha256, uploaded_by)
          values (${s.org.id}, gen_random_uuid(), ${l.groupId}, 'manifest', ${`${other.org.id}/x.jpg`}, 'image/jpeg', 1, 'x', ${s.owner.id})`.execute(ctx.db),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      sql`insert into work_attachments (organization_id, offline_client_id, disposal_load_group_id, photo_key, storage_key, content_type, byte_size, sha256, uploaded_by)
          values (${other.org.id}, gen_random_uuid(), ${l.groupId}, 'manifest', ${`${other.org.id}/x.jpg`}, 'image/jpeg', 1, 'x', ${other.owner.id})`.execute(ctx.db),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("overdue disposal, billing and the log", () => {
  it("raises 'Disposal not recorded' after the company's grace days, and clears it once loaded", async () => {
    const s = await company(ctx);
    const p = await pumped(s);
    const kinds = async () => ((await s.api.get("/inbox")).json().items as { kind: string; key: string }[]).filter((i) => i.kind === "disposal_overdue");
    expect(await kinds()).toEqual([]);
    ctx.now = new Date("2026-03-03T18:00:00Z");
    expect(await kinds()).toEqual([]);
    ctx.now = new Date("2026-03-04T18:00:00Z");
    expect(await kinds()).toEqual([expect.objectContaining({ key: `disposal_overdue:${p.groupId}`, title: "Disposal not recorded" })]);
    await s.aApi.put("/disposal/loads/sync", load(s, [p.groupId]));
    expect(await kinds()).toEqual([]);
  });

  it("bills a per-gallon line at the recorded volume and cites it; refuses before anything is pumped", async () => {
    const s = await company(ctx);
    const v = await pumpingVisit(s, s.a, { volume: 1250.5 });
    const lines = [
      { description: "Pumping", quantity: 1, unitPriceCents: 25, billPumpedVolume: true },
      { description: "Trip charge", quantity: 1, unitPriceCents: 5000 },
    ];
    expect((await s.api.patch(`/work-orders/${v.wo.id}`, { lines })).json().lines[0]).toMatchObject({ billPumpedVolume: true });
    const early = await s.api.post(`/work-orders/${v.wo.id}/invoice`, {});
    expect([early.statusCode, early.json().message]).toEqual([422, "A line bills the pumped volume, but no pump-out is recorded on this work order yet"]);
    await v.sync(s.aApi, "draft");
    await v.sync(s.aApi, "completed", 2);
    const res = await s.api.post(`/work-orders/${v.wo.id}/invoice`, {});
    expect(res.statusCode, res.body).toBe(201);
    const inv = (await s.api.get(`/invoices/${res.json().invoiceId}`)).json();
    expect(inv.lines[0]).toMatchObject({ description: "Pumping (1,250.5 gal pumped on 2026-03-01)", quantity: 1250.5, amountCents: Math.round(1250.5 * 25) });
    expect(inv.lines[1]).toMatchObject({ description: "Trip charge", quantity: 1, amountCents: 5000 });
  });

  it("exports the disposal log as CSV and PDF, with a demo company's rows marked fictional", async () => {
    const s = await company(ctx);
    const p = await pumped(s);
    const body = load(s, [p.groupId]);
    await s.aApi.put("/disposal/loads/sync", body);
    await s.aApi.putImage(`/disposal/loads/${body.clientId}/photos/${uuid()}`, JPEG);
    const csv = await s.api.get("/disposal/log.csv?from=2026-03-01&to=2026-03-31");
    expect(csv.statusCode).toBe(200);
    const rows = csv.body.trim().split("\r\n");
    expect(rows[0]).toMatch(/^delivered_on,facility,vehicle,manifest_reference,/);
    expect(rows[1]).toBe("2026-03-01,Example Water Reclamation,Truck 1,M-1001,1000 gallons,1000.000,2026-03-01,WO-1001,Org A customer,\"1 Main St, Austin\",Septage,1000 gallons,1000.000,false,1");
    expect((await s.api.get("/disposal/log.csv?from=2026-04-01&to=2026-04-30")).body.trim().split("\r\n")).toHaveLength(1);
    const pdf = await s.api.get("/disposal/log.pdf?from=2026-03-01&to=2026-03-31");
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const d = await company(ctx, "Demo Co", true);
    const dp = await pumped(d);
    await d.aApi.put("/disposal/loads/sync", load(d, [dp.groupId]));
    const demo = (await d.api.get("/disposal/log.csv?from=2026-03-01&to=2026-03-31")).body.trim().split("\r\n");
    expect(demo[0]).toMatch(/^aerowise_demo_notice,delivered_on,/);
    expect(demo[1]).toMatch(/^DEMO - FICTIONAL DATA - NOT FILED,2026-03-01,/);
  });
});

describe("what a technician reads", () => {
  it("sees only disposal records made entirely of their own pump-outs; mixed and others' records are office-only", async () => {
    const s = await company(ctx);
    const mine = await pumped(s);
    const theirs = await pumped(s, { clientId: uuid() }, s.b, s.bApi);
    const a = (await s.aApi.put("/disposal/loads/sync", load(s, [mine.groupId]))).json();
    const b2 = await pumped(s, { clientId: uuid() }, s.b, s.bApi);
    // The office loads A's and B's pump-outs together.
    const a2 = await pumped(s, { clientId: uuid() });
    const mixed = (await s.api.put("/disposal/loads/sync", load(s, [a2.groupId, b2.groupId]))).json();
    expect((await s.bApi.get("/disposal/loads")).json().items).toEqual([]);
    expect((await s.bApi.get(`/disposal/loads/${a.groupId}`)).statusCode).toBe(404);
    expect((await s.bApi.get(`/disposal/loads/${mixed.groupId}`)).statusCode).toBe(404);
    expect((await s.aApi.get("/disposal/loads")).json().items.map((l: { groupId: string }) => l.groupId)).toEqual([a.groupId]);
    expect((await s.aApi.get(`/disposal/loads/${mixed.groupId}`)).statusCode).toBe(404);
    expect((await s.bApi.get(`/pumping-records/${mine.groupId}`)).statusCode).toBe(404);
    expect((await s.bApi.get(`/pumping-records?siteId=${s.site.id}`)).json().items.map((p: { groupId: string }) => p.groupId).sort()).toEqual([theirs.groupId, b2.groupId].sort());
    // The disposal log is the office's.
    expect((await s.bApi.get("/disposal/log.csv?from=2026-03-01&to=2026-03-31")).statusCode).toBe(403);
    expect((await s.bApi.get("/disposal/log.pdf?from=2026-03-01&to=2026-03-31")).statusCode).toBe(403);
    expect((await s.api.get("/disposal/loads")).json().items).toHaveLength(2);
  });

  it("a replay or photo upload after the office mixes in another technician's pump-out is acknowledged without the other work", async () => {
    const s = await company(ctx);
    const mine = await pumped(s);
    const body = load(s, [mine.groupId]);
    const photoId = uuid();
    const photo = () => s.aApi.putImage(`/disposal/loads/${body.clientId}/photos/${photoId}`, JPEG, { "x-photo-key": "manifest" });
    const l = (await s.aApi.put("/disposal/loads/sync", body)).json();
    const theirs = await pumped(s, { clientId: uuid(), volume: 750 }, s.b, s.bApi);
    expect((await s.api.post(`/disposal/loads/${l.groupId}/items`, { pumpingGroupId: theirs.groupId })).statusCode).toBe(200);
    // A's phone lost both answers and retries; the load and photo are kept, B's work is not shown.
    const replay = await s.aApi.put("/disposal/loads/sync", body);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({ outcome: "recorded", groupId: l.groupId, clientId: body.clientId });
    const up = await photo();
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json()).toEqual({ outcome: "recorded", groupId: l.groupId, clientId: body.clientId });
    const again = await photo();
    expect([again.statusCode, again.json()]).toEqual([200, { outcome: "recorded", groupId: l.groupId, clientId: body.clientId }]);
    for (const r of [replay, up, again]) expect(r.body).not.toContain(theirs.groupId);
    expect([await count("disposal_loads", s.org.id), await count("work_attachments", s.org.id)]).toEqual([1, 1]);
    // The office still sees everything.
    expect((await s.api.get(`/disposal/loads/${l.groupId}`)).json()).toMatchObject({ items: [expect.anything(), expect.anything()], photos: [expect.anything()] });
  });

  it("lists page explicitly; nothing is silently cut off", async () => {
    const s = await company(ctx);
    const groups = [];
    for (let i = 0; i < 3; i++) {
      const p = await pumped(s, { clientId: uuid() });
      groups.push(p.groupId);
      expect((await s.aApi.put("/disposal/loads/sync", load(s, [p.groupId]))).statusCode).toBe(201);
    }
    const first = (await s.api.get("/disposal/loads?limit=2")).json();
    expect([first.items.length, first.nextOffset]).toEqual([2, 2]);
    const rest = (await s.api.get("/disposal/loads?limit=2&offset=2")).json();
    expect([rest.items.length, rest.nextOffset]).toEqual([1, null]);
    const seen = [...first.items, ...rest.items].map((l: { items: { groupId: string }[] }) => l.items[0]!.groupId).sort();
    expect(seen).toEqual([...groups].sort());
    const pr = (await s.api.get(`/pumping-records?siteId=${s.site.id}&limit=1`)).json();
    expect([pr.items.length, pr.nextOffset]).toEqual([1, 1]);
    expect((await s.api.get(`/pumping-records?siteId=${s.site.id}&limit=1&offset=2`)).json().nextOffset).toBeNull();
    expect((await s.api.get("/disposal/loads?limit=201")).statusCode).toBe(400);
  });
});

describe("an ended demo", () => {
  it("takes its trucks, pump-outs, disposal records and manifest photos with it; another company keeps its own", async () => {
    const demo = await company(ctx, "Ending demo", true);
    const real = await company(ctx, "Real company");
    for (const s of [demo, real]) {
      const p = await pumped(s);
      const body = load(s, [p.groupId]);
      expect((await s.aApi.put("/disposal/loads/sync", body)).statusCode).toBe(201);
      expect((await s.aApi.putImage(`/disposal/loads/${body.clientId}/photos/${uuid()}`, JPEG, { "x-photo-key": "manifest" })).statusCode).toBe(201);
    }
    const url = (s: Company) => s.api.get("/disposal/loads").then((r) => r.json().items[0].photos[0].url as string);
    const [demoPhoto, realPhoto] = [await url(demo), await url(real)];
    expect((await ctx.app.inject({ method: "GET", url: demoPhoto })).statusCode).toBe(200);

    await sql`update organizations set demo_expires_at = now() - interval '1 hour' where id = ${demo.org.id}`.execute(ctx.db);
    expect(await emptyEndedDemo(ctx.db, ctx.store, demo.org.id)).toBe(true);
    for (const table of ["vehicles", "disposal_facilities", "pumping_records", "disposal_loads", "disposal_load_items", "work_attachments"]) {
      expect([table, await count(table, demo.org.id)]).toEqual([table, 0]);
      expect([table, await count(table, real.org.id)]).not.toEqual([table, 0]);
    }
    expect((await ctx.app.inject({ method: "GET", url: demoPhoto })).statusCode).toBe(404);
    const kept = await ctx.app.inject({ method: "GET", url: realPhoto });
    expect([kept.statusCode, kept.rawPayload.equals(JPEG)]).toEqual([200, true]);
  });
});
