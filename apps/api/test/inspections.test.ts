import { DEFAULT_TEMPLATE } from "@aerowise/domain";
import { describe, expect, it } from "vitest";
import { client, createUser, login, setupTestApp } from "./helpers.ts";
import { completeValues, JPEG, payload, photoUrl, setup, uploadRequiredPhotos } from "./inspection-helpers.ts";

const ctx = setupTestApp();

describe("inspection templates", () => {
  it("serves the built-in aerobic template until the organization saves its own version", async () => {
    const s = await setup(ctx);
    expect(s.template).toMatchObject({ key: "aerobic-standard", version: 2, builtIn: true });

    const custom = { ...DEFAULT_TEMPLATE.definition, photos: [{ key: "overview", label: "Overview", minCount: 2 }] };
    const saved = await s.api.post("/inspection-templates", { name: "Our inspection", definition: custom });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({ version: 1, builtIn: false });
    const again = (await s.api.post("/inspection-templates", { name: "Our inspection v2", definition: custom })).json();
    expect(again.version).toBe(2);
    expect((await s.techApi.get("/inspection-template")).json()).toMatchObject({ id: again.id, name: "Our inspection v2" });
    // Old versions stay readable for inspections done with them.
    expect((await s.techApi.get(`/inspection-templates/${s.template.id}`)).statusCode).toBe(200);
  });

  it("rejects templates with conditions on unknown fields, and lets only owners save them", async () => {
    const s = await setup(ctx);
    const bad = { fields: [{ key: "a", label: "A", section: "S", type: "boolean", showWhen: { field: "nope", in: [true] } }], photos: [] };
    expect((await s.api.post("/inspection-templates", { name: "Bad", definition: bad })).statusCode).toBe(400);
    const office = await createUser(ctx.db, s.org.id, "office");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    expect((await officeApi.post("/inspection-templates", { name: "X", definition: DEFAULT_TEMPLATE.definition })).statusCode).toBe(403);
  });
});

describe("recording an inspection", () => {
  it("starts the job on the first sync and completes job and visit when the inspection is valid", async () => {
    const s = await setup(ctx);
    const draft = await s.techApi.put("/inspections/sync", payload(s));
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ status: "draft", validationStatus: "pending", values: { aerator: "pass" }, arrivalLat: 30.27 });
    expect((await s.techApi.get("/route")).json().items[0].status).toBe("in_progress");

    const clientId = draft.json().clientId;
    await uploadRequiredPhotos(s, clientId);
    const done = await s.techApi.put(
      "/inspections/sync",
      payload(s, {
        status: "completed",
        completedAt: "2026-03-01T15:40:00Z",
        values: completeValues(),
        issues: [{ clientId: "1c6f7a52-2c0e-4d36-8f3e-1b8b9a2a7e11", type: "pump_out", severity: "low", description: "Sludge at 30%" }],
      }),
    );
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "completed", validationStatus: "valid", completedAt: "2026-03-01T15:40:00.000Z" });
    expect(done.json().photos).toHaveLength(2);
    expect(done.json().issues).toMatchObject([{ type: "pump_out", status: "open" }]);

    expect((await s.techApi.get("/route")).json().items[0].status).toBe("completed");
    const contract = (await s.api.get(`/contracts/${s.contract.id}`)).json();
    expect(contract.obligations[0]).toMatchObject({ id: s.visit.id, status: "completed" });
    expect((await s.api.get(`/jobs/${s.job.jobId}/inspection`)).json().id).toBe(done.json().id);
  });

  it("keeps a failed completion as a draft and lists what is missing", async () => {
    const s = await setup(ctx);
    const values = { ...completeValues(), aerator: "fail" } as Record<string, unknown>;
    delete values.chlorine_level;
    const res = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(body.validationProblems.map((p: { key: string }) => p.key).sort()).toEqual(["aerator_failure", "chlorinator", "chlorine_level", "overview"]);
    expect((await s.techApi.get("/route")).json().items[0].status).toBe("in_progress");
  });

  it("does not require hidden conditional fields, and drops their answers on completion", async () => {
    const s = await setup(ctx);
    const values = { ...completeValues(), chlorinator: "not_present", chlorine_level: 2 };
    await s.techApi.put("/inspections/sync", payload(s));
    await s.techApi.putImage(photoUrl(payload(s).clientId, 1), JPEG, { "x-photo-key": "overview" });
    const res = (await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values }))).json();
    expect(res.validationStatus).toBe("valid");
    expect(res.values.chlorine_level).toBeUndefined();
  });

  it("rejects answers to fields the template does not have", async () => {
    const s = await setup(ctx);
    const res = await s.techApi.put("/inspections/sync", payload(s, { values: { aerator: "pass", made_up: 1 } }));
    expect(res.statusCode).toBe(422);
  });

  it("only lets the assigned technician record the inspection", async () => {
    const s = await setup(ctx);
    const other = await createUser(ctx.db, s.org.id, "technician");
    const otherApi = client(ctx.app, await login(ctx.app, other.email));
    expect((await otherApi.put("/inspections/sync", payload(s))).statusCode).toBe(403);
    const office = await createUser(ctx.db, s.org.id, "office");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    expect((await officeApi.put("/inspections/sync", payload(s))).statusCode).toBe(403);
  });

  it("refuses to record an inspection for a job the office unscheduled", async () => {
    const s = await setup(ctx);
    await s.api.post(`/jobs/${s.job.jobId}/cancel`, { reason: "Customer rescheduled" });
    expect((await s.techApi.put("/inspections/sync", payload(s))).statusCode).toBe(409);
  });
});

