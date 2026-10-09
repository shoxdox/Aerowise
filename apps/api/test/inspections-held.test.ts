import { describe, expect, it } from "vitest";
import { createUser, login, client, setupTestApp } from "./helpers.ts";
import { completeValues, payload, setup, uploadRequiredPhotos } from "./inspection-helpers.ts";


const ctx = setupTestApp();

/** Another technician in the same company, signed in. */
async function otherTech(s: Awaited<ReturnType<typeof setup>>) {
  const tech = await createUser(ctx.db, s.org.id, "technician");
  return { tech, api: client(ctx.app, await login(ctx.app, tech.email)) };
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

describe("inspections held for the office", () => {
  it("holds a completion for a visit the office reassigned, keeps its photos, and the office accepts it credited to the technician", async () => {
    const s = await setup(ctx);
    const clientId = payload(s).clientId;
    // Tess is out of signal from the start; the office gives the still-scheduled visit to someone else.
    const other = await otherTech(s);
    expect((await s.api.patch(`/jobs/${s.job.jobId}`, { technicianId: other.tech.id })).statusCode).toBe(200);
    // Back in signal, her draft, photos and completion arrive. Nothing is refused: it is held.
    expect((await s.techApi.put("/inspections/sync", payload(s))).statusCode).toBe(202);
    for (const [n, key] of (["overview", "chlorinator"] as const).entries()) {
      expect((await s.techApi.putImage(`/inspections/${clientId}/photos/3f6b0b1e-0b1e-4b1e-8b1e-00000000001${n}`, PNG, { "content-type": "image/png", "x-photo-key": key })).statusCode).toBe(201);
    }
    const held = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: completeValues() }));
    expect(held.statusCode, held.body).toBe(202);
    expect(held.json()).toMatchObject({ outcome: "held_for_review", reason: "reassigned", status: "held", clientId });
    const conflictId = held.json().conflictId as string;
    // A retry says the same, and a photo that was still queued is kept with it.
    expect((await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: completeValues() }))).statusCode).toBe(202);
    expect((await s.techApi.putImage(`/inspections/${clientId}/photos/3f6b0b1e-0b1e-4b1e-8b1e-000000000001`, PNG, { "content-type": "image/png", "x-photo-key": "overview" })).statusCode).toBe(201);

    // The office sees it in the inbox and the list.
    const inbox = (await s.api.get("/inbox")).json();
    expect(inbox.items.find((i: { kind: string }) => i.kind === "inspection_held")).toMatchObject({ severity: "high", target: { type: "inspection_conflict", id: conflictId } });
    const listed = (await s.api.get("/inspections/conflicts?status=held")).json().items;
    expect(listed).toMatchObject([{ id: conflictId, reason: "reassigned", status: "held", photoCount: 3, technician: { id: s.tech.id } }]);

    // Accepted: the visit's inspection, completed, credited to Tess, with every photo.
    const accepted = await s.api.post(`/inspections/conflicts/${conflictId}/attach`, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ status: "attached" });
    const insp = (await s.api.get(`/jobs/${s.job.jobId}/inspection`)).json();
    expect(insp).toMatchObject({ status: "completed", validationStatus: "valid", technicianId: s.tech.id, clientId });
    expect(insp.photos).toHaveLength(3);
    expect((await s.api.get(`/contracts/${s.contract.id}`)).json().obligations[0].status).toBe("completed");
    expect((await s.api.get("/inbox")).json().items.find((i: { kind: string }) => i.kind === "inspection_held")).toBeUndefined();
    // Decided once: a second accept changes nothing, and the phone's late retry gets its completed inspection back.
    expect((await s.api.post(`/inspections/conflicts/${conflictId}/attach`, {})).statusCode).toBe(409);
    const retry = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values: completeValues() }));
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: "completed", clientId });
  });

  it("holds an inspection for a visit the office unscheduled, and accepts it onto the visit's new booking", async () => {
    const s = await setup(ctx);
    const clientId = payload(s).clientId;
    // Tess started it on the phone with no signal: nothing reached the office before the change.
    expect((await s.api.post(`/jobs/${s.job.jobId}/cancel`, { reason: "Customer asked to move it" })).statusCode).toBeLessThan(300);
    const held = await s.techApi.put("/inspections/sync", payload(s));
    expect(held.statusCode, held.body).toBe(202);
    expect(held.json()).toMatchObject({ reason: "cancelled" });
    // Photos uploaded while held are kept under the phone's inspection id.
    expect((await s.techApi.putImage(`/inspections/${clientId}/photos/3f6b0b1e-0b1e-4b1e-8b1e-000000000002`, PNG, { "content-type": "image/png", "x-photo-key": "overview" })).statusCode).toBe(201);
    expect((await s.techApi.putImage(`/inspections/${clientId}/photos/3f6b0b1e-0b1e-4b1e-8b1e-000000000003`, PNG, { "content-type": "image/png", "x-photo-key": "chlorinator" })).statusCode).toBe(201);
    const done = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: completeValues() }));
    expect(done.statusCode).toBe(202);
    const conflictId = done.json().conflictId as string;

    // With no booking for the visit, there is nothing to accept it onto.
    const refused = await s.api.post(`/inspections/conflicts/${conflictId}/attach`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("no_open_visit");
    // The office books the visit again (for someone else, even), then accepts Tess's inspection onto it.
    const other = await otherTech(s);
    const again = (await s.api.post("/jobs", { obligationId: s.visit.id, technicianId: other.tech.id, scheduledDate: "2026-03-02" })).json();
    expect((await s.api.post(`/inspections/conflicts/${conflictId}/attach`, { note: "Done before the move" })).statusCode).toBe(200);
    const insp = (await s.api.get(`/jobs/${again.jobId}/inspection`)).json();
    expect(insp).toMatchObject({ status: "completed", technicianId: s.tech.id });
    expect(insp.photos).toHaveLength(2);
    expect((await s.api.get(`/inspections/conflicts/${conflictId}`)).json()).toMatchObject({ status: "attached", attachedInspectionId: insp.id, resolutionNote: "Done before the move" });
  });

  it("holds an inspection for a visit the office completed, which the office can set aside with a reason", async () => {
    const s = await setup(ctx);
    // The office completed the visit through another technician's inspection meanwhile.
    const other = await otherTech(s);
    expect((await s.api.patch(`/jobs/${s.job.jobId}`, { technicianId: other.tech.id })).statusCode).toBe(200);
    const theirs = { ...payload(s), clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d99" };
    expect((await other.api.put("/inspections/sync", theirs)).statusCode).toBe(200);
    await uploadRequiredPhotos({ ...s, techApi: other.api }, theirs.clientId);
    expect((await other.api.put("/inspections/sync", { ...theirs, status: "completed", completedAt: "2026-03-01T15:40:00Z", values: completeValues() })).json().status).toBe("completed");

    const held = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T16:40:00Z", values: completeValues() }));
    expect(held.statusCode).toBe(202);
    expect(held.json()).toMatchObject({ reason: "office_completed" });
    const conflictId = held.json().conflictId as string;
    // Accepting would duplicate the visit's inspection; it is set aside instead, and the reason is kept.
    expect((await s.api.post(`/inspections/conflicts/${conflictId}/attach`, {})).json().error).toBe("visit_has_inspection");
    expect((await s.api.post(`/inspections/conflicts/${conflictId}/dismiss`, { reason: "Duplicate of the other technician's visit" })).json()).toMatchObject({ status: "dismissed", resolutionNote: "Duplicate of the other technician's visit" });
    expect((await s.api.get("/inspections/conflicts?status=held")).json().items).toEqual([]);
    // The phone learns the decision; a technician who was never on the visit is still refused.
    expect((await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values: completeValues() }))).json()).toMatchObject({ status: "dismissed" });
    expect((await s.techApi.get("/inspections/conflicts")).statusCode).toBe(403);
  });
});
