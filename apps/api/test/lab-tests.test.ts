import { fileURLToPath } from "node:url";
import { bundledRulesets, syncRulesets } from "@aerowise/compliance";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";

// Today is 2026-03-01 (setupTestApp's clock).
const ctx = setupTestApp();

const FIXTURES = bundledRulesets(fileURLToPath(new URL("./fixtures/rulesets", import.meta.url)));
const LAB_COUNTY = "Annual Lab Fixture County";

beforeEach(async () => {
  await syncRulesets(ctx.db, FIXTURES);
});

// Other test files list the authorities, so leave only the bundled ones behind.
afterAll(async () => {
  await sql`truncate jurisdiction_rulesets, jurisdictions cascade`.execute(ctx.db);
  await syncRulesets(ctx.db);
});

/** A site in a county whose authority wants annual BOD and TSS, with a contract from `startOn`. */
async function labSite(c: TestContext, name = "Org A", opts: { county?: string; startOn?: string | null } = {}) {
  const t = await createTenant(c, name);
  expect((await t.api.patch(`/sites/${t.site.id}`, { county: opts.county ?? LAB_COUNTY })).statusCode).toBe(200);
  const plan = (await t.api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
  const startOn = opts.startOn === undefined ? "2025-06-01" : opts.startOn;
  const contract = startOn ? (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn })).json() : null;
  return { ...t, plan, contract };
}

const BOTH = [
  { analyte: "bod", value: 12 },
  { analyte: "tss", value: 18 },
];
const record = (t: { api: ReturnType<typeof client>; site: { id: string } }, body: Record<string, unknown>) =>
  t.api.post(`/sites/${t.site.id}/lab-tests`, { sampledOn: "2026-02-20", labName: "Hill Country Labs", labReference: "HCL-2291", results: BOTH, ...body });
const labTestsOf = async (t: { api: ReturnType<typeof client>; site: { id: string } }) => (await t.api.get(`/sites/${t.site.id}/lab-tests`)).json();
const overItems = async (t: { api: ReturnType<typeof client> }) =>
  ((await t.api.get("/inbox")).json().items as { kind: string; key: string; title: string; detail: string }[]).filter((i) => i.kind === "lab_result_over_limit");
const lateItems = async (t: { api: ReturnType<typeof client> }) =>
  ((await t.api.get("/inbox")).json().items as { kind: string; key: string; title: string; detail: string }[]).filter((i) => i.kind === "lab_test_late");

