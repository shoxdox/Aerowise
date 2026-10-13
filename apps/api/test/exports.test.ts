import { createHash } from "node:crypto";
import { sql } from "kysely";
import { pdfText } from "./pdf-text.ts";
import { JPEG, payload, setup as inspectionSetup, uploadRequiredPhotos } from "./inspection-helpers.ts";
import { drainTasks, EXPORT_TABLES } from "@aerowise/tasks";
import { unzipSync, strFromU8 } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";

const ctx = setupTestApp({ features: ["work_orders", "field_work", "pumping"] });
afterEach(() => vi.restoreAllMocks());

/** Requests an export, runs the worker, and returns the zip's files. */
async function exportZip(c: TestContext, api: ReturnType<typeof client>) {
  const requested = await api.post("/exports", {});
  expect(requested.statusCode).toBe(201);
  expect(requested.json()).toMatchObject({ status: "queued" });
  await drainTasks({ db: c.db, store: c.store, now: () => c.now });
  const res = await api.get(`/exports/${requested.json().id}/download`);
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toBe("application/zip");
  expect(res.headers["content-disposition"]).toBe('attachment; filename="aerowise-export-2026-03-01.zip"');
  return { id: requested.json().id as string, files: unzipSync(new Uint8Array(res.rawPayload)) };
}

const csvRows = (files: Record<string, Uint8Array>, name: string) => strFromU8(files[name]!).trimEnd().split("\r\n");

