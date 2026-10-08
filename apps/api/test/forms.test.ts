import { createDb, ensureBuiltInForms, migrate, type Database } from "@aerowise/db";
import { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_KEY, GENERIC_REPAIR_TEMPLATE, GENERIC_SERVICE_CALL_TEMPLATE, templateDefinition } from "@aerowise/domain";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./db-url.ts";
import { client, createTenant, createUser, login, setupTestApp } from "./helpers.ts";
import { payload, setup } from "./inspection-helpers.ts";

const ctx = setupTestApp({ features: ["work_orders"] });

const repairDefinition = {
  ...GENERIC_REPAIR_TEMPLATE.definition,
  fields: [...GENERIC_REPAIR_TEMPLATE.definition.fields, { key: "warranty", label: "Under warranty", section: "Repair", type: "boolean" }],
};

// What every release up to SW-F part 2 runs, copied from apps/api/src/routes/inspections.ts as of
// 79b3c12: the inspection form is the company's newest 'aerobic-standard' version, else the
// built-in one; a template id is accepted if the company can see it; a new version leaves out
// any purpose.
const old = {
  activeTemplate: async (db: Database, organizationId: string) =>
    (
      await sql<{ id: string; key: string; version: number }>`
        select id, key, version from inspection_templates
        where organization_id = ${organizationId} and key = ${DEFAULT_TEMPLATE.key}
        order by version desc limit 1`.execute(db)
    ).rows[0] ??
    (
      await sql<{ id: string; key: string; version: number }>`
        select id, key, version from inspection_templates
        where organization_id is null and key = ${DEFAULT_TEMPLATE.key} and version = ${DEFAULT_TEMPLATE.version}`.execute(db)
    ).rows[0],
  saveVersion: (db: Database, organizationId: string, version: number) =>
    sql`insert into inspection_templates (organization_id, key, version, name, definition, created_by)
        values (${organizationId}, ${DEFAULT_TEMPLATE.key}, ${version}, 'Our inspection', ${JSON.stringify(DEFAULT_TEMPLATE.definition)}, null)
        returning id`.execute(db),
};