describe("lab tests a ruleset requires", () => {
  it("are due a year after the site's first contract when none is on record", async () => {
    const t = await labSite(ctx);
    expect(await labTestsOf(t)).toEqual({
      requirement: {
        authorityName: "Annual Lab Fixture County (fictional)",
        analytes: ["bod", "tss"],
        everyMonths: 12,
        note: "Fixture: effluent BOD and TSS by an accredited lab once a year.",
        lastSampledOn: null,
        dueOn: "2026-06-01",
        dueBasis: "12 months after the first contract started on 2025-06-01, with no test on record",
        state: "ok",
        overLimit: [],
      },
      items: [],
    });
    expect(await lateItems(t)).toEqual([]);
  });

  it("show as coming up within 30 days of the due date", async () => {
    const t = await labSite(ctx, "Org A", { startOn: "2025-03-20" });
    expect((await labTestsOf(t)).requirement).toMatchObject({ dueOn: "2026-03-20", state: "due_soon" });
  });

  it("are late, with an inbox item, until a result is recorded", async () => {
    // A renewal does not restart the clock: it counts from the first contract.
    const t = await labSite(ctx, "Org A", { startOn: "2024-06-01" });
    expect((await t.api.post(`/contracts/${t.contract.id}/renew`, {})).statusCode).toBe(201);
    expect((await labTestsOf(t)).requirement).toMatchObject({ dueOn: "2025-06-01", state: "late" });
    const [item] = await lateItems(t);
    expect(item).toMatchObject({ key: `lab_test_late:${t.site.id}`, title: "BOD and TSS lab test overdue" });
    expect(item!.detail).toContain("due 2025-06-01");

    const res = await record(t, {});
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ sampledOn: "2026-02-20", labName: "Hill Country Labs", labReference: "HCL-2291", results: BOTH, replacesId: null, replacedById: null });
    expect((await labTestsOf(t)).requirement).toMatchObject({ lastSampledOn: "2026-02-20", dueOn: "2027-02-20", state: "ok" });
    expect(await lateItems(t)).toEqual([]);

    const events = (await t.api.get(`/sites/${t.site.id}/compliance-events`)).json().items as { eventType: string; summary: string }[];
    expect(events.find((e) => e.eventType === "lab_test_recorded")?.summary).toBe("Lab test recorded: sampled 2026-02-20, Hill Country Labs: BOD 12 mg/L, TSS 18 mg/L");
  });

  it("need every required result, and a sample date that has happened", async () => {
    const t = await labSite(ctx);
    const missing = await record(t, { results: [{ analyte: "bod", value: 12 }] });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().message).toMatch(/requires TSS results/);
    expect((await record(t, { sampledOn: "2026-03-02" })).statusCode).toBe(422);
    expect((await record(t, { results: [...BOTH, { analyte: "bod", value: 3 }] })).statusCode).toBe(400);
    expect((await record(t, { labName: "" })).statusCode).toBe(400);
  });

  it("are corrected by a new record that replaces the old one, once", async () => {
    const t = await labSite(ctx);
    const first = (await record(t, {})).json();
    const fixed = await record(t, { sampledOn: "2026-02-21", replacesId: first.id, notes: "Sample date was misread" });
    expect(fixed.statusCode).toBe(201);
    const after = await labTestsOf(t);
    expect(after.items.map((i: { id: string; replacedById: string | null }) => [i.id, i.replacedById])).toEqual([
      [fixed.json().id, null],
      [first.id, fixed.json().id],
    ]);
    // Only the correction counts.
    expect(after.requirement).toMatchObject({ lastSampledOn: "2026-02-21", dueOn: "2027-02-21" });
    expect((await record(t, { replacesId: first.id })).statusCode).toBe(409);
    // Records are never changed in place.
    await expect(sql`update lab_tests set lab_name = 'x'`.execute(ctx.db)).rejects.toThrow();
    await expect(sql`delete from lab_tests`.execute(ctx.db)).rejects.toThrow();
  });

  it("raise an inbox item while the latest sample is above the authority's limits", async () => {
    const t = await labSite(ctx);
    const high = (await record(t, { results: [{ analyte: "bod", value: 34 }, { analyte: "tss", value: 20 }] })).json();
    expect((await labTestsOf(t)).requirement.overLimit).toEqual([{ analyte: "bod", value: 34, limit: 20 }]);
    expect(await overItems(t)).toEqual([
      expect.objectContaining({
        key: `lab_result_over_limit:${t.site.id}`,
        title: "BOD above Annual Lab Fixture County (fictional)'s limit",
        detail: "Sample of 2026-02-20: BOD 34 mg/L (limit 20)",
      }),
    ]);
    // A result at the limit is within it; a correction or a newer sample within limits clears it.
    await record(t, { replacesId: high.id, results: [{ analyte: "bod", value: 20 }, { analyte: "tss", value: 20 }] });
    expect((await labTestsOf(t)).requirement.overLimit).toEqual([]);
    expect(await overItems(t)).toEqual([]);
    await record(t, { sampledOn: "2026-02-25", results: [{ analyte: "bod", value: 8 }, { analyte: "tss", value: 41 }] });
    expect((await overItems(t)).map((i) => i.title)).toEqual(["TSS above Annual Lab Fixture County (fictional)'s limit"]);
  });

  it("raise no limit item where the authority sets no limits", async () => {
    const example = await labSite(ctx, "Org A", { county: "Example County" });
    await record(example, { results: [{ analyte: "bod", value: 900 }, { analyte: "tss", value: 900 }] });
    expect(await overItems(example)).toEqual([]);
  });

  it("are not required where the authority does not ask, or without a contract in force", async () => {
    const example = await labSite(ctx, "Org A", { county: "Example County" });
    expect((await labTestsOf(example)).requirement).toBeNull();
    // Results can still be kept on file.
    expect((await record(example, { results: [{ analyte: "tss", value: 9 }] })).statusCode).toBe(201);

    const none = await labSite(ctx, "Org B", { startOn: null });
    expect((await labTestsOf(none)).requirement).toBeNull();
    const ended = await labSite(ctx, "Org C", { startOn: "2024-01-01" });
    expect((await labTestsOf(ended)).requirement).toBeNull();
  });

  it("are recorded by the office, and read by anyone who can read filings", async () => {
    const t = await labSite(ctx);
    const tech = await createUser(ctx.db, t.org.id, "technician");
    const techApi = client(ctx.app, await login(ctx.app, tech.email));
    expect((await techApi.post(`/sites/${t.site.id}/lab-tests`, { sampledOn: "2026-02-20", labName: "L", results: BOTH })).statusCode).toBe(403);
    const viewer = await createUser(ctx.db, t.org.id, "read_only");
    const viewerApi = client(ctx.app, await login(ctx.app, viewer.email));
    expect((await viewerApi.get(`/sites/${t.site.id}/lab-tests`)).statusCode).toBe(200);
  });
});

describe("lab test isolation", () => {
  it("keeps lab tests inside their organization", async () => {
    const a = await labSite(ctx, "Org A", { startOn: "2024-06-01" });
    await a.api.post(`/contracts/${a.contract.id}/renew`, {});
    const b = await labSite(ctx, "Org B");
    const mine = (await record(a, {})).json();

    expect((await b.api.get(`/sites/${a.site.id}/lab-tests`)).statusCode).toBe(404);
    expect((await b.api.post(`/sites/${a.site.id}/lab-tests`, { sampledOn: "2026-02-20", labName: "L", results: BOTH })).statusCode).toBe(404);
    // Another organization's record cannot be "corrected" from a site of its own.
    expect((await record(b, { replacesId: mine.id })).statusCode).toBe(422);
    expect((await labTestsOf(b)).items).toEqual([]);
    // A database-level guard as well: a record cannot point at another organization's site.
    await expect(
      sql`insert into lab_tests (organization_id, site_id, sampled_on, lab_name, results, recorded_by) values (${b.org.id}, ${a.site.id}, '2026-02-20', 'L', '[]', ${b.owner.id})`.execute(ctx.db),
    ).rejects.toThrow(/foreign key/);
  });
});
