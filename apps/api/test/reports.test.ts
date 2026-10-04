import { DEFAULT_TEMPLATE } from "@aerowise/domain";
import type { ReportSnapshot } from "@aerowise/reports";
import type { ObjectStore } from "@aerowise/storage";
import { drainTasks, generateReports } from "@aerowise/tasks";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { client, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, payload, photoUrl, setup, type Setup } from "./inspection-helpers.ts";

const ctx = setupTestApp();

// A 1×1 PNG, so the customer copy embeds a real image.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const runWorker = (c: TestContext, store: ObjectStore = c.store) => drainTasks({ db: c.db, store, now: () => c.now });

/** Completes the setup's inspection with photos, a customer note and two issues. */
async function complete(s: Setup) {
  await s.techApi.put("/inspections/sync", payload(s));
  for (const [n, key] of [[1, "overview"], [2, "chlorinator"]] as const) {
    await s.techApi.putImage(photoUrl(payload(s).clientId, n), PNG, { "x-photo-key": key, "content-type": "image/png" });
  }
  const res = await s.techApi.put(
    "/inspections/sync",
    payload(s, {
      status: "completed",
      completedAt: "2026-03-01T15:40:00Z",
      values: { ...completeValues(), notes: "Replaced the air filter. Next visit in four months." },
      issues: [
        { clientId: "6a3f1b2c-1d2e-4f3a-8b4c-5d6e7f8a9b01", type: "pump_out", severity: "low", description: "Sludge at 30%" },
        { clientId: "6a3f1b2c-1d2e-4f3a-8b4c-5d6e7f8a9b02", type: "noncompliance", severity: "high", description: "Spray head in setback" },
      ],
    }),
  );
  expect(res.json().status).toBe("completed");
  return res.json() as { id: string };
}

const snapshots = async (c: TestContext, inspectionId: string) => {
  const rows = await c.db.selectFrom("reports").select(["audience", "snapshot", "sha256"]).where("inspectionId", "=", inspectionId).execute();
  return Object.fromEntries(rows.map((r) => [r.audience, { ...(r.snapshot as ReportSnapshot), sha256: r.sha256 }]));
};

describe("inspection reports", () => {
  it("makes a customer and an authority PDF once the inspection is completed", async () => {
    const s = await setup(ctx);
    const insp = await complete(s);

    const before = (await s.api.get(`/inspections/${insp.id}/reports`)).json();
    expect(before).toEqual({ items: [], pending: true });

    expect(await runWorker(ctx)).toBe(1);
    const after = (await s.api.get(`/inspections/${insp.id}/reports`)).json();
    expect(after.pending).toBe(false);
    expect(after.items.map((r: { audience: string }) => r.audience).sort()).toEqual(["authority", "customer"]);

    const pdf = await client(ctx.app).get(after.items[0].url);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.rawPayload.length).toBe(after.items[0].byteSize);
  });

  it("gives the customer and the authority different copies", async () => {
    const s = await setup(ctx);
    const insp = await complete(s);
    await runWorker(ctx);
    const { customer, authority } = await snapshots(ctx, insp.id);

    const labels = (snap: ReportSnapshot) => snap.sections.flatMap((x) => x.rows.map((r) => r.label));
    expect(labels(customer!)).toContain("Notes for the customer");
    expect(labels(authority!)).not.toContain("Notes for the customer");
    expect(labels(authority!)).toEqual(expect.arrayContaining(["Aerator", "Chlorine level", "Pumping needed"]));

    expect(customer!.photos).toHaveLength(2);
    expect(authority!.photos).toHaveLength(0);
    expect(customer!.issues.map((i) => i.type)).toEqual(["Pump-out needed", "Noncompliance"]);
    expect(authority!.issues.map((i) => i.type)).toEqual(["Noncompliance"]);
    expect(customer!.sha256).not.toBe(authority!.sha256);
  });

  it("never changes a report after a template update, and never makes it twice", async () => {
    const s = await setup(ctx);
    const insp = await complete(s);
    await runWorker(ctx);
    const original = await snapshots(ctx, insp.id);

    const renamed = {
      ...DEFAULT_TEMPLATE.definition,
      fields: DEFAULT_TEMPLATE.definition.fields.map((f) => (f.key === "aerator" ? { ...f, label: "Air pump" } : f)),
    };
    expect((await s.api.post("/inspection-templates", { name: "Renamed", definition: renamed })).statusCode).toBe(201);

    // Running the task again (a retry, or a duplicate) leaves the reports alone.
    expect(await generateReports(ctx.db, ctx.store, s.org.id, insp.id)).toEqual([]);
    expect(await snapshots(ctx, insp.id)).toEqual(original);
    expect(original.customer!.sections[0]!.rows[0]!.label).toBe("Aerator");

    // The stored rows cannot be edited or deleted.
    await expect(sql`update reports set sha256 = 'x'`.execute(ctx.db)).rejects.toThrow(/immutable/);
    await expect(sql`delete from reports`.execute(ctx.db)).rejects.toThrow(/immutable/);
  });

  it("retries report generation after a storage failure", async () => {
    const s = await setup(ctx);
    const insp = await complete(s);
    let failures = 1;
    const flaky: ObjectStore = {
      put: async (key, body, type) => {
        if (key.includes("/reports/") && failures-- > 0) throw new Error("storage unavailable");
        return ctx.store.put(key, body, type);
      },
      get: (key) => ctx.store.get(key),
    };
    await runWorker(ctx, flaky);
    const task = await ctx.db.selectFrom("backgroundTasks").selectAll().executeTakeFirstOrThrow();
    expect(task).toMatchObject({ attempts: 1, completedAt: null, failedAt: null });
    expect(task.lastError).toMatch(/storage unavailable/);

    // Not due yet: the retry waits.
    expect(await runWorker(ctx, flaky)).toBe(0);
    ctx.now = new Date(ctx.now.getTime() + 60_000);
    expect(await runWorker(ctx, flaky)).toBe(1);
    expect((await s.api.get(`/inspections/${insp.id}/reports`)).json().items).toHaveLength(2);
  });

  it("makes reports for an inspection the office accepted, noting why", async () => {
    const s = await setup(ctx);
    const failed = (await s.techApi.put("/inspections/sync", payload(s, { status: "completed", values: completeValues() }))).json();
    const office = await createUser(ctx.db, s.org.id, "office");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    await officeApi.post(`/inspections/${failed.id}/override`, { reason: "Camera broke" });
    await runWorker(ctx);
    const { authority } = await snapshots(ctx, failed.id);
    expect(authority!.inspection).toMatchObject({ validationStatus: "overridden", overrideReason: "Camera broke" });
  });
});

