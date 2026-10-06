import ExcelJS from "exceljs";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { drainTasks } from "@aerowise/tasks";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";

const ctx = setupTestApp();

const pad = (n: number) => String(n).padStart(4, "0");
const PHONE_FORMATS = [(d: string) => `512-555-${d}`, (d: string) => `(512) 555 ${d}`, (d: string) => `+1 512.555.${d}`, (d: string) => `512555${d}`];
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * 500 rows the way they come out of an old system: a BOM, CRLF line ends, a blank line,
 * odd headers, four phone formats, quoted commas, stray spaces, and planted problems.
 * - rows with i % 100 === 42 have no address (5 errors)
 * - rows with i % 100 === 77 repeat the previous row's address as "Rd." (5 duplicates)
 * - row i = 300 is "1 Main St, Austin", already on file for the tenant (1 duplicate)
 * - rows with i % 50 === 7 have a broken email (10 warnings)
 * - rows with i % 10 === 9 are a second site for the previous row's customer
 * - rows with i % 4 === 0 have a plan and a start date
 */
function messyCsv() {
  const header = ["Client Name", "Svc Address", "City", "ST", "Zip", "County", "Permit #", "Phone", "E-mail", "Unit Make", "Plan", "Start Date", "Notes"];
  const lines = [header.join(",")];
  for (let i = 0; i < 500; i++) {
    const owner = i % 10 === 9 ? i - 1 : i;
    const address = i % 100 === 42 ? "" : i % 100 === 77 ? `${100 + i - 1} Oak Rd.` : i === 300 ? "1 Main St" : `${100 + i} Oak Road`;
    const email = i % 50 === 7 ? "not-an-email" : i % 3 === 0 ? ` C${owner}@Example.com ` : "";
    lines.push(
      [
        `  Customer ${owner} `,
        address,
        i % 2 ? "Austin" : "AUSTIN",
        i % 5 ? "TX" : "Texas",
        String(78700 + (i % 50)),
        i % 6 === 0 ? "Example" : "",
        i % 8 === 0 ? `ex-${pad(i)}` : "",
        PHONE_FORMATS[i % 4]!(pad(owner)),
        email,
        i % 3 === 1 ? "Aqua-Safe" : "",
        i % 4 === 0 ? "Annual Aerobic" : "",
        i % 4 === 0 ? "3/1/2026" : "",
        i % 7 === 0 ? "Gate on left, dog in yard" : "",
      ]
        .map(csvCell)
        .join(","),
    );
    if (i === 250) lines.push("");
  }
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${lines.join("\r\n")}\r\n`)]);
}

/**
 * A provider's whole book, 500 rows, as messy as messyCsv, with contract dates and last
 * inspections. Today is 2026-03-01 and the plan is 12 months with a visit every 4 months.
 * Each row's kind is i % 10:
 * 0 ends 2026-03-21, every visit done (last inspection 2025-12-10)
 * 1 ends 2026-04-25, every visit done (last inspection 2026-01-05)
 * 2 ends 2026-05-20, no last inspection: 2 visits overdue
 * 3 started 2025-07-01, last inspected 2025-10-01: 1 visit overdue
 * 4 started 2025-04-01, last inspected 2025-09-15: 1 visit due 2026-03-31, ends that day
 * 5 ended 2026-01-31
 * 6 starts 2026-04-01
 * 7, 8, 9 no contract
 * Rows i % 100 === 42 have no address and i % 100 === 77 repeat the row before, so neither
 * is imported. A third of the rows name Example County (an authority); a quarter have a permit.
 */
function bookCsv() {
  const KINDS: [plan: boolean, start: string, end: string, last: string][] = [
    [true, "", "3/21/2026", "12/10/2025"],
    [true, "", "2026-04-25", "1/5/26"],
    [true, "", "05/20/2026", ""],
    [true, "7/1/2025", "", "2025-10-01"],
    [true, "4/1/2025", "", "9/15/2025"],
    [true, "", "1/31/2026", ""],
    [true, "4/1/2026", "", ""],
    [false, "", "", ""],
    [false, "", "", ""],
    [false, "", "", ""],
  ];
  const lines = ["Account Name,Property Address,City,County,Permit No,Make,Model,Plan,Contract Start,Expires,Last Service"];
  for (let i = 0; i < 500; i++) {
    const [plan, start, end, last] = KINDS[i % 10]!;
    const address = i % 100 === 42 ? "" : i % 100 === 77 ? ` ${200 + i - 1} Cedar Rd. ` : `${200 + i} Cedar Road`;
    lines.push(
      [` Owner ${i} `, address, i % 2 ? "Austin" : "austin", i % 3 === 0 ? "example county" : "", i % 4 === 0 ? `ex-${pad(i)}` : "", i % 3 === 1 ? "Aqua-Safe" : "", i % 3 === 1 ? "AS 500" : "", plan ? (i % 2 ? "annual aerobic" : "Annual Aerobic") : "", start, end, last]
        .map(csvCell)
        .join(","),
    );
    if (i % 125 === 0) lines.push(",,,,,,,,,,");
  }
  return Buffer.from(`${lines.join("\r\n")}\r\n`);
}

type Detail = {
  id: string;
  status: string;
  sheets: { name: string; headers: string[]; rows: number }[];
  sheetIndex: number;
  headers: string[];
  mappingSource: string;
  error: string | null;
  mapping: Record<string, number>;
  summary: Record<string, number>;
  result: { customers: number; sites: number; contracts: number } | null;
  rows: { rowNo: number; status: string; include: boolean; record: Record<string, string | null>; messages: string[]; duplicateOf: { kind: string; rowNo: number | null } | null; result: object | null }[];
};

async function tenant(c: TestContext, name = "Org A") {
  const t = await createTenant(c, name);
  await t.api.post("/plans", { name: "Annual Aerobic", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 });
  const upload = async (filename: string, bytes: Buffer) => t.api.post("/imports", { filename, contentBase64: bytes.toString("base64") });
  return { ...t, upload };
}

const count = async (c: TestContext, table: "customers" | "sites" | "contracts" | "contacts" | "wastewater_systems") =>
  Number((await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(c.db)).rows[0]!.n);

describe("customer import", () => {
  it("previews a messy 500-row CSV, then saves it", async () => {
    const t = await tenant(ctx);
    const res = await t.upload("customers.csv", messyCsv());
    expect(res.statusCode).toBe(201);
    const imp = res.json() as Detail;
    expect(imp.mapping).toEqual({
      customerName: 0,
      addressLine1: 1,
      city: 2,
      state: 3,
      postalCode: 4,
      county: 5,
      permitNumber: 6,
      phone: 7,
      email: 8,
      manufacturer: 9,
      planName: 10,
      contractStart: 11,
      accessNotes: 12,
    });
    expect(imp.summary).toEqual({ rows: 500, ready: 479, warning: 10, duplicate: 6, error: 5, included: 489 });

    const row = (i: number) => imp.rows[i]!;
    expect(row(0)).toMatchObject({
      rowNo: 2,
      status: "ready",
      record: { customerName: "Customer 0", phone: "(512) 555-0000", email: "c0@example.com", state: "TX", county: "Example County", permitNumber: "EX-0000", planName: "Annual Aerobic", contractStart: "2026-03-01", accessNotes: "Gate on left, dog in yard" },
    });
    expect(row(42)).toMatchObject({ status: "error", include: false, messages: ["No service address"] });
    expect(row(77)).toMatchObject({ status: "duplicate", include: false, duplicateOf: { kind: "row", rowNo: 78 } });
    // The blank line after row 250 shifts later row numbers, as it does in the file.
    expect(row(300)).toMatchObject({ rowNo: 303, status: "duplicate", duplicateOf: { kind: "site" } });
    expect(row(7).messages).toEqual(['Email "not-an-email" is not a valid address and was left out']);

    // Nothing is saved before commit.
    expect(await count(ctx, "sites")).toBe(1);

    const done = (await t.api.post(`/imports/${imp.id}/commit`, {})).json() as Detail;
    expect(done.status).toBe("committed");
    expect(done.result).toEqual({ customers: 439, sites: 489, contracts: 124 });
    expect(await count(ctx, "sites")).toBe(1 + 489);
    expect(await count(ctx, "contracts")).toBe(124);
    expect(await count(ctx, "wastewater_systems")).toBe(1 + 164);
    expect(done.rows.filter((r) => r.result).length).toBe(489);
    // The preview of a committed import does not flag its own sites as duplicates.
    expect(done.summary).toMatchObject({ duplicate: 6, error: 5 });

    // The second site joined its customer.
    const sites = (await t.api.get(`/customers?search=${encodeURIComponent("109 Oak Road")}`)).json().items;
    expect(sites).toMatchObject([{ displayName: "Customer 8", siteCount: 2 }]);
    expect((await t.api.post(`/imports/${imp.id}/commit`, {})).statusCode).toBe(409);

    // Importing the same file again finds every site already on file.
    const again = (await t.upload("customers.csv", messyCsv())).json() as Detail;
    expect(again.summary).toMatchObject({ duplicate: 495, error: 5, included: 0 });
  });

  it("reads an Excel workbook with real dates and numbers", async () => {
    const t = await tenant(ctx);
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Customers");
    sheet.addRow(["Name", "Address", "City", "Zip Code", "Mobile", "Plan", "Contract Start", "Serial Number"]);
    sheet.addRow(["Ann Lee", "9 Elm Rd", "Austin", 78701, 5125550100, "Annual Aerobic", new Date(Date.UTC(2026, 3, 1)), "SN-1"]);
    sheet.addRow([{ richText: [{ text: "Bo " }, { text: "Diaz" }] }, "5 Pine Ln", "Austin", 78702, "512 555 0111", null, null, null]);
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const imp = (await t.upload("customers.xlsx", bytes)).json() as Detail;
    expect(imp.mapping).toMatchObject({ customerName: 0, addressLine1: 1, city: 2, postalCode: 3, phone: 4, planName: 5, contractStart: 6, serial: 7 });
    expect(imp.rows.map((r) => r.record)).toMatchObject([
      { customerName: "Ann Lee", postalCode: "78701", phone: "(512) 555-0100", contractStart: "2026-04-01", serial: "SN-1" },
      { customerName: "Bo Diaz", postalCode: "78702", phone: "(512) 555-0111", contractStart: null },
    ]);
    const done = (await t.api.post(`/imports/${imp.id}/commit`, {})).json() as Detail;
    expect(done.result).toEqual({ customers: 2, sites: 2, contracts: 1 });
  });

  it("reads every sheet of a workbook and imports the one chosen", async () => {
    const t = await tenant(ctx);
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Read me").addRow(["Exported from OldSoft"]);
    const old = book.addWorksheet("Cancelled");
    old.addRow(["Who", "Notes"]);
    old.addRow(["Zed Old", "moved away"]);
    const sheet = book.addWorksheet("Active");
    sheet.addRow(["Name", "Address", "City"]);
    sheet.addRow(["Ann Lee", "9 Elm Rd", "Austin"]);
    sheet.addRow(["Bo Diaz", "5 Pine Ln", "Austin"]);
    book.addWorksheet("Empty");
    let imp = (await t.upload("book.xlsx", Buffer.from(await book.xlsx.writeBuffer()))).json() as Detail;
    // Sheets with no data are left out, and the preview opens on the customer list.
    expect(imp.sheets).toEqual([
      { name: "Cancelled", headers: ["Who", "Notes"], rows: 1 },
      { name: "Active", headers: ["Name", "Address", "City"], rows: 2 },
    ]);
    expect(imp).toMatchObject({ sheetIndex: 1, headers: ["Name", "Address", "City"], mapping: { customerName: 0, addressLine1: 1, city: 2 } });
    expect(imp.rows.map((r) => r.record.customerName)).toEqual(["Ann Lee", "Bo Diaz"]);

    imp = (await t.api.put(`/imports/${imp.id}/sheet`, { sheetIndex: 0 })).json();
    expect(imp).toMatchObject({ sheetIndex: 0, headers: ["Who", "Notes"], summary: { rows: 1, error: 1 } });
    expect((await t.api.put(`/imports/${imp.id}/sheet`, { sheetIndex: 2 })).statusCode).toBe(422);

    imp = (await t.api.put(`/imports/${imp.id}/sheet`, { sheetIndex: 1 })).json();
    expect(imp.summary).toMatchObject({ rows: 2, ready: 2 });
    const done = (await t.api.post(`/imports/${imp.id}/commit`, {})).json() as Detail;
    expect(done.result).toEqual({ customers: 2, sites: 2, contracts: 0 });
    expect((await t.api.put(`/imports/${imp.id}/sheet`, { sheetIndex: 0 })).statusCode).toBe(409);
    expect((await t.api.get("/imports")).json().items).toMatchObject([{ id: imp.id, rows: 2 }]);
    const audit = await ctx.db.selectFrom("auditEvents").select("action").where("entityId", "=", imp.id).orderBy("id").execute();
    expect(audit.map((a) => a.action)).toEqual(["import.created", "import.sheet_changed", "import.sheet_changed", "import.committed"]);
  });

  it("offers the column choices saved with the last import", async () => {
    const t = await tenant(ctx);
    const csv = "Owner,Where,Town,Other\nAnn Lee,9 Elm Rd,Austin,x\n";
    const first = (await t.upload("c.csv", Buffer.from(csv))).json() as Detail;
    expect(first).toMatchObject({ mappingSource: "detected", mapping: { customerName: 0, city: 2 } });
    const fixed = (await t.api.put(`/imports/${first.id}/mapping`, { mapping: { customerName: 0, addressLine1: 1, city: 2, accessNotes: 3 } })).json();
    expect(fixed.mappingSource).toBe("edited");
    await t.api.post(`/imports/${first.id}/commit`, {});

    // The same layout, typed differently, gets exactly the saved choices.
    const same = (await t.upload("c2.csv", Buffer.from("owner, where ,TOWN,other\nBo Diaz,5 Pine Ln,Austin,y\n"))).json() as Detail;
    expect(same).toMatchObject({ mappingSource: "saved", mapping: { customerName: 0, addressLine1: 1, city: 2, accessNotes: 3 }, summary: { ready: 1 } });

    // Another layout gets the saved choices whose headers it has, and detection for the rest.
    const other = (await t.upload("c3.csv", Buffer.from("Phone,Where,Owner,City\n512-555-0100,2 Oak Dr,Cy Moss,Austin\n"))).json() as Detail;
    expect(other).toMatchObject({ mappingSource: "saved", mapping: { phone: 0, addressLine1: 1, customerName: 2, city: 3 } });

    // Saved choices belong to the organization that made them.
    const b = await tenant(ctx, "Org B");
    const theirs = (await b.upload("c.csv", Buffer.from(csv))).json() as Detail;
    expect(theirs).toMatchObject({ mappingSource: "detected", mapping: { customerName: 0, city: 2 } });
    const saved = await ctx.db.selectFrom("importMappings").select(["organizationId", "columns"]).execute();
    expect(saved).toEqual([
      {
        organizationId: t.org.id,
        columns: [
          { field: "customerName", header: "Owner" },
          { field: "addressLine1", header: "Where" },
          { field: "city", header: "Town" },
          { field: "accessNotes", header: "Other" },
        ],
      },
    ]);
  });

  it("imports contracts mid-term so renewals and overdue visits show at once", async () => {
    const t = await tenant(ctx);
    // Today is 2026-03-01. The plan is 12 months with a visit every 4 months.
    const csv = [
      "Name,Address,City,Plan,Contract End,Last Inspection,Start Date,Permit #,Make,Model",
      // Ends in 20 days; every visit of its term was done before Aerowise.
      "Renew Soon,1 R St,Austin,Annual Aerobic,3/21/2026,12/10/2025,,p-1,Aqua,AS-500",
      // Last inspected 5 months ago in its first window; the second window closed yesterday.
      "Over Due,2 O St,Austin,Annual Aerobic,,10/1/2025,7/1/2025,,,",
      // Ended a month ago.
      "Long Gone,3 E St,Austin,Annual Aerobic,1/31/2026,,,,,",
      // Starts today.
      "Brand New,4 N St,Austin,Annual Aerobic,,,3/1/2026,,,",
    ].join("\n");
    const imp = (await t.upload("c.csv", Buffer.from(csv))).json() as Detail;
    expect(imp.mapping).toMatchObject({ contractEnd: 4, lastInspection: 5, contractStart: 6, permitNumber: 7, manufacturer: 8, model: 9 });
    expect(imp.rows.map((r) => [r.record.contractStart, r.record.contractEnd])).toEqual([
      ["2025-03-22", "2026-03-21"],
      ["2025-07-01", "2026-06-30"],
      ["2025-02-01", "2026-01-31"],
      ["2026-03-01", "2027-02-28"],
    ]);
    const done = (await t.api.post(`/imports/${imp.id}/commit`, {})).json() as Detail;
    expect(done.result).toEqual({ customers: 4, sites: 4, contracts: 4 });

    // The contract ending in 20 days is waiting for its renewal; the ended one is not.
    expect((await t.api.get("/renewals")).json().notStarted).toBe(1);
    const created = (await t.api.post("/renewals/campaign", {})).json().created;
    expect(created).toBe(1);

    // Only the visit missed since the last inspection is overdue.
    const overdue = (await t.api.get("/obligations/due?overdueOnly=true")).json();
    expect(overdue.items).toMatchObject([{ dueOn: "2026-02-28", overdue: true, customer: { displayName: "Over Due" } }]);
    const due = (await t.api.get("/obligations/due?through=2027-03-01")).json();
    expect(due.items.map((o: { customer: { displayName: string }; dueOn: string }) => `${o.customer.displayName} ${o.dueOn}`).sort((a: string, b: string) => a.slice(-10).localeCompare(b.slice(-10)) || a.localeCompare(b))).toEqual([
      "Over Due 2026-02-28",
      "Brand New 2026-06-30",
      "Over Due 2026-06-30",
      "Brand New 2026-10-31",
      "Brand New 2027-02-28",
    ]);
    const visits = await ctx.db
      .selectFrom("serviceObligations as o")
      .innerJoin("customers as c", (j) => j.on((eb) => eb.exists(eb.selectFrom("sites as s").select("s.id").whereRef("s.id", "=", "o.siteId").whereRef("s.customerId", "=", "c.id"))))
      .select(["c.displayName", "o.status", "o.completedByImport"])
      .orderBy("c.displayName")
      .orderBy("o.sequence")
      .execute();
    const byCustomer = (name: string) => visits.filter((v) => v.displayName === name).map((v) => `${v.status}${v.completedByImport === imp.id ? " by import" : ""}`);
    expect(byCustomer("Renew Soon")).toEqual(["completed by import", "completed by import", "completed by import"]);
    expect(byCustomer("Over Due")).toEqual(["completed by import", "open", "open"]);
    expect(byCustomer("Long Gone")).toEqual(["cancelled by import", "cancelled by import", "cancelled by import"]);
    expect(byCustomer("Brand New")).toEqual(["open", "open", "open"]);

    const site = await ctx.db.selectFrom("sites").select(["id", "permitNumber"]).where("addressLine1", "=", "1 R St").executeTakeFirstOrThrow();
    expect(site.permitNumber).toBe("P-1");
    expect(await ctx.db.selectFrom("wastewaterSystems").select(["manufacturer", "model"]).where("siteId", "=", site.id).execute()).toEqual([{ manufacturer: "Aqua", model: "AS-500" }]);
  });

  it("undoes a saved import while nothing has been done with it", async () => {
    const t = await tenant(ctx);
    const existing = (await t.api.post("/customers", { displayName: "Ann Lee" })).json();
    await t.api.post(`/customers/${existing.id}/contacts`, { name: "Ann Lee", phone: "(512) 555-0100" });
    const before = { customers: await count(ctx, "customers"), sites: await count(ctx, "sites"), contacts: await count(ctx, "contacts"), systems: await count(ctx, "wastewater_systems") };
    const csv = "Name,Address,City,Phone,Make,Plan,Start Date,Last Inspection\nAnn Lee,9 Elm Rd,Austin,512.555.0100,Aqua,Annual Aerobic,7/1/2025,10/1/2025\nBo Diaz,5 Pine Ln,Austin,512.555.0111,,Annual Aerobic,3/1/2026,\n";
    const imp = (await t.upload("c.csv", Buffer.from(csv))).json() as Detail;
    // Nothing to undo before it is saved.
    expect((await t.api.get(`/imports/${imp.id}/undo`)).json()).toMatchObject({ canUndo: false, reason: "Only a saved import can be undone" });
    await t.api.post(`/imports/${imp.id}/commit`, {});
    await drainTasks({ db: ctx.db, store: ctx.store, now: () => ctx.now });

    expect((await t.api.get(`/imports/${imp.id}/undo`)).json()).toEqual({ canUndo: true, reason: null, removes: { customers: 1, sites: 2, contracts: 2, visits: 6 }, blockers: [] });
    // Editing what was imported is not work that blocks undo.
    const bo = (await t.api.get("/customers?search=Bo%20Diaz")).json().items[0];
    await t.api.patch(`/customers/${bo.id}`, { notes: "prefers texts" });

    const undone = (await t.api.post(`/imports/${imp.id}/undo`, {})).json() as Detail;
    expect(undone).toMatchObject({ status: "undone", result: { customers: 1, sites: 2, contracts: 2 } });
    expect(undone.rows.every((r) => r.result === null)).toBe(true);
    expect({ customers: await count(ctx, "customers"), sites: await count(ctx, "sites"), contacts: await count(ctx, "contacts"), systems: await count(ctx, "wastewater_systems") }).toEqual(before);
    expect(await count(ctx, "contracts")).toBe(0);
    expect((await t.api.post(`/imports/${imp.id}/undo`, {})).statusCode).toBe(409);
    expect((await t.api.get("/imports")).json().items).toMatchObject([{ id: imp.id, status: "undone" }]);
    const audit = await ctx.db.selectFrom("auditEvents").select(["action", "changes"]).where("entityId", "=", imp.id).where("action", "=", "import.undone").execute();
    expect(audit).toMatchObject([{ changes: { customers: 1, sites: 2, contracts: 2, visits: 6 } }]);
    // The same file can be imported again.
    const again = (await t.upload("c.csv", Buffer.from(csv))).json() as Detail;
    expect(again.summary).toMatchObject({ ready: 2, duplicate: 0 });
  });

  it("lists exactly the work that stops an undo", async () => {
    const s = await tenant(ctx);
    const csv = "Name,Address,City,Plan,Start Date\nAnn Lee,9 Elm Rd,Austin,Annual Aerobic,12/1/2025\nBo Diaz,5 Pine Ln,Austin,,\nCy Moss,7 Oak Dr,Austin,Annual Aerobic,1/15/2026\n";
    const imp = (await s.upload("c.csv", Buffer.from(csv))).json() as Detail;
    const saved = (await s.api.post(`/imports/${imp.id}/commit`, {})).json() as Detail;
    const [ann, bo, cy] = saved.rows.map((r) => r.result as { customerId: string; siteId: string; contractId: string | null });
    const check = async () => (await s.api.get(`/imports/${imp.id}/undo`)).json();

    // A visit scheduled and inspected.
    const tech = await createUser(ctx.db, s.org.id, "technician");
    const techApi = client(ctx.app, await login(ctx.app, tech.email));
    const visit = (await s.api.get(`/contracts/${ann!.contractId}`)).json().obligations[0];
    const job = (await s.api.post("/jobs", { obligationId: visit.id, technicianId: tech.id, scheduledDate: "2026-03-01" })).json();
    const template = (await techApi.get("/inspection-template")).json();
    expect(
      (
        await techApi.put("/inspections/sync", {
          clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d01",
          jobId: job.jobId,
          templateId: template.id,
          status: "draft",
          arrivedAt: "2026-03-01T15:00:00Z",
          values: { aerator: "pass" },
        })
      ).statusCode,
    ).toBeLessThan(300);
    // An invoice, a site added to an imported customer, and a renewal of an imported contract.
    await s.api.post("/invoices", { customerId: bo!.customerId, lines: [{ description: "Pump out", unitPriceCents: 30000 }] });
    await s.api.post(`/customers/${bo!.customerId}/sites`, { addressLine1: "6 Pine Ln", city: "Austin" });
    expect((await s.api.post(`/contracts/${cy!.contractId}/renewal`, { send: false })).statusCode).toBeLessThan(300);

    const blocked = await check();
    expect(blocked).toMatchObject({ canUndo: false, reason: null });
    expect(Object.fromEntries(blocked.blockers.map((b: { table: string; label: string }) => [b.table, b.label]))).toEqual({
      jobs: "1 scheduled visit",
      inspections: "1 inspection",
      invoices: "1 invoice",
      sites: "1 site added to an imported customer",
      renewals: "1 renewal",
    });
    const res = await s.api.post(`/imports/${imp.id}/undo`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("1 scheduled visit");
    expect(await count(ctx, "contracts")).toBe(2);

    // A filing on an imported site blocks it too.
    for (const table of ["inspection_values", "inspections", "jobs", "invoice_lines", "invoices", "renewals"]) await sql`delete from ${sql.table(table)}`.execute(ctx.db);
    await ctx.db.deleteFrom("sites").where("addressLine1", "=", "6 Pine Ln").execute();
    expect((await check()).blockers).toEqual([]);
    // A contract filing: the authority is told about an imported contract.
    await sql`insert into filings (organization_id, site_id, contract_id, kind, status, state_machine_version)
      values (${s.org.id}, ${cy!.siteId}, ${cy!.contractId}, 'contract', 'pending', 1)`.execute(ctx.db);
    expect((await check()).blockers).toEqual([{ table: "filings", label: "1 filing", count: 1 }]);
  });

  it("shows the onboarding summary of a messy 500-row book", async () => {
    const t = await tenant(ctx);
    const imp = (await t.upload("book.csv", bookCsv())).json() as Detail;
    expect(imp.mapping).toMatchObject({ customerName: 0, addressLine1: 1, city: 2, county: 3, permitNumber: 4, manufacturer: 5, model: 6, planName: 7, contractStart: 8, contractEnd: 9, lastInspection: 10 });
    expect(imp.summary).toMatchObject({ rows: 500, error: 5, duplicate: 5, included: 490 });
    // What the import and the summary should say, from the rules the book was built with.
    const imported = Array.from({ length: 500 }, (_, i) => i).filter((i) => i % 100 !== 42 && i % 100 !== 77);
    const kinds = (...ks: number[]) => imported.filter((i) => ks.includes(i % 10)).length;
    const done = (await t.api.post(`/imports/${imp.id}/commit`, {})).json() as Detail;
    expect(done.result).toEqual({ customers: 490, sites: 490, contracts: kinds(0, 1, 2, 3, 4, 5, 6) });
    const summary = (await t.api.get(`/onboarding/summary?importId=${imp.id}`)).json();
    expect(summary).toMatchObject({
      importId: imp.id,
      today: "2026-03-01",
      customers: 490,
      sites: 490,
      activeContracts: kinds(0, 1, 2, 3, 4),
      expiring: { within30: kinds(0, 4), within60: kinds(0, 1, 4), within90: kinds(0, 1, 2, 4) },
      overdueVisits: 2 * kinds(2) + kinds(3),
      dueThisMonth: kinds(4),
      sitesWithoutAuthority: imported.filter((i) => i % 3 !== 0).length,
      sitesWithoutPermit: imported.filter((i) => i % 4 !== 0).length,
    });
    expect(summary.examples.withoutAuthority).toHaveLength(10);
    expect(summary.examples.withoutPermit[0]).toMatchObject({ customerName: "Owner 1", addressLine1: "201 Cedar Road" });

    // The whole organization also counts what was there before.
    const all = (await t.api.get("/onboarding/summary")).json();
    expect(all).toMatchObject({ importId: null, sites: 491, customers: 491, activeContracts: summary.activeContracts });

    // Another organization sees neither the import nor its records.
    const b = await tenant(ctx, "Org B");
    expect((await b.api.get(`/onboarding/summary?importId=${imp.id}`)).statusCode).toBe(404);
    expect((await b.api.get("/onboarding/summary")).json()).toMatchObject({ sites: 1, activeContracts: 0, overdueVisits: 0 });
  });

  it("lets the office fix the mapping and choose rows", async () => {
    const t = await tenant(ctx);
    const csv = "Owner,Where,Town,Other\nAnn Lee,9 Elm Rd,Austin,x\nBo Diaz,1 Main St,Austin,y\nCy Moss,2 Oak Dr,Austin,z\n";
    let imp = (await t.upload("c.csv", Buffer.from(csv))).json() as Detail;
    // "Where" is not a known header, so there is no address yet.
    expect(imp.mapping).toEqual({ customerName: 0, city: 2 });
    expect(imp.summary.error).toBe(3);

    expect((await t.api.put(`/imports/${imp.id}/mapping`, { mapping: { customerName: 0, addressLine1: 0 } })).statusCode).toBe(422);
    imp = (await t.api.put(`/imports/${imp.id}/mapping`, { mapping: { customerName: 0, addressLine1: 1, city: 2 } })).json();
    expect(imp.summary).toMatchObject({ ready: 2, duplicate: 1, included: 2 });

    imp = (await t.api.post(`/imports/${imp.id}/rows`, { include: [3], exclude: [4] })).json();
    expect(imp.rows.map((r) => r.include)).toEqual([true, true, false]);
    const done = (await t.api.post(`/imports/${imp.id}/commit`, {})).json() as Detail;
    expect(done.result).toEqual({ customers: 2, sites: 2, contracts: 0 });
  });

  it("adds sites to a customer already on file when name and phone match", async () => {
    const t = await tenant(ctx);
    const existing = (await t.api.post("/customers", { displayName: "Ann Lee" })).json();
    await t.api.post(`/customers/${existing.id}/contacts`, { name: "Ann Lee", phone: "(512) 555-0100" });
    const csv = "Name,Address,City,Phone\nAnn Lee,9 Elm Rd,Austin,512.555.0100\nAnn Lee,4 Elm Rd,Austin,512.555.0199\n";
    const imp = (await t.upload("c.csv", Buffer.from(csv))).json();
    expect(imp.rows[0]).toMatchObject({ status: "ready", existingCustomer: { id: existing.id } });
    expect(imp.rows[1]).toMatchObject({ status: "warning", existingCustomer: null });
    expect(imp.rows[1].messages[0]).toContain("already exists with a different phone and email");
    const done = (await t.api.post(`/imports/${imp.id}/commit`, {})).json() as Detail;
    expect(done.result).toMatchObject({ customers: 1, sites: 2 });
  });

  it("saves nothing when any row fails, and can be retried", async () => {
    const t = await tenant(ctx);
    const before = { customers: await count(ctx, "customers"), sites: await count(ctx, "sites"), contacts: await count(ctx, "contacts") };
    const imp = (await t.upload("customers.csv", messyCsv())).json() as Detail;
    // A database failure halfway through the rows.
    await sql`create function import_test_fail() returns trigger language plpgsql as $$
      begin if new.address_line1 = '350 Oak Road' then raise exception 'disk full while saving 350 Oak Road'; end if; return new; end $$`.execute(ctx.db);
    await sql`create trigger import_test_fail before insert on sites for each row execute function import_test_fail()`.execute(ctx.db);
    try {
      const res = await t.api.post(`/imports/${imp.id}/commit`, {});
      expect(res.statusCode).toBe(422);
      expect(res.json().message).toBe("Nothing was imported: disk full while saving 350 Oak Road");
    } finally {
      await sql`drop trigger import_test_fail on sites`.execute(ctx.db);
      await sql`drop function import_test_fail()`.execute(ctx.db);
    }
    expect({ customers: await count(ctx, "customers"), sites: await count(ctx, "sites"), contacts: await count(ctx, "contacts") }).toEqual(before);
    expect(await count(ctx, "contracts")).toBe(0);
    const failed = (await t.api.get(`/imports/${imp.id}`)).json() as Detail;
    expect(failed).toMatchObject({ status: "failed", error: "disk full while saving 350 Oak Road", result: null });
    expect(failed.rows.every((r) => r.result === null)).toBe(true);

    const retry = (await t.api.post(`/imports/${imp.id}/commit`, {})).json() as Detail;
    expect(retry).toMatchObject({ status: "committed", error: null, result: { sites: 489 } });
    const audit = await ctx.db.selectFrom("auditEvents").select("action").where("entityId", "=", imp.id).orderBy("id").execute();
    expect(audit.map((a) => a.action)).toEqual(["import.created", "import.failed", "import.committed"]);
  });

  it("rejects files it cannot read", async () => {
    const t = await tenant(ctx);
    expect((await t.upload("c.csv", Buffer.from("Name,Address\n"))).json().message).toBe("The file has a header row but no data");
    expect((await t.upload("old.xls", Buffer.from("whatever"))).statusCode).toBe(422);
    expect((await t.upload("broken.xlsx", Buffer.from("PK\u0003\u0004 not really a zip"))).statusCode).toBe(422);
  });

  it("can be discarded before commit", async () => {
    const t = await tenant(ctx);
    const imp = (await t.upload("c.csv", Buffer.from("Name,Address,City\nAnn,9 Elm Rd,Austin\n"))).json();
    expect((await t.api.post(`/imports/${imp.id}/discard`, {})).json().status).toBe("discarded");
    expect((await t.api.post(`/imports/${imp.id}/commit`, {})).statusCode).toBe(409);
    const list = (await t.api.get("/imports")).json().items;
    expect(list).toMatchObject([{ id: imp.id, status: "discarded", rows: 1 }]);
  });
});

describe("import access", () => {
  it("keeps each organization's imports to itself", async () => {
    const a = await tenant(ctx, "Org A");
    const b = await tenant(ctx, "Org B");
    const imp = (await a.upload("c.csv", Buffer.from("Name,Address,City\nAnn,1 Main St,Austin\n"))).json() as Detail;
    // Both have a "1 Main St" site; only Org A's own counts.
    expect(imp.rows[0]!.duplicateOf).toMatchObject({ kind: "site" });
    expect((await b.api.get(`/imports/${imp.id}`)).statusCode).toBe(404);
    expect((await b.api.post(`/imports/${imp.id}/commit`, {})).statusCode).toBe(404);
    expect((await b.api.get("/imports")).json().items).toEqual([]);
  });

  it("is for people who can edit customers", async () => {
    const t = await tenant(ctx);
    const tech = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, t.org.id, "technician")).email));
    expect((await tech.post("/imports", { filename: "c.csv", contentBase64: "YQ==" })).statusCode).toBe(403);
    expect((await tech.get("/imports")).statusCode).toBe(403);
  });
});