describe("offline retries", () => {
  it("treats a repeated sync as the same inspection", async () => {
    const s = await setup(ctx);
    const first = (await s.techApi.put("/inspections/sync", payload(s))).json();
    const second = (await s.techApi.put("/inspections/sync", payload(s, { values: { aerator: "pass", notes: "Second save" } }))).json();
    expect(second.id).toBe(first.id);
    expect(second.values).toEqual({ aerator: "pass", notes: "Second save" });
    const rows = await ctx.db.selectFrom("inspections").select("id").execute();
    expect(rows).toHaveLength(1);
  });

  it("returns a completed inspection unchanged when the completing sync or a stale draft arrives again", async () => {
    const s = await setup(ctx);
    await s.techApi.put("/inspections/sync", payload(s));
    await uploadRequiredPhotos(s, payload(s).clientId);
    const done = (await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values: completeValues() }))).json();
    const replay = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values: completeValues() }));
    expect(replay.statusCode).toBe(200);
    expect(replay.json().updatedAt).toBe(done.updatedAt);
    const stale = (await s.techApi.put("/inspections/sync", payload(s, { values: { aerator: "fail" } }))).json();
    expect(stale).toMatchObject({ status: "completed", values: { aerator: "pass" } });
    const events = await ctx.db.selectFrom("auditEvents").select("action").where("action", "=", "inspection.completed").execute();
    expect(events).toHaveLength(1);
  });

  it("stores a retried photo upload once", async () => {
    const s = await setup(ctx);
    const insp = (await s.techApi.put("/inspections/sync", payload(s))).json();
    const url = photoUrl(insp.clientId, 1);
    const first = await s.techApi.putImage(url, JPEG, { "x-photo-key": "overview", "x-lat": "30.27", "x-lng": "-97.74" });
    const retry = await s.techApi.putImage(url, JPEG, { "x-photo-key": "overview" });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(first.json().id);
    expect(first.json()).toMatchObject({ photoKey: "overview", lat: 30.27, byteSize: JPEG.length });
    expect((await s.techApi.get(`/inspections/${insp.id}`)).json().photos).toHaveLength(1);
  });

  it("rejects photos with an unknown key, a bad checksum, or a non-image body", async () => {
    const s = await setup(ctx);
    const insp = (await s.techApi.put("/inspections/sync", payload(s))).json();
    expect((await s.techApi.putImage(photoUrl(insp.clientId, 1), JPEG, { "x-photo-key": "selfie" })).statusCode).toBe(422);
    expect((await s.techApi.putImage(photoUrl(insp.clientId, 2), JPEG, { "x-photo-key": "overview", "x-sha256": "0".repeat(64) })).statusCode).toBe(422);
    expect((await s.techApi.putImage(photoUrl(insp.clientId, 3), JPEG, { "x-photo-key": "overview", "content-type": "text/plain" })).statusCode).toBe(415);
  });
});

