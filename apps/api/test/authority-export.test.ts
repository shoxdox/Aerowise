import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTHORITY_CSV_DEMO_COLUMN, authorityCsv, bundledRulesets, csvCell, syncRulesets } from "@aerowise/compliance";
import { profileStatus, rulesetRules, type RulesetRules } from "@aerowise/domain";
import { DEMO_WATERMARK } from "@aerowise/reports";
import { DEMO_CSV_COLUMN, drainTasks } from "@aerowise/tasks";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { client, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, payload, setup, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

// SW-11: an authority's CSV export, tested only with fictional rules. Today is 2026-03-01
// (setupTestApp's clock) and inspections complete that day.
const ctx = setupTestApp();
const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });
const later = (c: TestContext, ms: number) => (c.now = new Date(c.now.getTime() + ms));

const RULESET_DIR = fileURLToPath(new URL("../../../packages/compliance/rulesets", import.meta.url));
const load = (key: string, v = 1) => JSON.parse(readFileSync(join(RULESET_DIR, key, `v${v}.json`), "utf8"));
const EXAMPLE_V2 = load("tx-example-county", 2);

/** A fictional authority that takes filings only as a CSV upload on its portal. */
const CSV_COUNTY = "CSV Fixture County";
const csvFixture: RulesetRules = rulesetRules.parse({
  ...EXAMPLE_V2,
  jurisdiction: { ...EXAMPLE_V2.jurisdiction, key: "tx-fixture-csv", authorityName: "CSV Fixture County Health (fictional)" },
  version: 1,
  sourceReference: "FICTIONAL: CSV Fixture County, made up for the export framework tests",
  applicability: { counties: [CSV_COUNTY] },
  identifiers: [{ key: "parcel_id", label: "Parcel ID", required: false }],
  submission: { method: "csv_export", fallback: "manual_export", portalUrl: "https://portal.csv-fixture.example/upload" },
  export: {
    ...EXAMPLE_V2.export,
    formReference: "FICTIONAL: CSV Fixture County upload layout",
    encoding: "utf-8-bom",
    dateFormat: "YYYY-MM-DD",
    filename: "csv-fixture-{permitNumber}.csv",
    columns: [...EXAMPLE_V2.export.columns, { header: "Parcel", source: "identifier", identifier: "parcel_id", required: false }],
  },
});
/** The same authority's rules with no CSV layout, emailed. */
const NO_EXPORT_COUNTY = "Plain Fixture County";
const noExportFixture: RulesetRules = rulesetRules.parse({
  ...load("tx-example-county"),
  jurisdiction: { ...EXAMPLE_V2.jurisdiction, key: "tx-fixture-plain", authorityName: "Plain Fixture County Health (fictional)" },
  sourceReference: "FICTIONAL: Plain Fixture County, made up for the export framework tests",
  applicability: { counties: [NO_EXPORT_COUNTY] },
});

beforeEach(async () => {
  mail.mode = "ok";
  mail.delivered.clear();
  await syncRulesets(ctx.db, [csvFixture, noExportFixture]);
});

// Other test files list the authorities, so leave only the bundled ones behind.
afterAll(async () => {
  await sql`truncate jurisdiction_rulesets, jurisdictions cascade`.execute(ctx.db);
  await syncRulesets(ctx.db);
});

