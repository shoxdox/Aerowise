import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledRulesets, syncContractFilings, syncRulesets } from "@aerowise/compliance";
import type { ReportSnapshot } from "@aerowise/reports";
import { drainTasks } from "@aerowise/tasks";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { createTenant, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, payload, setup, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

// Today is 2026-03-01 (setupTestApp's clock); inspections complete that day, so a filing
// with a 14-day deadline is due 2026-03-15.
const ctx = setupTestApp();
const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/rulesets", import.meta.url));
const FIXTURES = bundledRulesets(FIXTURE_DIR);
const FEES = "Fee Fixture County";

beforeEach(async () => {
  mail.mode = "ok";
  await syncRulesets(ctx.db, FIXTURES);
});

// Other test files list the authorities, so leave only the bundled ones behind.
afterAll(async () => {
  await sql`truncate jurisdiction_rulesets, jurisdictions cascade`.execute(ctx.db);
  await syncRulesets(ctx.db);
});

async function inspected(c: TestContext, county: string, name = "Org A") {
  const s = await setup(c, name);
  return { ...s, inspectionId: await inspectedAt(s, county) };
}

const filingOf = async (s: Setup) => (await s.api.get("/filings?view=all")).json().items[0];
const snapshots = async (c: TestContext, inspectionId: string) => {
  const rows = await c.db.selectFrom("reports").select(["audience", "snapshot"]).where("inspectionId", "=", inspectionId).execute();
  return Object.fromEntries(rows.map((r) => [r.audience, r.snapshot as ReportSnapshot]));
};

describe("an authority's report layout", () => {
  it("lays out the authority copy with the ruleset's title, sections and labels; the customer copy keeps the template's", async () => {
    const s = await inspected(ctx, FEES);
    await runWorker(ctx);
    const { authority, customer } = await snapshots(ctx, s.inspectionId);
    expect(authority!.layout).toEqual({ title: "Fee Fixture County Aerobic Maintenance Report", formReference: "FICTIONAL: Fee Fixture County form FF-1", jurisdictionKey: "tx-fixture-fees", rulesetVersion: 1 });
    expect(authority!.sections).toEqual([
      {
        title: "Treatment",
        rows: [
          { label: "Aerator operating", value: "Pass", failed: false },
          { label: "Air pressure at the aerator", value: "4.5 psi", failed: false },
          // No label in the layout: the template's.
          { label: "Clarifier / treatment tank", value: "Pass", failed: false },
        ],
      },
      {
        title: "Disinfection",
        rows: [
          { label: "Chlorinator", value: "Working", failed: false },
          { label: "Chlorine residual", value: "1.5 ppm", failed: false },
          { label: "Repairs made", value: "Replaced the air filter", failed: false },
        ],
      },
    ]);
    // pH was answered but the authority's layout does not list it.
    expect(JSON.stringify(authority!.sections)).not.toContain("pH");
    expect(customer!.layout ?? null).toBeNull();
    expect(customer!.sections.map((x) => x.title)).toEqual(expect.arrayContaining(["Aeration", "Lab values"]));
    expect(customer!.sections.flatMap((x) => x.rows).find((r) => r.label === "pH")).toMatchObject({ value: "7.1" });
  });

  it("leaves off listed answers the inspection did not ask for, and keeps corrections in the layout", async () => {
    const s = await setup(ctx);
    expect((await s.api.patch(`/sites/${s.site.id}`, { county: FEES })).statusCode).toBe(200);
    await ctx.db.updateTable("memberships").set({ technicianLicense: "MT-0001" }).where("userId", "=", s.tech.id).execute();
    const p = payload(s);
    await s.techApi.put("/inspections/sync", p);
    await uploadRequiredPhotos(s, p.clientId);
    // No chlorinator: the chlorine reading is never asked for, and no repairs were made.
    const values = { ...completeValues(), chlorinator: "not_present", chlorine_level: undefined, air_pressure: 4.5 };
    const done = (await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values }))).json();
    await runWorker(ctx);
    const { authority } = await snapshots(ctx, done.id);
    expect(authority!.sections[1]).toEqual({ title: "Disinfection", rows: [{ label: "Chlorinator", value: "Not present", failed: false }] });

    const f = await filingOf(s);
    await s.api.post(`/filings/${f.id}/manual`, {});
    await s.api.post(`/filings/${f.id}/mark-sent`, { reference: "FF-0", note: null });
    expect((await s.api.post(`/filings/${f.id}/reject`, { reason: "Pressure looks wrong" })).statusCode).toBe(200);
    const corrected = await s.api.post(`/filings/${f.id}/correct`, { reason: "Pressure misread", amendments: { air_pressure: 5 } });
    expect(corrected.statusCode, corrected.body).toBe(200);
    const latest = await ctx.db.selectFrom("reports").select("snapshot").where("inspectionId", "=", done.id).where("audience", "=", "authority").orderBy("version", "desc").executeTakeFirstOrThrow();
    const snap = latest.snapshot as ReportSnapshot;
    expect(snap.layout?.title).toBe("Fee Fixture County Aerobic Maintenance Report");
    expect(snap.sections[0]!.rows[1]).toEqual({ label: "Air pressure at the aerator", value: "5 psi", failed: false });
  });

  it("is the template's own where the ruleset sets none", async () => {
    const s = await inspected(ctx, "Quarterly Fixture County");
    await runWorker(ctx);
    const { authority } = await snapshots(ctx, s.inspectionId);
    expect(authority!.layout ?? null).toBeNull();
    expect(authority!.sections.map((x) => x.title)).toContain("Aeration");
    expect((await filingOf(s)).fees).toBeNull();
  });

  it("must show every answer the authority requires", () => {
    const dir = mkdtempSync(join(tmpdir(), "rulesets-"));
    cpSync(join(FIXTURE_DIR, "tx-fixture-fees"), join(dir, "tx-fixture-fees"), { recursive: true });
    const file = join(dir, "tx-fixture-fees", "v1.json");
    const rules = JSON.parse(readFileSync(file, "utf8"));
    rules.report.sections[0].fields = rules.report.sections[0].fields.filter((f: { key: string }) => f.key !== "air_pressure");
    writeFileSync(file, JSON.stringify(rules));
    expect(() => bundledRulesets(dir)).toThrow(/requires air_pressure but its report layout leaves them off/);
  });
});