describe("work forms", () => {
  it("lists the starter work forms and points repair and service calls at them", async () => {
    const t = await createTenant(ctx, "Org A");
    const forms = (await t.api.get("/form-templates?purpose=work")).json().items;
    expect(forms.map((f: { key: string; version: number; purpose: string; builtIn: boolean }) => [f.key, f.version, f.purpose, f.builtIn])).toEqual([
      ["work-repair", 1, "work", true],
      ["work-service-call", 1, "work", true],
    ]);
    expect(forms[0].definition.signatures).toEqual([{ key: "customer_signoff", label: "Customer sign-off", signer: "customer", required: false }]);
    // The inspection form is listed under its own purpose, and never as a work form.
    const inspection = (await t.api.get("/form-templates?purpose=inspection")).json().items;
    expect(inspection.map((f: { key: string }) => f.key)).toEqual([DEFAULT_TEMPLATE_KEY]);

    const types = (await t.api.get("/work-types")).json().items as { key: string; defaultFormTemplateKey: string | null }[];
    expect(types.map((x) => [x.key, x.defaultFormTemplateKey])).toEqual([
      ["pumping", null],
      ["repair", "work-repair"],
      ["installation", null],
      ["service_call", "work-service-call"],
    ]);

    // A technician reads forms; only an owner saves versions.
    const tech = await createUser(ctx.db, t.org.id, "technician");
    const techApi = client(ctx.app, await login(ctx.app, tech.email));
    expect((await techApi.get("/form-templates/work-service-call")).json()).toMatchObject({ key: "work-service-call", name: GENERIC_SERVICE_CALL_TEMPLATE.name });
    expect((await techApi.post("/form-templates/work-repair/versions", { name: "Repair", definition: repairDefinition })).statusCode).toBe(403);
  });

  it("saves a company's own version after the built-in one, leaving every saved version as it was", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const v2 = await a.api.post("/form-templates/work-repair/versions", { name: "Repair (ours)", definition: repairDefinition });
    expect(v2.statusCode, v2.body).toBe(201);
    expect(v2.json()).toMatchObject({ key: "work-repair", version: 2, purpose: "work", builtIn: false, name: "Repair (ours)" });
    const v3 = await a.api.post("/form-templates/work-repair/versions", { name: "Repair (ours, again)", definition: GENERIC_REPAIR_TEMPLATE.definition });
    expect(v3.json()).toMatchObject({ version: 3 });
    expect((await a.api.get("/form-templates/work-repair")).json()).toMatchObject({ version: 3, name: "Repair (ours, again)" });
    // Another company still gets the built-in form.
    expect((await b.api.get("/form-templates/work-repair")).json()).toMatchObject({ version: 1, builtIn: true });

    await expect(sql`update inspection_templates set name = 'changed' where id = ${v2.json().id}`.execute(ctx.db)).rejects.toThrow(/immutable/);
    const kept = await ctx.db.selectFrom("inspectionTemplates").select(["name", "definition"]).where("id", "=", v2.json().id).executeTakeFirstOrThrow();
    expect(kept).toEqual({ name: "Repair (ours)", definition: templateDefinition.parse(repairDefinition) });
  });

  it("changes only work forms here, and refuses a form that is not valid", async () => {
    const t = await createTenant(ctx, "Org A");
    const inspection = await t.api.post(`/form-templates/${DEFAULT_TEMPLATE_KEY}/versions`, { name: "Ours", definition: DEFAULT_TEMPLATE.definition });
    expect(inspection.statusCode).toBe(409);
    expect((await t.api.post("/form-templates/work-nothing/versions", { name: "Ours", definition: repairDefinition })).statusCode).toBe(404);
    const clash = await t.api.post("/form-templates/work-repair/versions", {
      name: "Ours",
      definition: { ...repairDefinition, signatures: [{ key: "problem", label: "Customer", signer: "customer" }] },
    });
    expect(clash.statusCode).toBe(400);
    expect(await ctx.db.selectFrom("inspectionTemplates").select("id").where("organizationId", "=", t.org.id).execute()).toEqual([]);
  });

  it("lets a kind of work point only at a work form the company can use", async () => {
    const t = await createTenant(ctx, "Org A");
    const types = (await t.api.get("/work-types")).json().items as { id: string; key: string }[];
    const pumping = types.find((x) => x.key === "pumping")!;
    expect((await t.api.patch(`/work-types/${pumping.id}`, { defaultFormTemplateKey: DEFAULT_TEMPLATE_KEY })).statusCode).toBe(422);
    expect((await t.api.patch(`/work-types/${pumping.id}`, { defaultFormTemplateKey: "work-nothing" })).statusCode).toBe(422);
    const set = await t.api.patch(`/work-types/${pumping.id}`, { defaultFormTemplateKey: "work-service-call" });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().defaultFormTemplateKey).toBe("work-service-call");
    expect((await t.api.patch(`/work-types/${pumping.id}`, { defaultFormTemplateKey: null })).json().defaultFormTemplateKey).toBeNull();

    const added = await t.api.post("/work-types", { key: "jetting", name: "Line jetting", category: "repair", defaultFormTemplateKey: "work-repair" });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json().defaultFormTemplateKey).toBe("work-repair");
    expect((await t.api.post("/work-types", { key: "bad", name: "Bad", category: "repair", defaultFormTemplateKey: "work-nothing" })).statusCode).toBe(422);
    // The database refuses the inspection form whatever writes it.
    await expect(sql`update work_types set default_form_template_key = ${DEFAULT_TEMPLATE_KEY} where id = ${pumping.id}`.execute(ctx.db)).rejects.toThrow(/work_types_form_not_inspection/);
  });

  it("accepts the new signed document kinds", async () => {
    const t = await createTenant(ctx, "Org A");
    // A work-completion signature also names its phone ids and requirement (0055).
    await sql`insert into signed_documents (organization_id, kind, site_id, customer_id, title, content, content_sha256, signer_name, signature_kind, consent_text, signed_at, offline_client_id, record_client_id, requirement_key)
      values (${t.org.id}, 'work_completion', ${t.site.id}, ${t.customer.id}, 'Work done', '{}', 'x', 'Pat', 'typed', 'I agree', now(), gen_random_uuid(), gen_random_uuid(), 'customer_signoff')`.execute(ctx.db);
    // An estimate acceptance is an allowed kind, but only with the estimate it accepts (SW-5a,
    // migration 0054); estimates.test.ts signs real ones.
    const kinds = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'signed_documents_kind_check'`.execute(ctx.db);
    expect(kinds.rows[0]!.def).toContain("estimate_acceptance");
    await expect(
      sql`insert into signed_documents (organization_id, kind, site_id, customer_id, title, content, content_sha256, signer_name, signature_kind, consent_text, signed_at)
        values (${t.org.id}, 'estimate_acceptance', ${t.site.id}, ${t.customer.id}, 'Estimate', '{}', 'x', 'Pat', 'typed', 'I agree', now())`.execute(ctx.db),
    ).rejects.toThrow(/signed_documents_estimate_check/);
    await expect(
      sql`insert into signed_documents (organization_id, kind, site_id, customer_id, title, content, content_sha256, signer_name, signature_kind, consent_text, signed_at)
        values (${t.org.id}, 'work_completion', ${t.site.id}, ${t.customer.id}, 'Work done', '{}', 'x', 'Pat', 'typed', 'I agree', now())`.execute(ctx.db),
    ).rejects.toThrow(/signed_documents_work_completion_owner/);
    await expect(
      sql`insert into signed_documents (organization_id, kind, site_id, customer_id, title, content, content_sha256, signer_name, signature_kind, consent_text, signed_at)
        values (${t.org.id}, 'permit', ${t.site.id}, ${t.customer.id}, 'Permit', '{}', 'x', 'Pat', 'typed', 'I agree', now())`.execute(ctx.db),
    ).rejects.toThrow(/signed_documents_kind_check/);
  });
});

describe("the inspection form after work forms are added", () => {
  it("is still what an older release serves and accepts, and an inspection can never use a work form", async () => {
    const s = await setup(ctx);
    // Built-in forms of every purpose, plus the company's own work form versions.
    await ensureBuiltInForms(ctx.db);
    expect((await s.api.post("/form-templates/work-repair/versions", { name: "Repair (ours)", definition: repairDefinition })).statusCode).toBe(201);
    expect((await s.api.post("/form-templates/work-service-call/versions", { name: "Call (ours)", definition: GENERIC_SERVICE_CALL_TEMPLATE.definition })).statusCode).toBe(201);

    // This release and the older one give the phone the same inspection form.
    const now = (await s.techApi.get("/inspection-template")).json();
    expect(now).toMatchObject({ key: DEFAULT_TEMPLATE_KEY, version: DEFAULT_TEMPLATE.version, builtIn: true });
    expect(await old.activeTemplate(ctx.db, s.org.id)).toMatchObject({ id: now.id, key: DEFAULT_TEMPLATE_KEY });
    // An older release saving its own inspection version gets an inspection form, and serves it.
    const saved = (await old.saveVersion(ctx.db, s.org.id, 1)).rows[0] as { id: string };
    expect((await ctx.db.selectFrom("inspectionTemplates").select("purpose").where("id", "=", saved.id).executeTakeFirstOrThrow()).purpose).toBe("inspection");
    expect((await old.activeTemplate(ctx.db, s.org.id))?.id).toBe(saved.id);
    expect((await s.techApi.get("/inspection-template")).json().id).toBe(saved.id);

    // A work form's id is refused for an inspection: by this release's sync, and by the database
    // for an older release that only checks the company can see the template.
    const work = (await s.api.get("/form-templates/work-repair")).json();
    const sent = await s.techApi.put("/inspections/sync", payload(s, { templateId: work.id }));
    expect(sent.statusCode).toBe(422);
    expect(sent.json().message).toMatch(/templateId does not match/);
    expect((await s.techApi.get(`/inspection-templates/${work.id}`)).statusCode).toBe(404);
    await expect(
      sql`insert into inspections (organization_id, offline_client_id, job_id, site_id, template_id, technician_user_id, arrived_at)
        values (${s.org.id}, gen_random_uuid(), ${s.job.jobId}, ${s.site.id}, ${work.id}, ${s.tech.id}, now())`.execute(ctx.db),
    ).rejects.toThrow(/must use an inspection template/);
    // The inspection form itself still syncs.
    expect((await s.techApi.put("/inspections/sync", payload(s, { templateId: saved.id }))).statusCode).toBe(200);
  });

  it("can never be saved as a work or intake form", async () => {
    for (const purpose of ["work", "intake"]) {
      await expect(
        sql`insert into inspection_templates (organization_id, key, version, name, purpose, definition) values (null, ${DEFAULT_TEMPLATE_KEY}, 99, 'x', ${purpose}, '{}')`.execute(ctx.db),
      ).rejects.toThrow(/inspection_templates_inspection_key/);
    }
  });
});

describe("upgrading a database written by the earlier release", () => {
  it("keeps every existing template an inspection form, links the starter kinds of work and keeps a company's own links", async () => {
    const base = new URL(testDatabaseUrl());
    const name = `${base.pathname.slice(1)}_forms_upgrade`;
    const admin = new pg.Client({ connectionString: Object.assign(new URL(base), { pathname: "/postgres" }).toString() });
    await admin.connect();
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.query(`create database "${name}"`);
    const url = Object.assign(new URL(base), { pathname: `/${name}` }).toString();
    const db = createDb(url);
    try {
      // Every migration before this one, as the earlier release left the database.
      const dir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
      const earlier = (await readdir(dir)).filter((f) => f.endsWith(".sql") && f < "0051_form_purposes.sql").sort();
      const raw = new pg.Client({ connectionString: url });
      await raw.connect();
      await raw.query("create table schema_migrations (name text primary key, applied_at timestamptz not null default now())");
      for (const f of earlier) {
        await raw.query(await readFile(dir + f, "utf8"));
        await raw.query("insert into schema_migrations (name) values ($1)", [f]);
      }
      // The earlier release's data: a company with its own inspection version and a repair kind
      // the company already pointed at its own form key.
      const org = (await raw.query<{ id: string }>("insert into organizations (name) values ('Old Co') returning id")).rows[0]!;
      const other = (await raw.query<{ id: string }>("insert into organizations (name) values ('Other Co') returning id")).rows[0]!;
      await raw.query("insert into inspection_templates (organization_id, key, version, name, definition) values ($1, $2, 1, 'Ours', $3)", [org.id, DEFAULT_TEMPLATE_KEY, JSON.stringify(DEFAULT_TEMPLATE.definition)]);
      await raw.query("update work_types set default_form_template_key = 'our-repair' where organization_id = $1 and key = 'repair'", [other.id]);
      await raw.end();

      await migrate(url);
      await ensureBuiltInForms(db);
      const templates = await db.selectFrom("inspectionTemplates").select(["organizationId", "key", "purpose"]).orderBy("key").execute();
      expect(templates.filter((r) => r.organizationId === org.id)).toEqual([{ organizationId: org.id, key: DEFAULT_TEMPLATE_KEY, purpose: "inspection" }]);
      expect(templates.filter((r) => r.organizationId === null).map((r) => [r.key, r.purpose])).toEqual([
        [DEFAULT_TEMPLATE_KEY, "inspection"],
        ["work-repair", "work"],
        ["work-service-call", "work"],
      ]);
      const links = await db.selectFrom("workTypes").select(["organizationId", "key", "defaultFormTemplateKey"]).where("key", "in", ["repair", "service_call", "pumping"]).orderBy("key").execute();
      const linkOf = (o: string, k: string) => links.find((l) => l.organizationId === o && l.key === k)?.defaultFormTemplateKey;
      expect([linkOf(org.id, "repair"), linkOf(org.id, "service_call"), linkOf(org.id, "pumping")]).toEqual(["work-repair", "work-service-call", null]);
      expect(linkOf(other.id, "repair")).toBe("our-repair");
      // A company created after the upgrade starts linked too.
      const fresh = await db.insertInto("organizations").values({ name: "New Co" } as never).returning("id").executeTakeFirstOrThrow();
      const freshTypes = await db.selectFrom("workTypes").select(["key", "defaultFormTemplateKey"]).where("organizationId", "=", fresh.id).orderBy("position").execute();
      expect(freshTypes.map((x) => x.defaultFormTemplateKey)).toEqual([null, "work-repair", null, "work-service-call"]);
      // The older release still finds its own inspection form, not a work form.
      expect(await old.activeTemplate(db, org.id)).toMatchObject({ key: DEFAULT_TEMPLATE_KEY, version: 1 });
      // Adding the built-in forms again changes nothing.
      expect(await ensureBuiltInForms(db)).toBe(0);
    } finally {
      await db.destroy();
      await admin.query(`drop database if exists "${name}" with (force)`);
      await admin.end();
    }
  });
});
