import { snapshotSha256 } from "@aerowise/domain";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { JPEG } from "./inspection-helpers.ts";

const ctx = setupTestApp({ features: ["work_orders", "field_work"] });

type Api = ReturnType<typeof client>;
const uuid = () => crypto.randomUUID();

const SUMMARY = { workDone: "Replaced float switch", parts: [{ name: "Float switch", qty: 1 }], notes: "Alarm tested" };
const VALUES = { problem: "Alarm sounding", work_performed: "Replaced float switch", follow_up_needed: false };

/** A company with a repair work order scheduled today for technician A; B is another technician. */
async function setup(c: TestContext) {
  const t = await createTenant(c, "Org A");
  const a = await createUser(c.db, t.org.id, "technician");
  const b = await createUser(c.db, t.org.id, "technician");
  const aApi = client(c.app, await login(c.app, a.email));
  const bApi = client(c.app, await login(c.app, b.email));
  const repair = ((await t.api.get("/work-types")).json().items as { id: string; key: string }[]).find((x) => x.key === "repair")!;
  const wo = (await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: repair.id })).json();
  const scheduled = await t.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: a.id, scheduledDate: "2026-03-01" });
  expect(scheduled.statusCode, scheduled.body).toBe(201);
  const jobId = scheduled.json().visits[0].jobId as string;
  const form = (await aApi.get("/form-templates/work-repair")).json();
  return { ...t, a, b, aApi, bApi, wo, jobId, form };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** One visit as the phone would record it: its ids, the full record body and its uploads. */
function visit(s: Setup, overrides: Record<string, unknown> = {}) {
  const clientId = uuid();
  const photos = [uuid(), uuid()];
  const signatureId = uuid();
  const body = (status: "draft" | "completed", revision = 1) => ({
    clientId,
    jobId: s.jobId,
    templateId: s.form.id,
    status,
    revision,
    arrivedAt: "2026-03-01T15:00:00Z",
    completedAt: status === "completed" ? "2026-03-01T16:00:00Z" : null,
    values: VALUES,
    summary: SUMMARY,
    ...overrides,
  });
  return {
    clientId,
    photos,
    signatureId,
    sync: (api: Api, status: "draft" | "completed" = "draft", revision?: number) => api.put("/work/sync", body(status, revision)),
    photo: (api: Api, i: number) => api.putImage(`/work/${clientId}/photos/${photos[i]}`, JPEG, { "x-photo-key": i === 0 ? "before" : "after" }),
    sign: async (api: Api, summary: object = SUMMARY) =>
      api.put(`/work/${clientId}/signatures/${signatureId}`, {
        requirementKey: "customer_signoff",
        signerName: "Pat Homeowner",
        capture: { kind: "typed" },
        summary,
        summarySha256: await snapshotSha256(summary),
        consentText: "I confirm this work was done.",
        signedAt: "2026-03-01T15:55:00Z",
      }),
  };
}

/** Sends everything for a visit in the phone's order: draft, both photos, signature, completion. */
async function sendAll(api: Api, v: ReturnType<typeof visit>) {
  return [await v.sync(api, "draft"), await v.photo(api, 0), await v.photo(api, 1), await v.sign(api), await v.sync(api, "completed", 2)];
}

