import type { ReportSnapshot } from "@aerowise/reports";
import { drainTasks } from "@aerowise/tasks";
import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, payload, photoUrl, setup, type Setup } from "./inspection-helpers.ts";

const ctx = setupTestApp();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now });

// A 1×1 PNG: a real image pdfkit can embed.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const uploadLogo = (api: ReturnType<typeof client>, body: Buffer, type = "image/png") => api.putImage("/organization/logo", body, { "content-type": type });

async function completeInspection(s: Setup) {
  await s.techApi.put("/inspections/sync", payload(s));
  for (const [n, key] of [[1, "overview"], [2, "chlorinator"]] as const) {
    await s.techApi.putImage(photoUrl(payload(s).clientId, n), PNG, { "x-photo-key": key, "content-type": "image/png" });
  }
  const res = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: completeValues() }));
  expect(res.json().status).toBe("completed");
  return res.json() as { id: string };
}

async function reportPdfs(s: Setup, inspectionId: string) {
  const items = (await s.api.get(`/inspections/${inspectionId}/reports`)).json().items as { audience: string; url: string }[];
  const out: Record<string, Buffer> = {};
  for (const r of items) out[r.audience] = (await client(ctx.app).get(r.url)).rawPayload;
  return out;
}

const imageCount = (pdf: Buffer) => pdf.toString("latin1").split("/Subtype /Image").length - 1;

describe("organization settings", () => {
  it("lets the owner edit company details and service counties, audited", async () => {
    const t = await createTenant(ctx, "Org A");
    const res = await t.api.patch("/organization/settings", {
      name: "Brazos Aerobic Co",
      phone: "(979) 555-0100",
      email: "office@brazos.example",
      addressLine1: "12 Main St",
      city: "Bryan",
      state: "TX",
      postalCode: "77801",
      serviceCounties: ["Brazos County", " Burleson County ", "brazos county"],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      name: "Brazos Aerobic Co",
      phone: "(979) 555-0100",
      city: "Bryan",
      serviceCounties: ["Brazos County", "Burleson County"],
      hasLogo: false,
      responsibleProvider: null,
    });
    // Blank fields clear; leaving a field out keeps it.
    expect((await t.api.patch("/organization/settings", { phone: "" })).json()).toMatchObject({ phone: null, city: "Bryan" });
    expect((await t.api.patch("/organization/settings", { name: "" })).statusCode).toBe(400);

    const events = await ctx.db.selectFrom("auditEvents").select(["action", "changes"]).where("action", "=", "organization.updated").execute();
    expect(events).toHaveLength(2);
    expect(events[0]!.changes).toMatchObject({ name: "Brazos Aerobic Co" });
  });

  it("shows the responsible MP chosen on the licenses page", async () => {
    const t = await createTenant(ctx, "Org A");
    const mp = (await t.api.post("/credentials", { userId: t.owner.id, holderName: "Owner Person", kind: "tceq_maintenance_provider", number: "MP0001234", verifiedOn: "2026-02-20", verificationSource: "TCEQ license search" })).json();
    expect((await t.api.put("/settings/responsible-provider", { credentialId: mp.id })).statusCode).toBeLessThan(300);
    expect((await t.api.get("/organization/settings")).json().responsibleProvider).toEqual({ id: mp.id, holderName: "Owner Person", number: "MP0001234" });
  });

  it("lets everyone read the settings but only the owner change them", async () => {
    const t = await createTenant(ctx, "Org A");
    for (const role of ["office", "technician", "read_only"] as const) {
      const u = await createUser(ctx.db, t.org.id, role);
      const api = client(ctx.app, await login(ctx.app, u.email));
      expect((await api.get("/organization/settings")).statusCode).toBe(200);
      expect((await api.patch("/organization/settings", { name: "Hijacked" })).statusCode).toBe(403);
      expect((await uploadLogo(api, PNG)).statusCode).toBe(403);
      expect((await api.post("/organization/logo/remove", {})).statusCode).toBe(403);
    }
    expect((await t.api.get("/organization/settings")).json().name).toBe("Org A");
  });

  it("keeps each organization's settings and logo to itself", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    await a.api.patch("/organization/settings", { name: "A Renamed", serviceCounties: ["Travis County"] });
    expect((await uploadLogo(a.api, PNG)).statusCode).toBe(200);
    expect((await b.api.get("/organization/settings")).json()).toMatchObject({ name: "Org B", serviceCounties: [], hasLogo: false });
    expect((await b.api.get("/organization/logo")).statusCode).toBe(404);
    const logo = await a.api.get("/organization/logo");
    expect(logo.headers["content-type"]).toBe("image/png");
    expect(logo.rawPayload.equals(PNG)).toBe(true);
    const keys = await ctx.db.selectFrom("organizations").select(["id", "logoStorageKey"]).execute();
    expect(keys.find((k) => k.id === a.org.id)!.logoStorageKey).toMatch(new RegExp(`^${a.org.id}/logos/`));
  });

  it("refuses files that are not PNG or JPEG", async () => {
    const t = await createTenant(ctx, "Org A");
    expect((await uploadLogo(t.api, Buffer.from("GIF89a....."), "image/png")).statusCode).toBe(422);
    expect((await uploadLogo(t.api, PNG, "image/jpeg")).statusCode).toBe(422);
    expect((await uploadLogo(t.api, Buffer.from("<svg/>"), "image/svg+xml")).statusCode).toBe(415);
    expect((await uploadLogo(t.api, Buffer.alloc(1024 * 1024 + 10, 0x89), "image/png")).statusCode).toBe(413);
  });
});

describe("the logo on reports", () => {
  it("is drawn on new customer and authority PDFs, and old reports keep the logo they were made with", async () => {
    const s = await setup(ctx);
    await runWorker(ctx);
    expect((await uploadLogo(s.api, PNG)).json().hasLogo).toBe(true);
    const insp = await completeInspection(s);
    await runWorker(ctx);

    const pdfs = await reportPdfs(s, insp.id);
    // The authority copy has no photos, so its images are the logo (a PNG with its alpha mask).
    expect(imageCount(pdfs.authority!)).toBeGreaterThan(0);
    expect(imageCount(pdfs.customer!)).toBeGreaterThanOrEqual(1);
    const snapshots = await ctx.db.selectFrom("reports").select(["audience", "snapshot"]).where("inspectionId", "=", insp.id).execute();
    const logoKey = (snapshots[0]!.snapshot as ReportSnapshot).provider.logoKey;
    expect(logoKey).toMatch(/\/logos\/[0-9a-f]{64}\.png$/);
    for (const r of snapshots) expect((r.snapshot as ReportSnapshot).provider.logoKey).toBe(logoKey);

    // Removing the logo changes new reports only; the stored file stays for the old ones.
    await s.api.post("/organization/logo/remove", {});
    expect(await ctx.store.get(logoKey!)).not.toBeNull();
  });

  it("is left off when the company has none", async () => {
    const s = await setup(ctx);
    await runWorker(ctx);
    const insp = await completeInspection(s);
    await runWorker(ctx);
    expect(imageCount((await reportPdfs(s, insp.id)).authority!)).toBe(0);
  });
});
