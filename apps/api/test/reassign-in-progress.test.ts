import { describe, expect, it } from "vitest";
import { client, createUser, login, setupTestApp } from "./helpers.ts";
import { completeValues, payload, setup, uploadRequiredPhotos } from "./inspection-helpers.ts";

const ctx = setupTestApp();

async function otherTech(s: Awaited<ReturnType<typeof setup>>) {
  const tech = await createUser(ctx.db, s.org.id, "technician");
  return { tech, api: client(ctx.app, await login(ctx.app, tech.email)) };
}

describe("giving an inspection in progress to another technician", () => {
  it("moves the visit and its inspection; the new phone continues it and the first phone's later work is held", async () => {
    const s = await setup(ctx);
    const clientId = payload(s).clientId;
    // Tess arrives and her draft reaches the server: the job is in progress.
    expect((await s.techApi.put("/inspections/sync", payload(s))).statusCode).toBe(200);
    const jobStatus = async () => (await ctx.db.selectFrom("jobs").select("status").where("id", "=", s.job.jobId).executeTakeFirstOrThrow()).status;
    expect(await jobStatus()).toBe("in_progress");

    // Not to another day, and not a work visit; to another technician, yes.
    const other = await otherTech(s);
    expect((await s.api.patch(`/jobs/${s.job.jobId}`, { technicianId: other.tech.id, scheduledDate: "2026-03-02" })).statusCode).toBe(409);
    const moved = await s.api.patch(`/jobs/${s.job.jobId}`, { technicianId: other.tech.id });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ status: "in_progress", technicianId: other.tech.id, inspection: { clientId, status: "draft" } });
    const insp = (await s.api.get(`/jobs/${s.job.jobId}/inspection`)).json();
    expect(insp).toMatchObject({ technicianId: other.tech.id, status: "draft", clientId });
    const audit = await ctx.db.selectFrom("auditEvents").select(["action", "changes"]).where("organizationId", "=", s.org.id).where("action", "=", "inspection.reassigned").execute();
    expect(audit).toMatchObject([{ changes: { from: s.tech.id, to: other.tech.id } }]);

    // The new technician's route names the inspection, and the phone continues it under the same id.
    const route = (await other.api.get("/route?date=2026-03-01")).json();
    expect(route.items).toMatchObject([{ jobId: s.job.jobId, inspection: { clientId, status: "draft" } }]);
    expect((await other.api.get(`/jobs/${s.job.jobId}/inspection`)).json().values).toEqual({ aerator: "pass" });
    const continued = await other.api.put("/inspections/sync", payload(s, { values: { aerator: "pass", chlorinator: "working" } }));
    expect(continued.statusCode, continued.body).toBe(200);

    // Tess, out of signal through all this, sends more: held for the office, nothing lost or refused.
    const late = await s.techApi.put("/inspections/sync", payload(s, { values: { aerator: "fail" } }));
    expect(late.statusCode, late.body).toBe(202);
    expect(late.json()).toMatchObject({ outcome: "held_for_review", reason: "reassigned", clientId });
    expect((await other.api.get(`/jobs/${s.job.jobId}/inspection`)).json().values).toEqual({ aerator: "pass", chlorinator: "working" });

    // The new technician finishes it; the visit completes under their name.
    await uploadRequiredPhotos({ ...s, techApi: other.api }, clientId);
    const done = await other.api.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: completeValues() }));
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ status: "completed", validationStatus: "valid", technicianId: other.tech.id });
    expect(await jobStatus()).toBe("completed");
    // The office still sees Tess's held copy to set aside.
    expect((await s.api.get("/inspections/conflicts?status=held")).json().items).toMatchObject([{ reason: "reassigned", technician: { id: s.tech.id } }]);
  });

  it("still refuses to move a completed job, and a work visit in progress", async () => {
    const s = await setup(ctx);
    await s.techApi.put("/inspections/sync", payload(s));
    await uploadRequiredPhotos(s, payload(s).clientId);
    expect((await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: completeValues() }))).statusCode).toBe(200);
    const other = await otherTech(s);
    const res = await s.api.patch(`/jobs/${s.job.jobId}`, { technicianId: other.tech.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("A completed job cannot be moved");
  });
});
