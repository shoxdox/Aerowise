import { drainTasks } from "@aerowise/tasks";
import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";

const ctx = setupTestApp();

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

    const { files } = await exportZip(ctx, a.api);
    expect(Object.keys(files).sort()).toEqual(
      [
        "README.txt",
        "contacts.csv",
        "contracts.csv",
        "customers.csv",
        "inspection_values.csv",
        "inspections.csv",
        `invoices/${invoice.id}.pdf`,
        "invoice_lines.csv",
        "invoices.csv",
        "jobs.csv",
        "payments.csv",
        "sites.csv",
        "systems.csv",
        "service_items.csv",
        "visits.csv",
        "work_order_events.csv",
        "work_order_lines.csv",
        "work_order_notes.csv",
        "work_orders.csv",
        "work_records.csv",
        "work_photos.csv",
        "work_held_records.csv",
        "work_assignments.csv",
        "work_types.csv",
      ].sort(),
    );
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