describe("compliance timeline", () => {
  it("records the completed inspection and each report on the site's timeline", async () => {
    const s = await setup(ctx);
    const insp = await complete(s);
    await runWorker(ctx);
    const res = await s.api.get(`/sites/${s.site.id}/compliance-events`);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { eventType: string; inspectionId: string; actorName: string | null; report: { audience: string; url: string } | null }[];
    expect(items.map((e) => e.eventType).sort()).toEqual(["inspection_completed", "report_generated", "report_generated"]);
    expect(items.every((e) => e.inspectionId === insp.id)).toBe(true);
    expect(items.find((e) => e.eventType === "inspection_completed")!.actorName).toBe("technician user");
    const reportEvent = items.find((e) => e.report?.audience === "customer")!;
    expect((await client(ctx.app).get(reportEvent.report!.url)).statusCode).toBe(200);

    await expect(sql`update compliance_events set summary = 'x'`.execute(ctx.db)).rejects.toThrow(/immutable/);
  });
});

describe("report tenancy", () => {
  it("keeps reports, timelines and report links inside their organization", async () => {
    const a = await setup(ctx, "Org A");
    const b = await setup(ctx, "Org B");
    const insp = await complete(a);
    await runWorker(ctx);
    const reports = (await a.api.get(`/inspections/${insp.id}/reports`)).json().items as { id: string; url: string }[];

    expect((await b.api.get(`/inspections/${insp.id}/reports`)).statusCode).toBe(404);
    expect((await b.api.get(`/sites/${a.site.id}/compliance-events`)).statusCode).toBe(404);

    // A valid link for one report cannot be pointed at another, or used as a photo link.
    const query = reports[0]!.url.split("?")[1];
    expect((await client(ctx.app).get(`/report-files/${reports[1]!.id}?${query}`)).statusCode).toBe(404);
    expect((await client(ctx.app).get(`/files/${reports[0]!.id}?${query}`)).statusCode).toBe(404);
    const photo = (await a.api.get(`/inspections/${insp.id}`)).json().photos[0];
    expect((await client(ctx.app).get(`/report-files/${photo.id}?${photo.url.split("?")[1]}`)).statusCode).toBe(404);
  });
});