describe("full data export", () => {
  it("zips every table's rows and the documents of this organization only", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const plan = (await a.api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
    await a.api.post(`/sites/${a.site.id}/contracts`, { planId: plan.id, startOn: "2026-01-01" });
    await a.api.post("/customers", { displayName: "=HYPERLINK(\"http://x\")" });
    const invoice = (await a.api.post("/invoices", { customerId: a.customer.id, lines: [{ description: "Pump out, \"big\" tank", unitPriceCents: 30000 }] })).json();
    expect((await a.api.post(`/invoices/${invoice.id}/issue`, { send: false })).statusCode).toBe(200);
    // The PDF first: under the frozen clock its task and the export's share a run time, so either could run first.
    await drainTasks({ db: ctx.db, store: ctx.store, now: () => ctx.now });
    await b.api.post("/customers", { displayName: "Only in B" });

    const sourceInvoice = await ctx.db.selectFrom("invoices").select("pdfStorageKey").where("id", "=", invoice.id).executeTakeFirstOrThrow();
    const original = (await ctx.store.get(sourceInvoice.pdfStorageKey!))!;
    const token = String((await a.api.get(`/invoices/${invoice.id}`)).json().payUrl).split("/pay/")[1]!;
    expect(pdfText(original).replace(/\s+/g, "")).toContain(token);
    const { files } = await exportZip(ctx, a.api);
    expect(pdfText(Buffer.from(files[`invoices/${invoice.id}.pdf`]!)).replace(/\s+/g, "")).not.toContain(token);
    expect((await ctx.store.get(sourceInvoice.pdfStorageKey!))!.equals(original)).toBe(true);
    const portableManifest = JSON.parse(strFromU8(files["manifest.json"]!));
    expect(portableManifest.assets).toContainEqual(expect.objectContaining({ table: "invoices", rendition: "portable-invoice-without-payment-link", sourceSha256: createHash("sha256").update(original).digest("hex") }));
    expect(Object.keys(files).sort()).toEqual([...EXPORT_TABLES.map((t) => t.file), "README.txt", "manifest.json", "template-versions.json", "staff.json", "company.json", `invoices/${invoice.id}.pdf`].sort());
    const customers = csvRows(files, "customers.csv");
    expect(customers[0]).toMatch(/^id,organization_id,display_name,/);
    expect(customers).toHaveLength(3);
    expect(customers.every((line, i) => i === 0 || line.includes(a.org.id))).toBe(true);
    expect(customers.join("\n")).not.toContain("Only in B");
    // A cell a spreadsheet would run as a formula is defused; quotes and commas survive.
    expect(customers.join("\n")).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csvRows(files, "invoice_lines.csv")[1]).toContain(`"Pump out, ""big"" tank"`);
    expect(csvRows(files, "visits.csv")).toHaveLength(1 + 3);
    expect(csvRows(files, "sites.csv")).toHaveLength(2);
    // The pay-link token is a secret and stays out.
    expect(csvRows(files, "invoices.csv")[0]).not.toContain("public_token");
    expect(strFromU8(files[`invoices/${invoice.id}.pdf`]!.slice(0, 5))).toBe("%PDF-");

    const list = (await a.api.get("/exports")).json().items;
    expect(list).toMatchObject([{ status: "ready", contents: { documents: 1, missing: [] } }]);
    expect(list[0].contents.files).toContainEqual({ file: "customers.csv", rows: 2 });
    // Another organization cannot see or download it.
    expect((await b.api.get("/exports")).json().items).toEqual([]);
    expect((await b.api.get(`/exports/${list[0].id}/download`)).statusCode).toBe(404);
  });

  it("reconciles original inspection/work/manifest bytes, generated summaries, row counts and missing assets", async () => {
    const a = await inspectionSetup(ctx);
    const draft = payload(a);
    expect((await a.techApi.put("/inspections/sync", draft)).statusCode).toBe(200);
    await uploadRequiredPhotos(a, draft.clientId);
    const truck = (await a.api.post("/vehicles", { name: "Export truck" })).json();
    const facility = (await a.api.post("/disposal-facilities", { name: "Export facility", kind: "wastewater_treatment_plant", city: "Austin" })).json();
    const type = (await a.api.get("/work-types")).json().items.find((t: { key: string }) => t.key === "pumping");
    const wo = (await a.api.post("/work-orders", { siteId: a.site.id, workTypeId: type.id })).json();
    const job = (await a.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: a.tech.id, scheduledDate: "2026-03-01" })).json().visits[0].jobId;
    const form = (await a.techApi.get("/form-templates/work-pumping")).json();
    const recordId = crypto.randomUUID();
    const body = { clientId: recordId, jobId: job, templateId: form.id, revision: 1, status: "draft", arrivedAt: "2026-03-01T15:00:00Z", values: { tank_count: 1, lid_condition: "good" }, pumpOut: { clientId: crypto.randomUUID(), volume: 1000, unit: "gallons", wasteType: "septage", vehicleId: truck.id } };
    expect((await a.techApi.put("/work/sync", body)).statusCode).toBe(200);
    const workPhotoId = crypto.randomUUID();
    const photoKey = form.definition.photos[0].key;
    expect((await a.techApi.putImage(`/work/${recordId}/photos/${workPhotoId}`, JPEG, { "x-photo-key": photoKey })).statusCode).toBe(201);
    const completed = await a.techApi.put("/work/sync", { ...body, revision: 2, status: "completed", completedAt: "2026-03-01T16:00:00Z" });
    expect(completed.json(), completed.body).toMatchObject({ status: "completed" });
    const pump = (await a.api.get(`/pumping-records?workOrderId=${wo.id}`)).json().items[0];
    const loadClientId = crypto.randomUUID();
    const delivered = await a.api.put("/disposal/loads/sync", { clientId: loadClientId, vehicleId: truck.id, facilityId: facility.id, deliveredOn: "2026-03-01", manifestReference: "EXPORT-RECEIPT", total: 1000, unit: "gallons", pumpingGroupIds: [pump.groupId] });
    expect(delivered.statusCode, delivered.body).toBe(201);
    const manifestPhotoId = crypto.randomUUID();
    const manifestUpload = await a.api.putImage(`/disposal/loads/${loadClientId}/photos/${manifestPhotoId}`, JPEG);
    expect(manifestUpload.statusCode, manifestUpload.body).toBe(201);
    const assets = await ctx.db.selectFrom("attachments").select(["id", "storageKey"]).where("organizationId", "=", a.org.id).orderBy("id").execute();
    // A missing stored photo is reported, never silently omitted.
    const get = ctx.store.get.bind(ctx.store);
    vi.spyOn(ctx.store, "get").mockImplementation((key) => key === assets[0]!.storageKey ? Promise.resolve(null) : get(key));
    const { files } = await exportZip(ctx, a.api);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
    expect(manifest.missing).toEqual([`inspection-photos/${assets[0]!.id}.jpg`]);
    expect(Buffer.from(files[`inspection-photos/${assets[1]!.id}.jpg`]!).equals(JPEG)).toBe(true);
    const workAssets = await ctx.db.selectFrom("workAttachments").select("id").where("organizationId", "=", a.org.id).execute();
    expect(workAssets).toHaveLength(2);
    for (const photo of workAssets) expect(Buffer.from(files[`work-and-disposal-photos/${photo.id}.jpg`]!).equals(JPEG)).toBe(true);
    expect(strFromU8(files[`work-summaries/${wo.id}.pdf`]!.slice(0, 5))).toBe("%PDF-");
    expect(strFromU8(files["disposal-log.pdf"]!.slice(0, 5))).toBe("%PDF-");
    expect(manifest.assets).toContainEqual(expect.objectContaining({ state: "missing", recordId: assets[0]!.id }));
    for (const entry of manifest.files) {
      expect(files[entry.file]!.length, entry.file).toBe(entry.bytes);
      expect(createHash("sha256").update(files[entry.file]!).digest("hex"), entry.file).toBe(entry.sha256);
    }
    const schemaTables = (await sql<{ name: string }>`select distinct c.table_name as name from information_schema.columns c join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE' where c.table_schema=current_schema() and c.column_name='organization_id' order by 1`.execute(ctx.db)).rows.map((r) => r.name);
    expect(manifest.inventory.map((entry: { table: string }) => entry.table)).toEqual(schemaTables);
    for (const entry of manifest.inventory) {
      expect(["included", "derived", "excluded"]).toContain(entry.state);
      if (entry.state === "included") expect(files[entry.file]).toBeDefined();
      else expect(entry.reason.length).toBeGreaterThan(15);
    }
    expect(strFromU8(files["payments.csv"]!).split("\r\n")[0]).not.toContain("bank_verification_url");
    expect(strFromU8(files["payments.csv"]!).split("\r\n")[0]).toContain("bank_verification_required");
    for (const table of EXPORT_TABLES) {
      const actual = (await sql<{ n: string }>`select count(*) as n from ${sql.table(table.table)} where organization_id = ${a.org.id}`.execute(ctx.db)).rows[0]!.n;
      expect(manifest.tables.find((t: { file: string }) => t.file === table.file).rows, table.file).toBe(Number(actual));
    }
    expect(strFromU8(files["staff.json"]!)).not.toContain("passwordHash");
    expect(strFromU8(files["signed_documents.csv"]!).split("\r\n")[0]).not.toContain("signature_image");
    expect(Object.keys(files)).not.toContain("portal_links.csv");
  });

  it("is for the owner, and works while the organization is read-only", async () => {
    const a = await createTenant(ctx, "Org A");
    const office = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, a.org.id, "office")).email));
    expect((await office.post("/exports", {})).statusCode).toBe(403);
    expect((await office.get("/exports")).statusCode).toBe(403);

    await ctx.db.updateTable("organizations").set({ subscriptionState: "read_only" }).where("id", "=", a.org.id).execute();
    expect((await a.api.post("/customers", { displayName: "New" })).statusCode).toBe(403);
    const { files } = await exportZip(ctx, a.api);
    expect(csvRows(files, "customers.csv")).toHaveLength(2);
  });

  it("builds one export at a time and only offers finished ones", async () => {
    const a = await createTenant(ctx, "Org A");
    const first = (await a.api.post("/exports", {})).json();
    expect((await a.api.post("/exports", {})).json().id).toBe(first.id);
    expect((await a.api.get(`/exports/${first.id}/download`)).statusCode).toBe(409);
    await drainTasks({ db: ctx.db, store: ctx.store, now: () => ctx.now });
    const second = (await a.api.post("/exports", {})).json();
    expect(second.id).not.toBe(first.id);
    const audit = await ctx.db.selectFrom("auditEvents").select("action").where("entityType", "=", "data_export").execute();
    expect(audit.map((e) => e.action)).toEqual(["data_export.requested", "data_export.requested"]);
  });
});
