import { createDb, ensureBuiltInForms, migrate } from "@aerowise/db";
import { snapshotSha256, type TemplateDefinition } from "@aerowise/domain";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./db-url.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { JPEG } from "./inspection-helpers.ts";

// SW-7: conventional and installation work. A two-visit installation finishes on its final visit
// with the customer's completion sign-off, given exactly once; its completion summary is in the
// office and the portal; nothing about it reaches aerobic reporting.

const ctx = setupTestApp({ features: ["work_orders", "field_work"] });

type Api = ReturnType<typeof client>;
const uuid = () => crypto.randomUUID();
const typeOf = async (api: Api, key: string) => ((await api.get("/work-types")).json().items as { id: string; key: string }[]).find((x) => x.key === key)!;

/** What the compliance path holds for the company: none of it may move when this work is done. */
async function complianceCounts(c: TestContext, organizationId: string) {
  const n = async (table: string, where = sql``) =>
    Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(table)} where organization_id = ${organizationId} ${where}`.execute(c.db)).rows[0]!.n);
  return {
    filings: await n("filings"),
    reports: await n("reports"),
    complianceEvents: await n("compliance_events"),
    inspections: await n("inspections"),
    obligations: await n("service_obligations"),
  };
}

/** As createTenant, for a demo company (a company is demo or real from the moment it is made). */
async function demoTenant(c: TestContext) {
  const org = await c.db.insertInto("organizations").values({ name: "Demo Co (demo)", demo: true } as never).returning("id").executeTakeFirstOrThrow();
  const owner = await createUser(c.db, org.id, "owner");
  const api = client(c.app, await login(c.app, owner.email));
  const customer = (await api.post("/customers", { displayName: "Demo customer" })).json();
  const site = (await api.post(`/customers/${customer.id}/sites`, { addressLine1: "1 Main St", city: "Austin" })).json();
  const system = (await api.post(`/sites/${site.id}/systems`, { manufacturer: "Acme" })).json();
  return { org, owner, api, customer, site, system };
}

/** A company with an installation work order and technician A scheduled for its first visit. */
async function setup(c: TestContext, opts: { demo?: boolean } = {}) {
  const t = opts.demo ? await demoTenant(c) : await createTenant(c, "Org A");
  const a = await createUser(c.db, t.org.id, "technician");
  const b = await createUser(c.db, t.org.id, "technician");
  const aApi = client(c.app, await login(c.app, a.email));
  const install = await typeOf(t.api, "installation");
  const wo = (await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: install.id, title: "New conventional system" })).json();
  const form = (await aApi.get("/form-templates/work-installation")).json();
  const schedule = async (date: string) => {
    const res = await t.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: a.id, scheduledDate: date });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().visits as { jobId: string; visitNumber: number }[]).at(-1)!.jobId;
  };
  return { ...t, a, b, aApi, wo, form, schedule };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const VALUES = { system_status: "new", bedrooms: 3, tank_sizes: "1,000 gal", work_performed: "Set the tank" };

/** One visit as the phone records it. */
function visit(s: Setup, jobId: string, opts: { finalVisit: boolean; day: string; values?: Record<string, unknown>; templateId?: string }) {
  const clientId = uuid();
  const summary = { workOrder: s.wo.title, visit: jobId, anotherVisitNeeded: !opts.finalVisit };
  const body = (status: "draft" | "completed", revision: number) => ({
    clientId,
    jobId,
    templateId: opts.templateId ?? s.form.id,
    status,
    revision,
    arrivedAt: `${opts.day}T15:00:00Z`,
    completedAt: status === "completed" ? `${opts.day}T17:00:00Z` : null,
    values: opts.values ?? VALUES,
    summary,
    finalVisit: opts.finalVisit,
  });
  return {
    clientId,
    draft: (api: Api) => api.put("/work/sync", body("draft", 1)),
    complete: (api: Api, revision = 2) => api.put("/work/sync", body("completed", revision)),
    photo: (api: Api, key = "install_location") => api.putImage(`/work/${clientId}/photos/${uuid()}`, JPEG, { "x-photo-key": key }),
    sign: async (api: Api, requirementKey = "customer_completion") =>
      api.put(`/work/${clientId}/signatures/${uuid()}`, {
        requirementKey,
        signerName: "Pat Homeowner",
        capture: { kind: "typed" },
        summary,
        summarySha256: await snapshotSha256(summary),
        consentText: "I confirm this work was done.",
        signedAt: `${opts.day}T16:55:00Z`,
      }),
  };
}

const signedFor = async (workOrderId: string) =>
  Number(
    (
      await sql<{ n: string }>`select count(*) as n from signed_documents d join work_records r on r.organization_id = d.organization_id and r.offline_client_id = d.record_client_id
        where r.work_order_id = ${workOrderId} and d.kind = 'work_completion'`.execute(ctx.db)
    ).rows[0]!.n,
  );

describe("a two-visit installation", () => {
  it("finishes on its final visit with the completion sign-off given exactly once, and nothing reaches aerobic reporting", async () => {
    const s = await setup(ctx);
    const before = await complianceCounts(ctx, s.org.id);

    // Visit 1: another visit is needed, so the completion sign-off is not asked for.
    const v1 = visit(s, await s.schedule("2026-03-01"), { finalVisit: false, day: "2026-03-01" });
    await v1.draft(s.aApi);
    await v1.photo(s.aApi);
    const first = await v1.complete(s.aApi);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ status: "completed", validationStatus: "valid", finalVisit: false, signatures: [] });
    expect((await s.api.get(`/work-orders/${s.wo.id}`)).json().status).toBe("open");

    // Visit 2 finishes the work: without the sign-off it stays a draft, saying what is missing.
    const v2 = visit(s, await s.schedule("2026-03-08"), { finalVisit: true, day: "2026-03-08", values: { ...VALUES, work_performed: "Laid the field lines" } });
    await v2.draft(s.aApi);
    await v2.photo(s.aApi);
    await v2.photo(s.aApi, "as_built");
    const unsigned = await v2.complete(s.aApi);
    expect(unsigned.json()).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(unsigned.json().validationProblems).toEqual([expect.objectContaining({ key: "customer_completion", problem: "missing" })]);
    expect((await s.api.get(`/work-orders/${s.wo.id}`)).json().status).toBe("scheduled");

    // Signed, it completes the work order; a replay of the signature and the completion changes nothing.
    expect((await v2.sign(s.aApi)).statusCode).toBe(201);
    const done = await v2.complete(s.aApi, 3);
    expect(done.json()).toMatchObject({ status: "completed", validationStatus: "valid", finalVisit: true });
    expect((await s.api.get(`/work-orders/${s.wo.id}`)).json()).toMatchObject({ status: "completed", visits: [{ status: "completed" }, { status: "completed" }] });
    expect((await v2.complete(s.aApi, 3)).statusCode).toBe(200);
    expect(await signedFor(s.wo.id)).toBe(1);

    expect(await complianceCounts(ctx, s.org.id)).toEqual(before);
  });

  it("the office accepts a held visit by the same rule: a non-final one without the sign-off, a final one only with it", async () => {
    const s = await setup(ctx);
    const jobId = await s.schedule("2026-03-01");
    const v1 = visit(s, jobId, { finalVisit: false, day: "2026-03-01" });
    await v1.draft(s.aApi);
    expect((await s.api.patch(`/jobs/${jobId}`, { technicianId: s.b.id })).statusCode).toBe(200);
    await v1.photo(s.aApi);
    expect((await v1.complete(s.aApi)).statusCode).toBe(202);
    const [held] = (await s.api.get("/work/conflicts")).json().items;
    const attached = await s.api.post(`/work/conflicts/${held.id}/attach`, {});
    expect(attached.statusCode, attached.body).toBe(200);
    expect((await s.api.get(`/work-orders/${s.wo.id}`)).json().status).toBe("open");

    const job2 = await s.schedule("2026-03-08");
    const v2 = visit(s, job2, { finalVisit: true, day: "2026-03-08" });
    await v2.draft(s.aApi);
    expect((await s.api.post(`/jobs/${job2}/cancel`, { reason: "Wrong day" })).statusCode).toBe(204);
    await v2.photo(s.aApi);
    expect((await v2.complete(s.aApi)).statusCode).toBe(202);
    const finalHeld = ((await s.api.get("/work/conflicts")).json().items as { id: string; status: string }[]).find((c) => c.status === "held")!;
    const refused = await s.api.post(`/work/conflicts/${finalHeld.id}/attach`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "record_incomplete", message: expect.stringContaining("Customer completion sign-off is required") });
    await v2.sign(s.aApi);
    expect((await s.api.post(`/work/conflicts/${finalHeld.id}/attach`, {})).statusCode).toBe(200);
    expect((await s.api.get(`/work-orders/${s.wo.id}`)).json().status).toBe("completed");
    expect(await signedFor(s.wo.id)).toBe(1);
  });

  it("keeps a form saved without the final-visit flag asking for its required sign-off on every visit, as before", async () => {
    const s = await setup(ctx);
    // A company's own version with a required sign-off and no flag, as any form saved before SW-7.
    const def = s.form.definition as TemplateDefinition;
    const everyVisit = { ...def, signatures: [{ key: "customer_completion", label: "Customer completion sign-off", signer: "customer", required: true }] };
    const saved = await s.api.post("/form-templates/work-installation/versions", { name: "Installation (ours)", definition: everyVisit });
    expect(saved.statusCode, saved.body).toBe(201);
    const v1 = visit(s, await s.schedule("2026-03-01"), { finalVisit: false, day: "2026-03-01", templateId: saved.json().id });
    await v1.draft(s.aApi);
    await v1.photo(s.aApi);
    const res = await v1.complete(s.aApi);
    expect(res.json()).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(res.json().validationProblems.map((p: { key: string }) => p.key)).toEqual(["customer_completion"]);
  });
});

describe("the work completion summary", () => {
  async function finished(s: Setup) {
    const v = visit(s, await s.schedule("2026-03-01"), { finalVisit: true, day: "2026-03-01" });
    await v.draft(s.aApi);
    await v.photo(s.aApi);
    await v.sign(s.aApi);
    expect((await v.complete(s.aApi)).json().status).toBe("completed");
  }

  it("is a PDF for the office once the work is completed, and listed in the customer's portal for that customer only", async () => {
    const s = await setup(ctx);
    const early = await s.api.get(`/work-orders/${s.wo.id}/completion-summary.pdf`);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("not_completed");
    await finished(s);

    const pdf = await s.api.get(`/work-orders/${s.wo.id}/completion-summary.pdf`);
    expect(pdf.statusCode, pdf.body).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    // Another company's id is not found.
    const other = await createTenant(ctx, "Org B");
    expect((await other.api.get(`/work-orders/${s.wo.id}/completion-summary.pdf`)).statusCode).toBe(404);

    const link = (await s.api.post(`/customers/${s.customer.id}/portal-link`, { send: false })).json();
    const token = new URL(link.url).pathname.split("/").at(-1)!;
    const view = (await ctx.app.inject({ method: "GET", url: `/portal/${token}` })).json();
    const site = view.sites.find((x: { id: string }) => x.id === s.site.id);
    expect(site.completedWork).toEqual([{ id: s.wo.id, label: expect.stringMatching(/^WO-\d+$/), title: "New conventional system", completedOn: "2026-03-01", url: `/portal/${token}/work-orders/${s.wo.id}/summary` }]);
    const opened = await ctx.app.inject({ method: "GET", url: site.completedWork[0].url });
    expect(opened.statusCode).toBe(200);
    expect(opened.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    // Another customer's link does not open it.
    const stranger = (await s.api.post("/customers", { displayName: "Someone else" })).json();
    const theirs = (await s.api.post(`/customers/${stranger.id}/portal-link`, { send: false })).json();
    const theirToken = new URL(theirs.url).pathname.split("/").at(-1)!;
    expect((await ctx.app.inject({ method: "GET", url: `/portal/${theirToken}/work-orders/${s.wo.id}/summary` })).statusCode).toBe(404);
  });

  it("is stamped as fictional for a demo company", async () => {
    const real = await setup(ctx);
    await finished(real);
    const plain = (await real.api.get(`/work-orders/${real.wo.id}/completion-summary.pdf`)).rawPayload;
    const s = await setup(ctx, { demo: true });
    await finished(s);
    const demo = (await s.api.get(`/work-orders/${s.wo.id}/completion-summary.pdf`)).rawPayload;
    expect(demo.subarray(0, 5).toString()).toBe("%PDF-");
    // The stamp is drawn on each page as a second content stream; the real company's copy has one.
    expect(demo.toString("latin1")).toContain("/Contents [");
    expect(plain.toString("latin1")).not.toContain("/Contents [");
  });
});

describe("system categories", () => {
  async function planOn(api: Api) {
    return (await api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
  }

  it("warns before an aerobic contract on a site whose systems are all recorded as non-aerobic, and starts it once confirmed", async () => {
    const t = await createTenant(ctx, "Org A");
    const plan = await planOn(t.api);
    const terms = () => t.api.get(`/sites/${t.site.id}/contract-terms?planId=${plan.id}&startOn=2026-03-01`);
    // The helper's system has no category: it might be aerobic, so nothing is said.
    expect((await terms()).json().systemWarning).toBeNull();
    expect((await t.api.patch(`/systems/${t.system.id}`, { systemCategory: "conventional" })).json().systemCategory).toBe("conventional");
    const warned = (await terms()).json().systemWarning;
    expect(warned).toBe("This site's system is recorded as conventional, not aerobic. An aerobic inspection contract is for an aerobic system. Start it anyway?");

    const body = { planId: plan.id, startOn: "2026-03-01" };
    const refused = await t.api.post(`/sites/${t.site.id}/contracts`, body);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "system_not_aerobic", message: warned });
    expect(await ctx.db.selectFrom("contracts").select("id").where("organizationId", "=", t.org.id).execute()).toEqual([]);
    const created = await t.api.post(`/sites/${t.site.id}/contracts`, { ...body, confirmSystemCategory: true });
    expect(created.statusCode, created.body).toBe(201);
  });

  it("says nothing when any system is aerobic or not known, or the site has no systems", async () => {
    const t = await createTenant(ctx, "Org A");
    const plan = await planOn(t.api);
    const warning = async (siteId: string) => (await t.api.get(`/sites/${siteId}/contract-terms?planId=${plan.id}&startOn=2026-03-01`)).json().systemWarning;
    await t.api.patch(`/systems/${t.system.id}`, { systemCategory: "conventional" });
    await t.api.post(`/sites/${t.site.id}/systems`, { systemCategory: "unknown" });
    expect(await warning(t.site.id)).toBeNull();
    const bare = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "2 Main St", city: "Austin" })).json();
    expect(await warning(bare.id)).toBeNull();
    const mixed = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "3 Main St", city: "Austin" })).json();
    await t.api.post(`/sites/${mixed.id}/systems`, { systemCategory: "aerobic" });
    await t.api.post(`/sites/${mixed.id}/systems`, { systemCategory: "drip" });
    expect(await warning(mixed.id)).toBeNull();
    // A switched-off system does not count.
    const old = (await t.api.post(`/sites/${bare.id}/systems`, { systemCategory: "aerobic", active: false })).json();
    await t.api.post(`/sites/${bare.id}/systems`, { systemCategory: "holding_tank" });
    expect(old.active).toBe(false);
    expect(await warning(bare.id)).toBe("This site's system is recorded as holding tank, not aerobic. An aerobic inspection contract is for an aerobic system. Start it anyway?");
  });

  it("refuses a category it does not know", async () => {
    const t = await createTenant(ctx, "Org A");
    expect((await t.api.patch(`/systems/${t.system.id}`, { systemCategory: "septic" })).statusCode).toBe(400);
    await expect(sql`update wastewater_systems set system_category = 'septic' where id = ${t.system.id}`.execute(ctx.db)).rejects.toThrow(/system_category/);
  });
});

describe("the conventional service form", () => {
  it("is the conventional service kind of work's form and completes a visit without any sign-off", async () => {
    const t = await createTenant(ctx, "Org A");
    const a = await createUser(ctx.db, t.org.id, "technician");
    const aApi = client(ctx.app, await login(ctx.app, a.email));
    const before = await complianceCounts(ctx, t.org.id);
    const kind = await typeOf(t.api, "conventional_service");
    const wo = (await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: kind.id })).json();
    const jobId = (await t.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: a.id, scheduledDate: "2026-03-01" })).json().visits[0].jobId;
    const form = (await aApi.get("/form-templates/work-conventional")).json();
    const values = { tank_count: 1, inlet_baffle: "good", outlet_baffle: "damaged", distribution_box: "good", field_condition: "wet", field_notes: "Soggy near line 3" };
    const base = { clientId: uuid(), jobId, templateId: form.id, revision: 1, arrivedAt: "2026-03-01T15:00:00Z", values, summary: null, finalVisit: true };
    expect((await aApi.put("/work/sync", { ...base, status: "draft" })).statusCode).toBe(200);
    const done = await aApi.put("/work/sync", { ...base, status: "completed", revision: 2, completedAt: "2026-03-01T16:00:00Z" });
    expect(done.json()).toMatchObject({ status: "completed", validationStatus: "valid" });
    expect((await t.api.get(`/work-orders/${wo.id}`)).json().status).toBe("completed");
    expect(await complianceCounts(ctx, t.org.id)).toEqual(before);
  });
});

describe("upgrading from SW-6 (0058) to 0059", () => {
  it("sets aerobic only where a site has an aerobic contract, unknown elsewhere, and adds the forms without moving a company's own links", async () => {
    const base = new URL(testDatabaseUrl());
    const name = `${base.pathname.slice(1)}_sw7_upgrade`;
    const admin = new pg.Client({ connectionString: Object.assign(new URL(base), { pathname: "/postgres" }).toString() });
    await admin.connect();
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.query(`create database "${name}"`);
    const url = Object.assign(new URL(base), { pathname: `/${name}` }).toString();
    const db = createDb(url);
    try {
      // Every migration up to SW-6, as main 57046ce left the database.
      const dir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
      const earlier = (await readdir(dir)).filter((f) => f.endsWith(".sql") && f < "0059").sort();
      expect(earlier.at(-1)).toBe("0058_pumping.sql");
      const raw = new pg.Client({ connectionString: url });
      await raw.connect();
      await raw.query("create table schema_migrations (name text primary key, applied_at timestamptz not null default now())");
      for (const f of earlier) {
        await raw.query(await readFile(dir + f, "utf8"));
        await raw.query("insert into schema_migrations (name) values ($1)", [f]);
      }
      const one = async <T>(q: string, params: unknown[]) => (await raw.query(q, params)).rows[0] as T;
      const org = await one<{ id: string }>("insert into organizations (name) values ('Old Co') returning id", []);
      const other = await one<{ id: string }>("insert into organizations (name) values ('Other Co') returning id", []);
      await raw.query("update work_types set default_form_template_key = 'our-install' where organization_id = $1 and key = 'installation'", [other.id]);
      const customer = await one<{ id: string }>("insert into customers (organization_id, display_name) values ($1, 'Pat') returning id", [org.id]);
      const site = (address: string) => one<{ id: string }>("insert into sites (organization_id, customer_id, address_line1, city) values ($1, $2, $3, 'Austin') returning id", [org.id, customer.id, address]);
      const [withContract, cancelledOnly, none] = [await site("1 Aerobic Rd"), await site("2 Lapsed Rd"), await site("3 Unknown Rd")];
      const system = (siteId: string, systemType: string | null) =>
        one<{ id: string }>("insert into wastewater_systems (organization_id, site_id, system_type) values ($1, $2, $3) returning id", [org.id, siteId, systemType]);
      const aerobic = await system(withContract.id, null);
      const lapsed = await system(cancelledOnly.id, null);
      // Free text saying "conventional" is not trusted: only contracts are.
      const texted = await system(none.id, "conventional septic");
      const contract = (siteId: string, status: string) =>
        raw.query(
          `insert into contracts (organization_id, site_id, plan_name, start_on, end_on, term_months, visits_per_term, price_cents, billing_frequency, service_type, status, cancelled_at, cancel_reason)
           values ($1, $2, 'Annual', '2025-01-01', '2025-12-31', 12, 3, 27500, 'annual', 'aerobic_inspection', $3, $4, $5)`,
          [org.id, siteId, status, status === "cancelled" ? new Date() : null, status === "cancelled" ? "Moved" : null],
        );
      await contract(withContract.id, "active");
      await contract(cancelledOnly.id, "cancelled");
      await raw.end();

      await migrate(url);
      await ensureBuiltInForms(db);
      const category = async (id: string) => (await db.selectFrom("wastewaterSystems").select("systemCategory").where("id", "=", id).executeTakeFirstOrThrow()).systemCategory;
      expect([await category(aerobic.id), await category(lapsed.id), await category(texted.id)]).toEqual(["aerobic", "aerobic", "unknown"]);
      // The free-text columns are kept as they were.
      expect((await db.selectFrom("wastewaterSystems").select("systemType").where("id", "=", texted.id).executeTakeFirstOrThrow()).systemType).toBe("conventional septic");
      // An earlier release adding a system leaves the category unset.
      const oldWriter = await sql<{ systemCategory: string | null }>`insert into wastewater_systems (organization_id, site_id, manufacturer) values (${org.id}, ${none.id}, 'Acme') returning system_category`.execute(db);
      expect(oldWriter.rows[0]!.systemCategory).toBeNull();

      const kinds = async (o: string) => (await db.selectFrom("workTypes").select(["key", "defaultFormTemplateKey"]).where("organizationId", "=", o).orderBy("position").execute()).map((k) => [k.key, k.defaultFormTemplateKey]);
      expect(await kinds(org.id)).toEqual([
        ["pumping", "work-pumping"],
        ["repair", "work-repair"],
        ["installation", "work-installation"],
        ["service_call", "work-service-call"],
        ["conventional_service", "work-conventional"],
      ]);
      // A company's own installation form stays linked.
      expect((await kinds(other.id))[2]).toEqual(["installation", "our-install"]);
      const forms = await db.selectFrom("inspectionTemplates").select(["key", "purpose"]).where("organizationId", "is", null).where("key", "in", ["work-conventional", "work-installation"]).orderBy("key").execute();
      expect(forms).toEqual([
        { key: "work-conventional", purpose: "work" },
        { key: "work-installation", purpose: "work" },
      ]);
      // No contract, obligation or filing was touched.
      expect(Number((await sql<{ n: string }>`select count(*) as n from service_obligations`.execute(db)).rows[0]!.n)).toBe(0);
    } finally {
      await db.destroy();
      await admin.query(`drop database if exists "${name}" with (force)`);
      await admin.end();
    }
  });
});