/** `setup` for a demo company, which is demo from the moment it is made. */
async function demoSetup(c: TestContext): Promise<Setup> {
  const org = await c.db.insertInto("organizations").values({ name: "Demo Co (demo)", demo: true } as never).returning("id").executeTakeFirstOrThrow();
  const owner = await createUser(c.db, org.id, "owner");
  const cookie = await login(c.app, owner.email);
  const api = client(c.app, cookie);
  const customer = (await api.post("/customers", { displayName: "Demo customer" })).json();
  const site = (await api.post(`/customers/${customer.id}/sites`, { addressLine1: "1 Main St", city: "Austin" })).json();
  const plan = (await api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
  const contract = (await api.post(`/sites/${site.id}/contracts`, { planId: plan.id, startOn: "2025-12-01" })).json();
  const tech = await createUser(c.db, org.id, "technician");
  const techApi = client(c.app, await login(c.app, tech.email));
  const visit = contract.obligations[0];
  const job = (await api.post("/jobs", { obligationId: visit.id, technicianId: tech.id, scheduledDate: "2026-03-01" })).json();
  const template = (await techApi.get("/inspection-template")).json();
  return { org, owner, cookie, api, customer, site, contact: null, system: null, contract, tech, techApi, visit, job, template } as unknown as Setup;
}

/** A completed inspection at a site in `county`, by a licensed technician, with a permit number. */
async function inspected(c: TestContext, county: string, opts: { name?: string; permit?: string | null; values?: Record<string, unknown>; demo?: boolean } = {}) {
  const s = opts.demo ? await demoSetup(c) : await setup(c, opts.name ?? "Org A");
  const permit = opts.permit === undefined ? "EX-1234" : opts.permit;
  expect((await s.api.patch(`/sites/${s.site.id}`, { county, permitNumber: permit })).statusCode).toBe(200);
  await c.db.updateTable("memberships").set({ technicianLicense: "MP-0001" }).where("userId", "=", s.tech.id).execute();
  const p = payload(s);
  await s.techApi.put("/inspections/sync", p);
  await uploadRequiredPhotos(s, p.clientId);
  const values = opts.values ?? { ...completeValues(), air_pressure: 4.5 };
  const done = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values }));
  expect(done.json().status).toBe("completed");
  return s;
}

const filingOf = async (s: Setup) => (await s.api.get("/filings?view=all")).json().items[0] as { id: string; status: string };
const detailOf = async (s: Setup, id: string) => (await s.api.get(`/filings/${id}`)).json();
const events = async (s: Setup) => (await s.api.get(`/sites/${s.site.id}/compliance-events`)).json().items as { eventType: string; summary: string }[];
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const download = async (c: TestContext, url: string) => {
  const res = await c.app.inject({ method: "GET", url });
  expect(res.statusCode).toBe(200);
  return res;
};
/** The CSV's rows as cells (no quoted commas in these fixtures). */
const rows = (text: string) =>
  text
    .replace(/^\uFEFF/, "")
    .split("\r\n")
    .filter(Boolean)
    .map((l) => l.split(","));