describe("filing fees", () => {
  it("are recorded when the filing opens; on time, no late fee", async () => {
    const s = await inspected(ctx, FEES);
    const opened = await filingOf(s);
    expect(opened).toMatchObject({ status: "pending", deadlineOn: "2026-03-15", fees: { filingFeeCents: 1000, lateFeeIfLateCents: 2500, lateFeeCents: null, totalCents: 1000, basis: "FICTIONAL: Fee Fixture County fee schedule" } });

    await runWorker(ctx);
    expect((await filingOf(s)).status).toBe("ready");
    ctx.now = new Date("2026-03-15T20:00:00Z"); // the deadline day itself is on time
    expect((await s.api.post(`/filings/${opened.id}/submit`, {})).statusCode).toBe(200);
    await runWorker(ctx);
    expect(await filingOf(s)).toMatchObject({ status: "sent", fees: { filingFeeCents: 1000, lateFeeCents: 0, totalCents: 1000 } });
  });

  it("add the late fee when the filing first reaches the authority after the deadline, and only once", async () => {
    const s = await inspected(ctx, FEES);
    await runWorker(ctx);
    const f = await filingOf(s);
    ctx.now = new Date("2026-03-20T16:00:00Z");
    expect((await s.api.post(`/filings/${f.id}/submit`, {})).statusCode).toBe(200);
    await runWorker(ctx);
    expect(await filingOf(s)).toMatchObject({ status: "sent", deadlineState: "met", fees: { filingFeeCents: 1000, lateFeeCents: 2500, totalCents: 3500 } });
    const events = (await s.api.get(`/sites/${s.site.id}/compliance-events`)).json().items as { eventType: string; summary: string }[];
    expect(events.find((e) => e.eventType === "filing_sent")!.summary).toContain("Sent after the 2026-03-15 deadline: late fee $25.00.");

    // Rejected and sent again: the late fee was decided by the first send.
    expect((await s.api.post(`/filings/${f.id}/reject`, { reason: "Wrong permit number" })).statusCode).toBe(200);
    expect((await s.api.post(`/filings/${f.id}/resubmit`, {})).statusCode).toBe(200);
    await runWorker(ctx);
    ctx.now = new Date("2026-04-02T16:00:00Z");
    const again = await filingOf(s);
    if (again.status === "ready") {
      await s.api.post(`/filings/${f.id}/submit`, {});
      await runWorker(ctx);
    }
    expect(await filingOf(s)).toMatchObject({ status: "sent", fees: { lateFeeCents: 2500, totalCents: 3500 } });
  });

  it("count a late filing by hand the same way, on the organization's date", async () => {
    const s = await inspected(ctx, FEES);
    await runWorker(ctx);
    const f = await filingOf(s);
    expect((await s.api.post(`/filings/${f.id}/manual`, {})).statusCode).toBe(200);
    // 03:00 UTC on the 16th is still the 15th in Central time: on time.
    ctx.now = new Date("2026-03-16T03:00:00Z");
    expect((await s.api.post(`/filings/${f.id}/mark-sent`, { reference: "FF-1", note: null })).statusCode).toBe(200);
    expect((await filingOf(s)).fees).toMatchObject({ lateFeeCents: 0, totalCents: 1000 });

    const u = await inspected(ctx, FEES, "Org B");
    await runWorker(ctx);
    const g = await filingOf(u);
    await u.api.post(`/filings/${g.id}/manual`, {});
    ctx.now = new Date("2026-03-16T16:00:00Z");
    await u.api.post(`/filings/${g.id}/mark-sent`, { reference: "FF-2", note: null });
    expect((await filingOf(u)).fees).toMatchObject({ lateFeeCents: 2500, totalCents: 3500 });
  });

  it("are recorded on contract filings from the ruleset's contract fee", async () => {
    const s = await createTenant(ctx, "Org A");
    expect((await s.api.patch(`/sites/${s.site.id}`, { county: FEES })).statusCode).toBe(200);
    const plan = (await s.api.post("/plans", { name: "Annual 2", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
    expect((await s.api.post(`/sites/${s.site.id}/contracts`, { planId: plan.id, startOn: "2026-03-01" })).statusCode).toBe(201);
    await syncContractFilings({ db: ctx.db, now: () => ctx.now }, s.org.id);
    const res = await s.api.get("/filings?view=all&kind=contract");
    expect(res.json().items[0]).toMatchObject({ kind: "contract", fees: { filingFeeCents: 500, lateFeeIfLateCents: 0, lateFeeCents: null, totalCents: 500 } });
  });
});

describe("filing fees on the homeowner's invoice", () => {
  /** A Fee Fixture County site whose inspection report reached the authority on time, billed quarterly. */
  async function filed(name: string) {
    const s = await inspected(ctx, FEES, name);
    await runWorker(ctx);
    const f = await filingOf(s);
    ctx.now = new Date("2026-03-15T20:00:00Z");
    expect((await s.api.post(`/filings/${f.id}/submit`, {})).statusCode).toBe(200);
    await runWorker(ctx);
    expect((await filingOf(s)).status).toBe("sent");
    await ctx.db.updateTable("contracts").set({ billingFrequency: "quarterly" }).where("id", "=", s.contract.id).execute();
    return { ...s, filingId: f.id as string };
  }
  type Line = { id: string; description: string; unitPriceCents: number; filingId: string | null; installment: number | null };
  const invoiceFor = async (s: Setup) => {
    const res = await s.api.post(`/contracts/${s.contract.id}/invoice`, {});
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; totalCents: number; lines: Line[] };
  };

  it("are left off unless the company turns them on", async () => {
    const s = await filed("Org A");
    expect((await s.api.get("/organization/settings")).json().billFilingFees).toBe(false);
    const inv = await invoiceFor(s);
    expect(inv.lines.map((l) => l.filingId)).toEqual([null]);
  });

  it("are billed once each when on, without the late fee, and stay with their line through edits", async () => {
    const s = await filed("Org A");
    expect((await s.api.patch("/organization/settings", { billFilingFees: true })).json().billFilingFees).toBe(true);
    const first = await invoiceFor(s);
    expect(first.lines).toEqual([
      expect.objectContaining({ installment: 1, filingId: null }),
      expect.objectContaining({ description: "Fee Fixture County (fictional) filing fee: inspection report filed Mar 15, 2026", unitPriceCents: 1000, installment: null, filingId: s.filingId }),
    ]);
    // Editing the draft (lines sent back with their ids) keeps what the fee line bills for.
    const edited = await s.api.patch(`/invoices/${first.id}`, {
      lines: first.lines.map((l) => ({ id: l.id, description: l.filingId ? "County filing fee" : l.description, unitPriceCents: l.unitPriceCents })),
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().lines[1]).toMatchObject({ description: "County filing fee", filingId: s.filingId });

    // The next installment does not bill the same fee again; once the first is discarded, it does.
    const second = await invoiceFor(s);
    expect(second.lines.map((l) => l.filingId)).toEqual([null]);
    expect((await s.api.post(`/invoices/${first.id}/discard`, {})).statusCode).toBeLessThan(300);
    const third = await invoiceFor(s);
    expect(third.lines.map((l) => l.filingId)).toEqual([null, s.filingId]);
  });
});

describe("lab results on the authority report", () => {
  const LAB = "Annual Lab Fixture County";

  it("adds the latest sample by the inspection day, against the limits, where the ruleset asks for it", async () => {
    const s = await setup(ctx);
    const lab = (body: Record<string, unknown>) => s.api.post(`/sites/${s.site.id}/lab-tests`, { labName: "Hill Country Labs", ...body });
    expect((await lab({ sampledOn: "2025-02-10", results: [{ analyte: "bod", value: 5 }, { analyte: "tss", value: 6 }] })).statusCode).toBe(201);
    expect((await lab({ sampledOn: "2026-02-20", labReference: "HCL-2291", results: [{ analyte: "bod", value: 34 }, { analyte: "tss", value: 12 }] })).statusCode).toBe(201);
    const done = await inspectedAt(s, LAB);
    await runWorker(ctx);
    const { authority, customer } = await snapshots(ctx, done);
    expect(authority!.sections.at(-1)).toEqual({
      title: "Lab results",
      rows: [
        { label: "Sampled on", value: "2026-02-20", failed: false },
        { label: "Lab", value: "Hill Country Labs, HCL-2291", failed: false },
        { label: "BOD (mg/L)", value: "34 (limit 20)", failed: true },
        { label: "TSS (mg/L)", value: "12 (limit 20)", failed: false },
      ],
    });
    // The homeowner's copy is unchanged.
    expect(customer!.sections.map((x) => x.title)).not.toContain("Lab results");
  });

  it("says so when no sample is on record", async () => {
    const s = await setup(ctx);
    const done = await inspectedAt(s, LAB);
    await runWorker(ctx);
    expect((await snapshots(ctx, done)).authority!.sections.at(-1)).toEqual({ title: "Lab results", rows: [{ label: "Latest sample", value: "None on record", failed: true }] });
  });

  it("leaves them off where the ruleset does not ask for them", async () => {
    const s = await setup(ctx);
    expect((await s.api.post(`/sites/${s.site.id}/lab-tests`, { sampledOn: "2026-02-20", labName: "L", results: [{ analyte: "bod", value: 34 }] })).statusCode).toBe(201);
    const done = await inspectedAt(s, FEES);
    await runWorker(ctx);
    expect(JSON.stringify((await snapshots(ctx, done)).authority!.sections)).not.toContain("Lab results");
  });
});

/** Completes an inspection at `s`'s site after moving the site to `county`. */
async function inspectedAt(s: Setup, county: string) {
  expect((await s.api.patch(`/sites/${s.site.id}`, { county })).statusCode).toBe(200);
  await ctx.db.updateTable("memberships").set({ technicianLicense: "MT-0001" }).where("userId", "=", s.tech.id).execute();
  const p = payload(s);
  await s.techApi.put("/inspections/sync", p);
  await uploadRequiredPhotos(s, p.clientId);
  const values = { ...completeValues(), air_pressure: 4.5, repairs_made: "Replaced the air filter", ph: 7.1 };
  const done = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values }));
  expect(done.json().status).toBe("completed");
  return done.json().id as string;
}
