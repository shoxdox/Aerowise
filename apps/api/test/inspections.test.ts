import { DEFAULT_TEMPLATE } from "@aerowise/domain";
import { describe, expect, it } from "vitest";
import { client, createUser, login, setupTestApp } from "./helpers.ts";
import { completeValues, JPEG, payload, photoUrl, setup, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

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
    expect((await s.techApi.get("/route")).json().items[0]).toMatchObject({ status: "scheduled", inspection: null });
    const draft = await s.techApi.put("/inspections/sync", payload(s));
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ status: "draft", validationStatus: "pending", values: { aerator: "pass" }, arrivalLat: 30.27 });
    // The route names the inspection, so another phone continues it rather than starting a second one.
    expect((await s.techApi.get("/route")).json().items[0]).toMatchObject({ status: "in_progress", inspection: { clientId: payload(s).clientId, status: "draft" } });

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

    expect((await s.techApi.get("/route")).json().items[0]).toMatchObject({ status: "completed", inspection: { clientId: payload(s).clientId, status: "completed" } });
    const contract = (await s.api.get(`/contracts/${s.contract.id}`)).json();
    expect(contract.obligations[0]).toMatchObject({ id: s.visit.id, status: "completed" });
    expect((await s.api.get(`/jobs/${s.job.jobId}/inspection`)).json().id).toBe(done.json().id);
  });

  it("removes only named draft photos, revalidates required photos, and preserves completed photos on replay", async () => {
    const s = await setup(ctx);
    const other = await setup(ctx, "Other tenant");
    await s.techApi.put("/inspections/sync", payload(s));
    await other.techApi.put("/inspections/sync", payload(other));
    await uploadRequiredPhotos(s, payload(s).clientId);
    await uploadRequiredPhotos(other, payload(other).clientId);
    const removedId = "00000000-0000-4000-8000-000000000001";
    const removed = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values: completeValues(), removedPhotoClientIds: [removedId] }));
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(removed.json().photos).toHaveLength(1);
    expect(removed.json().validationProblems.some((p: { key: string }) => p.key === "overview")).toBe(true);
    expect((await other.techApi.get(`/jobs/${other.job.jobId}/inspection`)).json().photos).toHaveLength(2);
    // Retake gets its own immutable id, rather than overwriting bytes under the original id.
    const retake = "00000000-0000-4000-8000-000000000003";
    expect((await s.techApi.putImage(photoUrl(payload(s).clientId, 3), JPEG, { "x-photo-key": "overview" })).statusCode).toBe(201);
    const finished = (await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values: completeValues(), removedPhotoClientIds: [removedId] }))).json();
    expect(finished.status).toBe("completed");
    expect(finished.photos.map((p: { clientId: string }) => p.clientId).sort()).toEqual(["00000000-0000-4000-8000-000000000002", retake]);
    const replay = (await s.techApi.put("/inspections/sync", payload(s, { removedPhotoClientIds: [retake], values: {} }))).json();
    expect(replay.photos).toEqual(finished.photos);
    expect(replay.status).toBe("completed");
  });

  it("keeps the inspection on the server's clock when the phone's is a year out", async () => {
    const s = await setup(ctx);
    const clientId = payload(s).clientId;
    // The phone says it arrived next year and finished last year: neither stamp can set a county deadline.
    await s.techApi.put("/inspections/sync", payload(s, { arrivedAt: "2027-03-01T15:00:00Z" }));
    await uploadRequiredPhotos(s, clientId);
    const done = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", arrivedAt: "2027-03-01T15:00:00Z", completedAt: "2025-03-01T15:40:00Z", values: completeValues() }));
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ status: "completed", arrivedAt: ctx.now.toISOString(), completedAt: ctx.now.toISOString() });
    const adjusted = await ctx.db.selectFrom("auditEvents").select("changes").where("action", "=", "inspection.clock_adjusted").executeTakeFirstOrThrow();
    expect((adjusted.changes as { adjusted: { field: string }[] }).adjusted.map((a) => a.field)).toEqual(["arrivedAt", "completedAt"]);
    // A stamp a few minutes ahead (ordinary clock drift) is kept as it is.
    const other = await setup(ctx, "Org B");
    const soon = new Date(ctx.now.getTime() + 5 * 60_000).toISOString();
    const draft = await other.techApi.put("/inspections/sync", payload(other, { arrivedAt: soon }));
    expect(draft.json().arrivedAt).toBe(soon);
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

  it("holds, for the office, an inspection sent by someone the visit is not assigned to", async () => {
    const s = await setup(ctx);
    const other = await createUser(ctx.db, s.org.id, "technician");
    const otherApi = client(ctx.app, await login(ctx.app, other.email));
    // Not refused, not written to the visit: held for the office to accept or set aside.
    const held = await otherApi.put("/inspections/sync", payload(s));
    expect(held.statusCode).toBe(202);
    expect(held.json()).toMatchObject({ outcome: "held_for_review", reason: "reassigned" });
    expect((await s.api.get(`/jobs/${s.job.jobId}/inspection`)).statusCode).toBe(404);
    // Someone else again, with the same client id, is refused: the held copy is its sender's.
    const office = await createUser(ctx.db, s.org.id, "office");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    expect((await officeApi.put("/inspections/sync", payload(s))).statusCode).toBe(403);
  });

  it("holds, for the office, an inspection for a job the office unscheduled", async () => {
    const s = await setup(ctx);
    await s.api.post(`/jobs/${s.job.jobId}/cancel`, { reason: "Customer rescheduled" });
    const held = await s.techApi.put("/inspections/sync", payload(s));
    expect(held.statusCode).toBe(202);
    expect(held.json()).toMatchObject({ reason: "cancelled" });
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
  it("lets a licensed maintenance provider accept missing form photos with a reason, and records it", async () => {
    const s = await setup(ctx);
    const failed = (await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values: completeValues() }))).json();
    expect(failed.validationStatus).toBe("invalid");

    expect((await s.techApi.post(`/inspections/${failed.id}/override`, { reason: "Camera broke" })).statusCode).toBe(403);
    // Office staff without an MP license cannot.
    const office = await createUser(ctx.db, s.org.id, "office");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    const refused = await officeApi.post(`/inspections/${failed.id}/override`, { reason: "Camera broke" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toBe("Only the owner or a licensed maintenance provider can accept an inspection anyway");
    expect((await s.api.post(`/inspections/${failed.id}/override`, {})).statusCode).toBe(400);

    // One with an MP license on file can.
    await s.api.post("/credentials", { userId: office.id, holderName: "Office Person", kind: "tceq_maintenance_provider", number: "MP0009999", verifiedOn: "2026-02-20", verificationSource: "TCEQ license search" });
    const res = await officeApi.post(`/inspections/${failed.id}/override`, { reason: "Camera broke; photos emailed separately" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "completed", validationStatus: "overridden", overrideBy: office.id });
    expect(res.json().validationProblems.map((p: { problem: string }) => p.problem)).toEqual(["photos", "photos"]);
    expect((await s.techApi.get("/route")).json().items[0].status).toBe("completed");
    const event = await ctx.db.selectFrom("auditEvents").selectAll().where("action", "=", "inspection.overridden").executeTakeFirstOrThrow();
    expect(event.actorUserId).toBe(office.id);
    expect(event.changes).toMatchObject({ reason: "Camera broke; photos emailed separately" });

    expect((await officeApi.post(`/inspections/${failed.id}/override`, { reason: "Again" })).statusCode).toBe(409);
  });

  it("never accepts an inspection with readings missing, even from the owner", async () => {
    const s = await setup(ctx);
    const values: Record<string, unknown> = completeValues();
    delete values.aerator;
    delete values.chlorine_level;
    const p = payload(s);
    await s.techApi.put("/inspections/sync", p);
    await uploadRequiredPhotos(s, p.clientId);
    const failed = (await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values }))).json();
    expect(failed.validationStatus).toBe("invalid");
    const refused = await s.api.post(`/inspections/${failed.id}/override`, { reason: "Tech confirmed by phone the unit was fine" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toBe("Only missing photos the company's own form asks for can be accepted anyway. Still needed: Aerator is required; Chlorine level is required");
    // Nothing moved: the visit is still open and nothing was filed.
    expect((await s.api.get(`/inspections/${failed.id}`)).json()).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect((await s.techApi.get("/route")).json().items[0].status).toBe("in_progress");
    expect(await ctx.db.selectFrom("filings").select("id").execute()).toEqual([]);
    // The technician finishes it on the phone instead.
    const done = (await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values: completeValues() }))).json();
    expect(done).toMatchObject({ status: "completed", validationStatus: "valid" });
  });
});