describe("filing by CSV export", () => {
  it("puts the authority's CSV in the package; the filing stays ready until marked filed, and confirmed only with the acknowledgment", async () => {
    const s = await inspected(ctx, CSV_COUNTY);
    await ctx.db.insertInto("siteAuthorityIdentifiers").values({ organizationId: s.org.id, siteId: s.site.id, jurisdictionId: (await ctx.db.selectFrom("jurisdictions").select("id").where("key", "=", "tx-fixture-csv").executeTakeFirstOrThrow()).id, kind: "parcel_id", value: "P-77" }).execute();
    const calls = mail.calls;
    await runWorker(ctx);
    const f = await filingOf(s);
    const ready = await detailOf(s, f.id);
    // Made, not sent: no email, no attempt, no sent date.
    expect(ready).toMatchObject({ status: "ready", submissionMethod: "csv_export", sentAt: null, proof: null, attempts: [] });
    expect(mail.calls).toBe(calls);
    expect(ready.package).toMatchObject({ portalUrl: "https://portal.csv-fixture.example/upload", csvExport: { formReference: "FICTIONAL: CSV Fixture County upload layout" }, csvUrl: expect.stringMatching(/^\/package-files\//), reportUrl: expect.stringMatching(/^\/package-files\//) });
    expect(ready.packages).toHaveLength(1);
    const pkg = ready.packages[0];
    expect(pkg.method).toBe("csv_export");
    expect(pkg.documents.map((d: { role: string }) => d.role)).toEqual(["inspection_report", "authority_csv"]);
    const doc = pkg.documents[1];
    expect(doc).toMatchObject({ filename: "csv-fixture-EX-1234.csv", contentType: "text/csv; charset=utf-8" });
    expect(ready.package.reportUrl).toBe(pkg.documents[0].url);

    const res = await download(ctx, ready.package.csvUrl);
    expect(res.headers["content-type"]).toContain("text/csv");
    const bytes = res.rawPayload;
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(sha256(bytes)).toBe(doc.sha256);
    const [header, row] = rows(bytes.toString("utf8"));
    expect(header).toEqual(["Record Type", "Permit Number", "Inspection Date", "Owner Name", "Site Address", "City", "ZIP", "Maintenance Provider", "Technician", "Technician License", "Air Pressure", "Chlorine Level", "Submitted", "Aerowise Filing", "Parcel"]);
    const cell = Object.fromEntries(header!.map((h, i) => [h, row![i]]));
    expect(cell).toMatchObject({ "Record Type": "AEROBIC-MAINT", "Permit Number": "EX-1234", "Inspection Date": "2026-03-01", "Technician License": "MP-0001", "Air Pressure": "4.5", "Chlorine Level": "1.5", Submitted: "2026-03-01", "Aerowise Filing": f.id, Parcel: "P-77" });
    expect(cell["Maintenance Provider"]).toBe("Org A");
    expect(header).not.toContain(AUTHORITY_CSV_DEMO_COLUMN);

    const timeline = await events(s);
    expect(timeline.map((e) => e.eventType)).toEqual(expect.arrayContaining(["filing_ready", "filing_exported"]));
    expect(timeline.map((e) => e.eventType)).not.toContain("filing_sent");
    expect(timeline.find((e) => e.eventType === "filing_exported")!.summary).toMatch(/Not sent/);

    // Not an email filing: nothing sends it, and running the worker again changes nothing.
    expect((await s.api.post(`/filings/${f.id}/submit`, {})).statusCode).toBe(409);
    later(ctx, 3_600_000);
    await runWorker(ctx);
    expect((await detailOf(s, f.id)).status).toBe("ready");
    // The package is fixed.
    await expect(sql`update submission_packages set subject = 'changed'`.execute(ctx.db)).rejects.toThrow();

    // The office uploads it and records that, with its evidence.
    const sent = await s.api.post(`/filings/${f.id}/mark-sent`, { reference: "UPL-0042", note: "Uploaded on the portal" });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toMatchObject({ status: "sent", confirmedAt: null, proof: { kind: "manual_submission", reference: "UPL-0042" } });
    expect(sent.json().attempts).toEqual([expect.objectContaining({ method: "csv_export", status: "succeeded", packageId: pkg.id })]);
    expect((await events(s)).find((e) => e.eventType === "filing_sent")!.summary).toMatch(/^CSV uploaded to CSV Fixture County Health \(fictional\) \(reference UPL-0042\)/);

    // Sent is not confirmed: that takes the authority's acknowledgment.
    const confirmed = await s.api.post(`/filings/${f.id}/confirm`, { reference: "ACK-9", evidence: { kind: "portal_confirmation", receivedOn: "2026-03-02" } });
    expect(confirmed.json()).toMatchObject({ status: "confirmed", confirmationReference: "ACK-9" });
    // The CSV bytes never changed.
    expect(sha256((await download(ctx, (await detailOf(s, f.id)).packages[0].documents[1].url)).rawPayload)).toBe(doc.sha256);
  });

  it("holds the filing for review when a required column has no value, and exports once it has one", async () => {
    const s = await inspected(ctx, CSV_COUNTY, { permit: null });
    await runWorker(ctx);
    const f = await filingOf(s);
    expect(await detailOf(s, f.id)).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining(`required column "Permit Number" has no value`), packages: [] });

    expect((await s.api.patch(`/sites/${s.site.id}`, { permitNumber: "EX-9" })).statusCode).toBe(200);
    expect((await s.api.post(`/filings/${f.id}/recheck`, {})).json()).toMatchObject({ status: "ready", submissionMethod: "csv_export" });
  });

  it("switches a failed email filing to CSV export: a new submission carries the CSV, and the email package stays as it was", async () => {
    mail.mode = "fail";
    const s = await inspected(ctx, "Example County");
    await runWorker(ctx);
    const f = await filingOf(s);
    const failed = await detailOf(s, f.id);
    expect(failed).toMatchObject({ status: "failed", submissionMethod: "email", jurisdiction: { key: "tx-example-county", rulesetVersion: 2 } });
    expect(failed.package.csvExport).toEqual({ formReference: "FICTIONAL: Example County CSV layout EC-CSV-1, made up for development and tests" });
    expect(failed.package.csvUrl).toBeNull();
    const emailPackage = failed.packages[0];

    const switched = await s.api.post(`/filings/${f.id}/csv-export`, {});
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json()).toMatchObject({ status: "ready", submissionMethod: "csv_export", submissionNo: 2 });
    const [csvPackage, oldPackage] = switched.json().packages;
    expect(oldPackage).toEqual(emailPackage);
    expect(csvPackage).toMatchObject({ submissionNo: 2, method: "csv_export" });
    const csvDoc = csvPackage.documents.find((d: { role: string }) => d.role === "authority_csv");
    expect(csvDoc.filename).toBe("example-county-EX-1234-2026-03-01.csv");
    const [header, row] = rows((await download(ctx, csvDoc.url)).rawPayload.toString("utf8"));
    expect(row![header!.indexOf("Inspection Date")]).toBe("03/01/2026");
    expect(row![header!.indexOf("Submitted")]).toBe("03/01/2026");
    expect((await events(s)).map((e) => e.eventType)).toEqual(expect.arrayContaining(["filing_reprepared", "filing_exported"]));

    // The email retry that was waiting never sends the old package now.
    mail.mode = "ok";
    const calls = mail.calls;
    later(ctx, 3_600_000);
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
    expect((await detailOf(s, f.id)).status).toBe("ready");
    // Switching again is refused; filing by hand stays possible.
    expect((await s.api.post(`/filings/${f.id}/csv-export`, {})).statusCode).toBe(409);
    expect((await s.api.post(`/filings/${f.id}/manual`, {})).json()).toMatchObject({ status: "ready", submissionMethod: "manual_export" });
  });

  it("is refused for an authority without a CSV layout, for a filing that is not ready, across tenants and for technicians", async () => {
    const plain = await inspected(ctx, NO_EXPORT_COUNTY);
    await runWorker(ctx);
    const pf = await filingOf(plain);
    expect((await detailOf(plain, pf.id)).package).toMatchObject({ csvExport: null, csvUrl: null });
    expect((await plain.api.post(`/filings/${pf.id}/csv-export`, {})).json()).toMatchObject({ message: expect.stringContaining("no CSV layout") });

    const s = await inspected(ctx, CSV_COUNTY, { name: "Org B", permit: null });
    await runWorker(ctx);
    const f = await filingOf(s);
    // Not ready (it needs review), and another company's filing is not found.
    const r = await s.api.post(`/filings/${f.id}/mark-sent`, {});
    expect(r.statusCode).toBe(409);
    expect((await plain.api.post(`/filings/${f.id}/mark-sent`, {})).statusCode).toBe(404);
    expect((await plain.api.get(`/filings/${f.id}`)).statusCode).toBe(404);
    const tech = await createUser(ctx.db, s.org.id, "technician");
    expect((await client(ctx.app, await login(ctx.app, tech.email)).post(`/filings/${f.id}/csv-export`, {})).statusCode).toBe(403);
  });

  it("starts a demo company's CSV with the demo notice column, on the header and the row", async () => {
    const s = await inspected(ctx, CSV_COUNTY, { demo: true });
    await runWorker(ctx);
    const f = await detailOf(s, (await filingOf(s)).id);
    expect(f.status).toBe("ready");
    const doc = f.packages[0].documents[1];
    expect(doc.filename).toBe("DEMO-csv-fixture-EX-1234.csv");
    const [header, row] = rows((await download(ctx, f.package.csvUrl)).rawPayload.toString("utf8"));
    expect(AUTHORITY_CSV_DEMO_COLUMN).toBe(DEMO_CSV_COLUMN);
    expect(header![0]).toBe(AUTHORITY_CSV_DEMO_COLUMN);
    expect(row![0]).toBe(DEMO_WATERMARK);
    // The authority's columns follow, unchanged.
    expect(header!.slice(1, 3)).toEqual(["Record Type", "Permit Number"]);
  });
});