describe("supervisor override", () => {
  it("lets the office accept a failed inspection with a reason, and records it", async () => {
    const s = await setup(ctx);
    const failed = (await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values: completeValues() }))).json();
    expect(failed.validationStatus).toBe("invalid");

    expect((await s.techApi.post(`/inspections/${failed.id}/override`, { reason: "Camera broke" })).statusCode).toBe(403);
    const office = await createUser(ctx.db, s.org.id, "office");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    expect((await officeApi.post(`/inspections/${failed.id}/override`, {})).statusCode).toBe(400);

    const res = await officeApi.post(`/inspections/${failed.id}/override`, { reason: "Camera broke; photos emailed separately" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "completed", validationStatus: "overridden", overrideBy: office.id });
    expect((await s.techApi.get("/route")).json().items[0].status).toBe("completed");
    const event = await ctx.db.selectFrom("auditEvents").selectAll().where("action", "=", "inspection.overridden").executeTakeFirstOrThrow();
    expect(event.actorUserId).toBe(office.id);
    expect(event.changes).toMatchObject({ reason: "Camera broke; photos emailed separately" });

    expect((await officeApi.post(`/inspections/${failed.id}/override`, { reason: "Again" })).statusCode).toBe(409);
  });
});

describe("photo links and tenancy", () => {
  it("serves photos through expiring signed links", async () => {
    const s = await setup(ctx);
    const insp = (await s.techApi.put("/inspections/sync", payload(s))).json();
    const photo = (await s.techApi.putImage(photoUrl(insp.clientId, 1), JPEG, { "x-photo-key": "overview" })).json();

    const anon = client(ctx.app);
    const ok = await anon.get(photo.url);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/jpeg");
    expect(ok.rawPayload.equals(JPEG)).toBe(true);

    expect((await anon.get(photo.url.replace(/sig=[^&]+/, "sig=forged"))).statusCode).toBe(404);
    ctx.now = new Date(ctx.now.getTime() + 16 * 60 * 1000);
    expect((await anon.get(photo.url)).statusCode).toBe(404);
  });

  it("does not let one organization read or touch another's inspections and photos", async () => {
    const a = await setup(ctx, "Org A");
    const b = await setup(ctx, "Org B");
    const insp = (await a.techApi.put("/inspections/sync", payload(a))).json();
    const photo = (await a.techApi.putImage(photoUrl(insp.clientId, 1), JPEG, { "x-photo-key": "overview" })).json();

    expect((await b.api.get(`/inspections/${insp.id}`)).statusCode).toBe(404);
    expect((await b.api.get(`/jobs/${a.job.jobId}/inspection`)).statusCode).toBe(404);
    expect((await b.api.post(`/inspections/${insp.id}/override`, { reason: "Not mine" })).statusCode).toBe(404);
    // B's technician cannot sync against A's job, or upload into A's inspection.
    expect((await b.techApi.put("/inspections/sync", payload(a, { clientId: crypto.randomUUID(), templateId: b.template.id }))).statusCode).toBe(404);
    expect((await b.techApi.putImage(photoUrl(insp.clientId, 2), JPEG, { "x-photo-key": "overview" })).statusCode).toBe(404);

    // A link signed for B's own photo cannot be pointed at A's photo.
    const bInsp = (await b.techApi.put("/inspections/sync", payload(b, { clientId: crypto.randomUUID() }))).json();
    const bPhoto = (await b.techApi.putImage(photoUrl(bInsp.clientId, 3), JPEG, { "x-photo-key": "overview" })).json();
    const query = bPhoto.url.split("?")[1];
    expect((await client(ctx.app).get(`/files/${photo.id}?${query}`)).statusCode).toBe(404);
  });
});