const count = async (table: string, organizationId: string) =>
  Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(table)} where organization_id = ${organizationId}`.execute(ctx.db)).rows[0]!.n);

describe("field records from the phone", () => {
  it("records a visit once: draft, photos, signature, completion, and a replay of every step changes nothing", async () => {
    const s = await setup(ctx);
    const v = visit(s);
    const [draft, p1, p2, sig, done] = await sendAll(s.aApi, v);
    expect(draft!.statusCode, draft!.body).toBe(200);
    expect(draft!.json()).toMatchObject({ clientId: v.clientId, status: "draft", jobId: s.jobId });
    expect([p1!.statusCode, p2!.statusCode, sig!.statusCode]).toEqual([201, 201, 201]);
    expect(done!.statusCode, done!.body).toBe(200);
    const rec = done!.json();
    expect(rec).toMatchObject({ status: "completed", validationStatus: "valid", finalVisit: true, summarySha256: await snapshotSha256(SUMMARY) });
    expect(rec.photos).toHaveLength(2);
    expect(rec.signatures).toEqual([expect.objectContaining({ requirementKey: "customer_signoff", signerName: "Pat Homeowner" })]);

    const detail = (await s.api.get(`/work-orders/${s.wo.id}`)).json();
    expect(detail).toMatchObject({ status: "completed", visits: [{ jobId: s.jobId, status: "completed" }] });
    expect((await s.api.get(`/jobs/${s.jobId}/work-record`)).json().id).toBe(rec.id);

    // Every op again, as a phone retrying after a lost answer.
    const replay = await sendAll(s.aApi, v);
    expect(replay.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(await count("work_records", s.org.id)).toBe(1);
    expect(await count("work_attachments", s.org.id)).toBe(2);
    expect(await count("signed_documents", s.org.id)).toBe(1);
    // The photo link works.
    const file = await ctx.app.inject({ method: "GET", url: rec.photos[0].url });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(JPEG)).toBe(true);
  });

  it("keeps an incomplete record a draft and lists what is missing", async () => {
    const s = await setup(ctx);
    const v = visit(s);
    await v.sync(s.aApi, "draft");
    await v.photo(s.aApi, 0);
    const res = await v.sync(s.aApi, "completed");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.json().validationProblems.map((p: { key: string }) => p.key)).toEqual(["after"]);
    expect((await s.api.get(`/work-orders/${s.wo.id}`)).json().status).toBe("scheduled");
  });

  it("refuses a completion whose summary changed after the customer signed", async () => {
    const s = await setup(ctx);
    const v = visit(s);
    await v.sync(s.aApi, "draft");
    await v.photo(s.aApi, 0);
    await v.photo(s.aApi, 1);
    await v.sign(s.aApi, { ...SUMMARY, workDone: "Replaced float switch and pump" });
    const res = await v.sync(s.aApi, "completed");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("signature_mismatch");
    const stored = (await s.api.get(`/jobs/${s.jobId}/work-record`)).json();
    expect(stored.status).toBe("draft");
    // A signature whose hash does not match its own summary never gets in.
    const bad = await s.aApi.put(`/work/${v.clientId}/signatures/${uuid()}`, { requirementKey: "customer_signoff", signerName: "Pat", capture: { kind: "typed" }, summary: SUMMARY, summarySha256: "0".repeat(64), consentText: "ok", signedAt: "2026-03-01T15:55:00Z" });
    expect(bad.statusCode).toBe(422);
  });

  it("a visit that is not the last sends the order back to ready to schedule", async () => {
    const s = await setup(ctx);
    const v = visit(s, { finalVisit: false });
    await sendAll(s.aApi, v);
    expect((await s.api.get(`/work-orders/${s.wo.id}`)).json()).toMatchObject({ status: "open", visits: [{ status: "completed" }] });
  });

  it("lists the technician's work visits with their form, and nothing when field work is off", async () => {
    const s = await setup(ctx);
    const route = (await s.aApi.get("/work/route?date=2026-03-01")).json();
    expect(route.items).toEqual([expect.objectContaining({ jobId: s.jobId, templateId: s.form.id, record: null, workOrderLabel: s.wo.label })]);
    expect((await s.bApi.get("/work/route?date=2026-03-01")).json().items).toEqual([]);
    // The inspection route is unchanged: older phones never see a work visit.
    expect(JSON.stringify((await s.aApi.get("/route?date=2026-03-01")).json())).not.toContain(s.jobId);
  });

  it("with no date, lists the visits for the company's today, not the server's UTC date", async () => {
    const s = await setup(ctx);
    // 9 pm on March 1 in Chicago is already March 2 in UTC.
    ctx.now = new Date("2026-03-02T03:00:00Z");
    const route = (await s.aApi.get("/work/route")).json();
    expect(route.date).toBe("2026-03-01");
    expect(route.items.map((i: { jobId: string }) => i.jobId)).toEqual([s.jobId]);
  });
});

describe("visits the office changed while the phone was offline (R4)", () => {
  async function expectHeld(responses: { statusCode: number; json: () => { outcome?: string; conflictId?: string } }[]) {
    expect(responses.map((r) => r.statusCode)).toEqual(responses.map(() => 202));
    const ids = new Set(responses.map((r) => r.json().conflictId));
    expect(ids.size).toBe(1);
    return [...ids][0]!;
  }

  for (const how of ["reassign", "cancel"] as const) {
    it(`${how} before the first draft sync: everything is held on one conflict, nothing is lost or duplicated`, async () => {
      const s = await setup(ctx);
      const v = visit(s);
      if (how === "reassign") expect((await s.api.patch(`/jobs/${s.jobId}`, { technicianId: s.b.id })).statusCode).toBe(200);
      else expect((await s.api.post(`/jobs/${s.jobId}/cancel`, { reason: "Customer rescheduled" })).statusCode).toBe(204);
      const conflictId = await expectHeld(await sendAll(s.aApi, v));
      const [c] = (await s.api.get("/work/conflicts?status=held")).json().items;
      expect(c).toMatchObject({ id: conflictId, reason: how === "reassign" ? "reassigned" : "cancelled", photoCount: 2, signatureCount: 1, technicianId: s.a.id });
      expect(c.payload).toMatchObject({ status: "completed", clientId: v.clientId });
      expect(await count("work_sync_conflicts", s.org.id)).toBe(1);
      expect(await count("work_records", s.org.id)).toBe(0);
    });
  }

  for (const how of ["reassign", "cancel", "office_complete"] as const) {
    it(`${how} after the draft sync, before the uploads: the draft moves to a conflict and the visit is free`, async () => {
      const s = await setup(ctx);
      const v = visit(s);
      expect((await v.sync(s.aApi, "draft")).statusCode).toBe(200);
      if (how === "reassign") expect((await s.api.patch(`/jobs/${s.jobId}`, { technicianId: s.b.id })).statusCode).toBe(200);
      else if (how === "cancel") expect((await s.api.post(`/jobs/${s.jobId}/cancel`, { reason: "Customer rescheduled" })).statusCode).toBe(204);
      else expect((await s.api.post(`/work-orders/${s.wo.id}/complete`, { reason: "Done on paper" })).statusCode).toBe(200);
      expect(await count("work_records", s.org.id)).toBe(0);
      const [c0] = (await s.api.get("/work/conflicts")).json().items;
      expect(c0).toMatchObject({ reason: how === "reassign" ? "reassigned" : how === "cancel" ? "cancelled" : "office_completed", status: "held" });

      const rest = [await v.photo(s.aApi, 0), await v.photo(s.aApi, 1), await v.sign(s.aApi), await v.sync(s.aApi, "completed", 2)];
      expect(await expectHeld(rest)).toBe(c0.id);

      if (how === "reassign") {
        // The new technician starts and finishes their own record for the same visit.
        const mine = visit(s);
        const sent = await sendAll(s.bApi, mine);
        expect(sent.map((r) => r.statusCode)).toEqual([200, 201, 201, 201, 200]);
        expect(sent[4]!.json().status).toBe("completed");
      }
      if (how === "office_complete") {
        const attached = await s.api.post(`/work/conflicts/${c0.id}/attach`, {});
        expect(attached.statusCode, attached.body).toBe(200);
        const wo = (await s.api.get(`/work-orders/${s.wo.id}`)).json();
        expect(wo).toMatchObject({ status: "completed", completedWithoutRecordReason: null });
      }
    });
  }

  it("an upload sent before its record gets record_not_synced, and is accepted once the draft lands", async () => {
    const s = await setup(ctx);
    const v = visit(s);
    const early = await v.photo(s.aApi, 0);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("record_not_synced");
    expect(await count("work_attachments", s.org.id)).toBe(0);
    await v.sync(s.aApi, "draft");
    expect((await v.photo(s.aApi, 0)).statusCode).toBe(201);
  });

  it("a technician never sent on the visit gets 403 with nothing stored; another company gets 404", async () => {
    const s = await setup(ctx);
    const v = visit(s);
    const res = await v.sync(s.bApi, "draft");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_assigned");
    expect(await count("work_records", s.org.id)).toBe(0);
    expect(await count("work_sync_conflicts", s.org.id)).toBe(0);
    // A's draft is A's: B cannot add to it either.
    await v.sync(s.aApi, "draft");
    expect((await v.photo(s.bApi, 0)).statusCode).toBe(403);

    const other = await createTenant(ctx, "Org B");
    const otherTech = await createUser(ctx.db, other.org.id, "technician");
    const otherApi = client(ctx.app, await login(ctx.app, otherTech.email));
    expect((await visit(s).sync(otherApi, "draft")).statusCode).toBe(404);
  });

  it("replays after a hold add nothing, and after the office decides they get resolved", async () => {
    const s = await setup(ctx);
    const v = visit(s);
    await s.api.patch(`/jobs/${s.jobId}`, { technicianId: s.b.id });
    await sendAll(s.aApi, v);
    await sendAll(s.aApi, v);
    expect([await count("work_sync_conflicts", s.org.id), await count("work_attachments", s.org.id), await count("signed_documents", s.org.id)]).toEqual([1, 2, 1]);
    const [c] = (await s.api.get("/work/conflicts")).json().items;
    // A held payload keeps the newest phone revision: an older one arriving late is ignored.
    const stale = await s.aApi.put("/work/sync", { ...c.payload, revision: 1, values: { ...VALUES, problem: "older text" } });
    expect(stale.statusCode).toBe(202);
    expect((await s.api.get(`/work/conflicts/${c.id}`)).json().payload.values.problem).toBe(VALUES.problem);
    await s.aApi.put("/work/sync", { ...c.payload, revision: 7, values: { ...VALUES, problem: "newer text" } });
    expect((await s.api.get(`/work/conflicts/${c.id}`)).json().payload.values.problem).toBe("newer text");
    const dismissed = await s.api.post(`/work/conflicts/${c.id}/dismiss`, { reason: "B did the repair" });
    expect(dismissed.json()).toMatchObject({ status: "dismissed", resolutionNote: "B did the repair" });
    const after = await sendAll(s.aApi, v);
    expect(after.map((r) => [r.statusCode, r.json().outcome])).toEqual(after.map(() => [200, "resolved"]));
    expect([await count("work_attachments", s.org.id), await count("signed_documents", s.org.id)]).toEqual([2, 1]);
    expect((await s.api.post(`/work/conflicts/${c.id}/attach`, {})).statusCode).toBe(409);
  });

  it("the office attaches a held record: same photos and files, credited to the technician who did the work", async () => {
    const s = await setup(ctx);
    const v = visit(s);
    await s.api.post(`/jobs/${s.jobId}/cancel`, { reason: "Wrong day" });
    await sendAll(s.aApi, v);
    const keysBefore = await ctx.db.selectFrom("workAttachments").select(["id", "storageKey"]).orderBy("id").execute();
    const [c] = (await s.api.get("/work/conflicts")).json().items;
    const attached = await s.api.post(`/work/conflicts/${c.id}/attach`, { note: "Work was done before the cancel" });
    expect(attached.statusCode, attached.body).toBe(200);
    expect(attached.json()).toMatchObject({ status: "attached", resolutionNote: "Work was done before the cancel" });
    // The cancelled visit stays cancelled; the work is on a new completed visit.
    const wo = (await s.api.get(`/work-orders/${s.wo.id}`)).json();
    expect(wo.visits.map((x: { status: string }) => x.status).sort()).toEqual(["cancelled", "completed"]);
    const rec = (await s.api.get(`/jobs/${attached.json().attachedJobId}/work-record`)).json();
    expect(rec).toMatchObject({ clientId: v.clientId, technicianId: s.a.id, status: "completed", attachedByOffice: true });
    expect(rec.photos).toHaveLength(2);
    expect(rec.signatures).toHaveLength(1);
    expect(await ctx.db.selectFrom("workAttachments").select(["id", "storageKey"]).orderBy("id").execute()).toEqual(keysBefore);
    const audit = await ctx.db.selectFrom("auditEvents").select(["action", "changes"]).where("action", "=", "work_record.attached").executeTakeFirstOrThrow();
    expect(audit.changes).toMatchObject({ technicianUserId: s.a.id, conflictId: c.id });
    // The phone's next replay learns it was accepted.
    expect((await v.sync(s.aApi, "completed", 3)).json()).toEqual({ outcome: "resolved", conflictId: c.id, resolution: "attached" });
    expect((await v.photo(s.aApi, 0)).json()).toEqual({ outcome: "resolved", conflictId: c.id, resolution: "attached" });
  });
});

describe("races with the office", () => {
  it("a sync waiting on a reassignment in progress is held for the office, not written to the new technician's visit", async () => {
    const s = await setup(ctx);
    const v = visit(s);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // The office's move, held open with the work order locked, as PATCH /jobs/:id does.
    const office = ctx.db.transaction().execute(async (trx) => {
      await sql`select id from work_orders where id = ${s.wo.id} for update`.execute(trx);
      locked();
      await gate;
      await sql`update jobs set technician_user_id = ${s.b.id}, updated_at = now() where id = ${s.jobId}`.execute(trx);
    });
    await isLocked;
    const sent = v.sync(s.aApi, "draft");
    await new Promise((r) => setTimeout(r, 300));
    release();
    await office;
    const res = await sent;
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ outcome: "held_for_review", reason: "reassigned" });
    expect(await count("work_records", s.org.id)).toBe(0);
  });

  it("a draft synced just before a reassignment moves to a conflict; its next sync is held", async () => {
    const s = await setup(ctx);
    const v = visit(s);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    expect((await v.sync(s.aApi, "draft")).statusCode).toBe(200);
    const office = ctx.db.transaction().execute(async (trx) => {
      await sql`select id from work_orders where id = ${s.wo.id} for update`.execute(trx);
      locked();
      await gate;
      await sql`update jobs set technician_user_id = ${s.b.id}, updated_at = now() where id = ${s.jobId}`.execute(trx);
    });
    await isLocked;
    const sent = v.sync(s.aApi, "draft", 2);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await office;
    expect((await sent).statusCode).toBe(202);
    expect([await count("work_records", s.org.id), await count("work_sync_conflicts", s.org.id)]).toEqual([0, 1]);
  });
});

describe("assignment history", () => {
  it("records every technician sent on a work visit, ending each once", async () => {
    const s = await setup(ctx);
    await s.api.patch(`/jobs/${s.jobId}`, { technicianId: s.b.id });
    await s.api.post(`/jobs/${s.jobId}/cancel`, { reason: "Customer away" });
    const rows = await ctx.db.selectFrom("jobAssignments").select(["technicianUserId", "endReason"]).where("jobId", "=", s.jobId).orderBy("assignedAt").orderBy("endedAt").execute();
    expect(rows).toEqual([
      { technicianUserId: s.a.id, endReason: "reassigned" },
      { technicianUserId: s.b.id, endReason: "cancelled" },
    ]);
    await expect(sql`update job_assignments set technician_user_id = ${s.b.id} where job_id = ${s.jobId}`.execute(ctx.db)).rejects.toThrow(/append-only/);
    await expect(sql`delete from job_assignments where job_id = ${s.jobId}`.execute(ctx.db)).rejects.toThrow(/never deleted/);
  });

  it("refuses work when field work is off and nothing was started", async () => {
    // Covered with the flag on elsewhere; here the plugin is checked directly with it off.
    const { buildApp } = await import("../src/app.ts");
    const app = await buildApp({ db: ctx.db, loginRateLimit: 1000, now: () => ctx.now, store: ctx.store, sms: ctx.sms, features: new Set(["work_orders"]) });
    try {
      const s = await setup(ctx);
      const api = client(app, await login(app, s.a.email));
      const res = await visit(s).sync(api, "draft");
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("feature_off");
      expect((await api.get("/work/route?date=2026-03-01")).json().items).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