describe("the export framework's rules", () => {
  it("allows a CSV layout only in fictional rules: no real authority has one", () => {
    const real = bundledRulesets().filter((r) => profileStatus(r) !== "fictional");
    expect(real.length).toBeGreaterThan(10);
    expect(real.filter((r) => r.export || r.submission.method === "csv_export").map((r) => r.jurisdiction.key)).toEqual([]);
    expect(bundledRulesets().filter((r) => r.export).map((r) => `${r.jurisdiction.key} v${r.version}`)).toEqual(["tx-example-county v2"]);

    const dir = mkdtempSync(join(tmpdir(), "rulesets-"));
    cpSync(join(RULESET_DIR, "tx-hays-county"), join(dir, "tx-hays-county"), { recursive: true });
    const file = join(dir, "tx-hays-county", "v1.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), export: EXAMPLE_V2.export }));
    expect(() => bundledRulesets(dir)).toThrow(/only the fictional example may until gate G-AUTH-CSV/);
  });

  it("checks the layout: filing by CSV needs one, headers are unique, each source has its own setting", () => {
    const base = load("tx-example-county", 2);
    const issues = (over: Record<string, unknown>) => rulesetRules.safeParse({ ...base, ...over }).error?.issues.map((i) => i.message) ?? [];
    expect(issues({})).toEqual([]);
    expect(issues({ export: undefined, submission: { ...base.submission, method: "csv_export" } })).toEqual(["Filing by CSV export needs an export layout for inspection_report filings"]);
    const columns = base.export.columns;
    expect(issues({ export: { ...base.export, columns: [...columns, columns[1]] } })).toEqual(['Column "Permit Number" appears twice']);
    expect(issues({ export: { ...base.export, columns: [{ header: "X", source: "field", required: true }] } })).toEqual(["`field` goes with, and only with, the field source"]);
    expect(issues({ export: { ...base.export, columns: [{ header: "X", source: "owner_name", value: "x", required: true }] } })).toEqual(["`value` goes with, and only with, the constant source"]);
    expect(issues({ export: { ...base.export, filename: "../../etc/passwd.csv" } })).toHaveLength(1);
  });

  it("writes cells a spreadsheet will not run as formulas, and formats dates as the layout says", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell("@cmd")).toBe(`"'@cmd"`);
    expect(csvCell("-12.5")).toBe("-12.5");
    expect(csvCell('Say "hi", then')).toBe(`"Say ""hi"", then"`);
    expect(csvCell(null)).toBe("");
    const layout = { ...EXAMPLE_V2.export, columns: [{ header: "Owner", source: "owner_name", required: true }, { header: "Done", source: "inspection_date", required: true }, { header: "Pumped", source: "field", field: "pumping_needed", required: false }] };
    const facts = {
      filingId: "00000000-0000-4000-8000-000000000001",
      submissionNo: 1,
      submissionDate: "2026-03-02",
      inspectionDate: "2026-03-01",
      technicianName: null,
      technicianLicense: null,
      values: { pumping_needed: false },
      ownerName: "=1+1",
      site: { addressLine1: "1 Main", city: "X", state: "TX", postalCode: null, county: null, permitNumber: "A/B 7" },
      identifiers: {},
      providerName: "P",
      responsibleProviderName: null,
      responsibleProviderMpNumber: null,
    };
    const csv = authorityCsv(layout, facts, { demo: false });
    expect(csv.filename).toBe("example-county-AB7-2026-03-01.csv");
    expect(csv.content.toString("utf8")).toBe(`Owner,Done,Pumped\r\n"'=1+1",03/01/2026,No\r\n`);
  });

  it("formats only the date sources: date-looking permits, identifiers, constants and answers stay as written", () => {
    const layout = {
      ...EXAMPLE_V2.export,
      dateFormat: "MM/DD/YYYY" as const,
      columns: [
        { header: "Permit", source: "site_permit_number", required: true },
        { header: "Parcel", source: "identifier", identifier: "parcel_id", required: false },
        { header: "Code", source: "constant", value: "2026-01-02", required: true },
        { header: "Note", source: "field", field: "notes", required: false },
        { header: "Inspected", source: "inspection_date", required: true },
        { header: "Submitted", source: "submission_date", required: true },
      ],
    };
    const facts = {
      filingId: "00000000-0000-4000-8000-000000000001",
      submissionNo: 1,
      submissionDate: "2026-03-02",
      inspectionDate: "2026-03-01",
      technicianName: null,
      technicianLicense: null,
      values: { notes: "2025-12-31" },
      ownerName: "Pat",
      site: { addressLine1: "1 Main", city: "X", state: "TX", postalCode: null, county: null, permitNumber: "2026-03-01" },
      identifiers: { parcel_id: "2024-07-04" },
      providerName: "P",
      responsibleProviderName: null,
      responsibleProviderMpNumber: null,
    };
    expect(authorityCsv(layout, facts, { demo: false }).content.toString("utf8")).toBe("Permit,Parcel,Code,Note,Inspected,Submitted\r\n2026-03-01,2024-07-04,2026-01-02,2025-12-31,03/01/2026,03/02/2026\r\n");
  });
});