describe("follow-up issues", () => {
  const photo = (s: Setup, clientId: string, n: number, key: string) => s.techApi.putImage(`/inspections/${clientId}/photos/00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, JPEG, { "x-photo-key": key });
  const finish = async (s: Setup, o: { clientId: string; jobId: string; firstPhoto: number; values: Record<string, unknown>; issues?: object[] }) => {
    const p = payload(s, { clientId: o.clientId, jobId: o.jobId });
    await s.techApi.put("/inspections/sync", p);
    for (const [i, key] of ["overview", "chlorinator", "aerator_failure"].entries()) await photo(s, o.clientId, o.firstPhoto + i, key);
    const res = await s.techApi.put("/inspections/sync", payload(s, { clientId: o.clientId, jobId: o.jobId, status: "completed", values: o.values, issues: o.issues ?? [] }));
    expect(res.json().status, res.body).toBe("completed");
    return res.json() as { id: string; issues: { type: string; description: string; severity: string }[] };
  };
  const issueList = (i: { issues: { type: string; description: string }[] }) => i.issues.map((x) => `${x.type}: ${x.description}`).sort();

  it("opens a repair for each item marked Fail and a pump-out when pumping is needed", async () => {
    const s = await setup(ctx);
    const done = await finish(s, { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d01", jobId: s.job.jobId, firstPhoto: 1, values: { ...completeValues(), aerator: "fail", diffuser: "fail", pumping_needed: true } });
    expect(issueList(done)).toEqual(["pump_out: The technician marked pumping needed", "repair_needed: Aerator failed at the inspection", "repair_needed: Diffuser failed at the inspection"]);
    expect(done.issues.every((i) => i.severity === "medium")).toBe(true);
    // A retry of the completing sync opens nothing more.
    await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values: { ...completeValues(), aerator: "fail", diffuser: "fail", pumping_needed: true } }));
    expect(await ctx.db.selectFrom("issues").select("id").execute()).toHaveLength(3);
    // The office sees them, ready to turn into work.
    const inbox = (await s.api.get("/inbox")).json().items as { kind: string; title: string }[];
    expect(inbox.filter((i) => i.kind === "issue_open").map((i) => i.title).sort()).toEqual(["Pump-out needed", "Repair needed", "Repair needed"]);
  });

  it("leaves it to the technician's own issue of that type, and never opens one the site already has open", async () => {
    const s = await setup(ctx);
    const first = await finish(s, {
      clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d01",
      jobId: s.job.jobId,
      firstPhoto: 1,
      values: { ...completeValues(), aerator: "fail", diffuser: "fail", pumping_needed: true },
      issues: [
        { clientId: "6a3f1b2c-1d2e-4f3a-8b4c-5d6e7f8a9b01", type: "repair_needed", severity: "high", description: "Aerator hums; diaphragm worn" },
        { clientId: "6a3f1b2c-1d2e-4f3a-8b4c-5d6e7f8a9b02", type: "pump_out", severity: "high", description: "Sludge near the top" },
      ],
    });
    // The technician described the repair and the pump-out, so the answers open nothing more.
    expect(issueList(first)).toEqual(["pump_out: Sludge near the top", "repair_needed: Aerator hums; diaphragm worn"]);

    // The next visit: the diffuser still fails (now an issue of its own); the pump-out is open already.
    const job2 = (await s.api.post("/jobs", { obligationId: s.contract.obligations[1].id, technicianId: s.tech.id, scheduledDate: "2026-03-01" })).json();
    const second = await finish(s, { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d02", jobId: job2.jobId, firstPhoto: 11, values: { ...completeValues(), diffuser: "fail", pumping_needed: true } });
    expect(issueList(second)).toEqual(["repair_needed: Diffuser failed at the inspection"]);

    // And the one after: the diffuser's issue is still open, so only the new failure opens one.
    const job3 = (await s.api.post("/jobs", { obligationId: s.contract.obligations[2].id, technicianId: s.tech.id, scheduledDate: "2026-03-01" })).json();
    const third = await finish(s, { clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d03", jobId: job3.jobId, firstPhoto: 21, values: { ...completeValues(), diffuser: "fail", pump_tank: "fail", pumping_needed: true } });
    expect(issueList(third)).toEqual(["repair_needed: Pump tank failed at the inspection"]);
    expect(await ctx.db.selectFrom("issues").select("id").where("type", "=", "pump_out").execute()).toHaveLength(1);
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
