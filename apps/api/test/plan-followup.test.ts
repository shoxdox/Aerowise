import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reseedDemo } from "@aerowise/db";
import type { Feature } from "@aerowise/domain";
import { canonicalJson, sha256Hex } from "@aerowise/renewals";
import { LocalDiskStore } from "@aerowise/storage";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { playDemoStory } from "../src/demo-story.ts";
import { client, createTenant, setupTestApp } from "./helpers.ts";

// SW-8 follow-up: plan options on contracts the office makes, intake questions answered at
// online signing (an SW-F intake form), and the demo's fictional plan tiers. The pinned clock
// is 2026-03-01.

const ON: Feature[] = ["work_orders", "service_items", "plan_builder"];
const ctx = setupTestApp({ features: ON });

type Tenant = Awaited<ReturnType<typeof createTenant>>;
type Api = Tenant["api"];

const appWithout = () => buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store, loginRateLimit: 1000, features: new Set<Feature>(["work_orders", "service_items"]) });

const OPTIONS = [
  { optionKey: "filter", name: "Effluent filter cleaning", priceCents: 2500, required: true, default: true },
  { optionKey: "alarm", name: "Alarm battery", priceCents: 4000, taxable: true, default: true },
  { optionKey: "riser", name: "Riser lid", priceCents: 9000 },
];

const INTAKE = {
  key: "renewal-questions",
  name: "Before you renew",
  definition: {
    photos: [],
    fields: [
      { key: "changes", label: "Anything changed at the property?", section: "Before you sign", type: "boolean", required: true },
      { key: "what_changed", label: "What changed?", section: "Before you sign", type: "text", required: true, showWhen: { field: "changes", in: [true] } },
      {
        key: "visit_time",
        label: "Preferred visit time",
        section: "Before you sign",
        type: "select",
        options: [
          { value: "am", label: "Morning" },
          { value: "pm", label: "Afternoon" },
        ],
      },
    ],
  },
};

async function plan(api: Api, version: object = {}) {
  const p = (await api.post("/plans", { name: "Gold", termMonths: 12, visitsPerTerm: 2, priceCents: 40000, billingFrequency: "semiannual" })).json();
  const res = await api.post(`/plans/${p.id}/versions`, { termsText: null, options: OPTIONS, coverage: [], ...version });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; currentVersionId: string; version: number };
}

async function intakeForm(api: Api, body: object = INTAKE) {
  const res = await api.post("/intake-forms", body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; key: string; version: number; purpose: string };
}

describe("options on a contract the office makes", () => {
  it("takes the required options and those ticked, keeps them in the agreement snapshot and bills them once with the first payment", async () => {
    const t = await createTenant(ctx, "Org A");
    const p = await plan(t.api);
    expect((await t.api.post(`/sites/${t.site.id}/contracts`, { planId: p.id, startOn: "2026-01-01", optionKeys: ["gold-plated"] })).statusCode).toBe(422);

    const res = await t.api.post(`/sites/${t.site.id}/contracts`, { planId: p.id, startOn: "2026-01-01", optionKeys: ["alarm"] });
    expect(res.statusCode, res.body).toBe(201);
    const contract = res.json();
    expect(contract.options).toEqual([
      { optionKey: "filter", name: "Effluent filter cleaning", priceCents: 2500, taxable: false },
      { optionKey: "alarm", name: "Alarm battery", priceCents: 4000, taxable: true },
    ]);
    const row = await ctx.db.selectFrom("contracts").select(["priceCents", "agreementSnapshot"]).where("id", "=", contract.id).executeTakeFirstOrThrow();
    // The plan price is unchanged: options are charged on their own lines.
    expect(row.priceCents).toBe(40000);
    expect((row.agreementSnapshot as { options: { optionKey: string }[] }).options.map((o) => o.optionKey)).toEqual(["filter", "alarm"]);

    const first = (await t.api.post(`/contracts/${contract.id}/invoice`, {})).json();
    expect(first.lines.map((l: { description: string; amountCents: number; taxable: boolean; installment: number }) => [l.description.split(":")[0], l.amountCents, l.taxable, l.installment])).toEqual([
      ["Gold, 1 Main St", 20000, false, 1],
      ["Gold option", 2500, false, 1],
      ["Gold option", 4000, true, 1],
    ]);
    expect(first.lines[2].description).toBe("Gold option: Alarm battery");
    const second = (await t.api.post(`/contracts/${contract.id}/invoice`, {})).json();
    expect(second.lines.map((l: { amountCents: number; installment: number }) => [l.amountCents, l.installment])).toEqual([[20000, 2]]);
  });

  it("charges nothing unasked: without optionKeys only required options; a plan without options is unchanged", async () => {
    const t = await createTenant(ctx, "Org A");
    const p = await plan(t.api);
    const c = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: p.id, startOn: "2026-01-01" })).json();
    expect(c.options.map((o: { optionKey: string }) => o.optionKey)).toEqual(["filter"]);

    const plain = (await t.api.post("/plans", { name: "Plain", termMonths: 12, visitsPerTerm: 2, priceCents: 30000 })).json();
    const site2 = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "2 Main St", city: "Austin" })).json();
    expect((await t.api.post(`/sites/${site2.id}/contracts`, { planId: plain.id, startOn: "2026-01-01", optionKeys: ["filter"] })).statusCode).toBe(422);
    const c2 = (await t.api.post(`/sites/${site2.id}/contracts`, { planId: plain.id, startOn: "2026-01-01" })).json();
    expect(c2.options).toEqual([]);
    const snapshot = (await ctx.db.selectFrom("contracts").select("agreementSnapshot").where("id", "=", c2.id).executeTakeFirstOrThrow()).agreementSnapshot as object;
    // A snapshot without options reads exactly as one made before options existed.
    expect(Object.keys(snapshot).sort()).toEqual(["coverage", "format", "plan", "signed", "terms"]);
  });

  it("with the plan builder off, refuses options and makes the contract and its invoice as before", async () => {
    const t = await createTenant(ctx, "Org A");
    const p = await plan(t.api);
    const off = client(await appWithout(), t.cookie);
    const refused = await off.post(`/sites/${t.site.id}/contracts`, { planId: p.id, startOn: "2026-01-01", optionKeys: ["alarm"] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("feature_off");
    const c = (await off.post(`/sites/${t.site.id}/contracts`, { planId: p.id, startOn: "2026-01-01" })).json();
    expect(c.options).toEqual([]);
    const inv = (await off.post(`/contracts/${c.id}/invoice`, {})).json();
    expect(inv.lines.map((l: { amountCents: number }) => l.amountCents)).toEqual([20000]);
  });

  it("offers options on an office renewal too", async () => {
    const t = await createTenant(ctx, "Org A");
    const p = await plan(t.api);
    const c = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: p.id, startOn: "2025-03-01" })).json();
    const renewed = await t.api.post(`/contracts/${c.id}/renew`, { optionKeys: ["riser"] });
    expect(renewed.statusCode, renewed.body).toBe(201);
    expect(renewed.json().options.map((o: { optionKey: string }) => o.optionKey)).toEqual(["filter", "riser"]);
  });
});

describe("intake forms", () => {
  it("are versioned intake forms, questions only, never on a key another kind of form uses, and need the plan builder", async () => {
    const t = await createTenant(ctx, "Org A");
    const v1 = await intakeForm(t.api);
    expect(v1).toMatchObject({ key: "renewal-questions", version: 1, purpose: "intake" });
    const v2 = await intakeForm(t.api, { ...INTAKE, name: "Before you renew (2)" });
    expect(v2.version).toBe(2);
    const listed = (await t.api.get("/form-templates?purpose=intake")).json().items;
    expect(listed.map((f: { key: string; version: number }) => [f.key, f.version])).toEqual([["renewal-questions", 2]]);

    expect((await t.api.post("/intake-forms", { ...INTAKE, key: "photos", definition: { ...INTAKE.definition, photos: [{ key: "tank", label: "Tank", minCount: 1 }] } })).statusCode).toBe(400);
    expect((await t.api.post("/intake-forms", { ...INTAKE, key: "sig", definition: { ...INTAKE.definition, signatures: [{ key: "cust", label: "Customer", signer: "customer" }] } })).statusCode).toBe(400);
    // The built-in repair work form's key, and the inspection form's.
    expect((await t.api.post("/intake-forms", { ...INTAKE, key: "work-repair" })).statusCode).toBe(409);
    expect((await t.api.post("/intake-forms", { ...INTAKE, key: "aerobic-standard" })).statusCode).toBe(409);
    expect((await client(await appWithout(), t.cookie).post("/intake-forms", { ...INTAKE, key: "other" })).statusCode).toBe(409);
    // The work-form route still refuses to version an intake form.
    expect((await t.api.post("/form-templates/renewal-questions/versions", { name: "x", definition: INTAKE.definition })).statusCode).toBe(409);
  });

  it("go on a plan version only when they are the company's own intake forms, and stay through later plan changes", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const theirs = await intakeForm(b.api);
    const mine = await intakeForm(a.api);
    const p = (await a.api.post("/plans", { name: "Gold", termMonths: 12, visitsPerTerm: 2, priceCents: 40000 })).json();
    expect((await a.api.post(`/plans/${p.id}/versions`, { termsText: null, options: [], coverage: [], intakeTemplateId: theirs.id })).statusCode).toBe(422);
    await a.api.get("/form-templates"); // adds the built-in forms, as the API does when it starts
    const repairForm = await ctx.db.selectFrom("inspectionTemplates").select("id").where("key", "=", "work-repair").executeTakeFirstOrThrow();
    expect((await a.api.post(`/plans/${p.id}/versions`, { termsText: null, options: [], coverage: [], intakeTemplateId: repairForm.id })).statusCode).toBe(422);

    const saved = (await a.api.post(`/plans/${p.id}/versions`, { termsText: null, options: [], coverage: [], intakeTemplateId: mine.id })).json();
    expect(saved.versions[0].intake).toEqual({ id: mine.id, key: "renewal-questions", version: 1, name: "Before you renew" });
    expect(saved.preview.intake).toEqual({ name: "Before you renew", questions: ["Anything changed at the property?", "What changed?", "Preferred visit time"] });
    // A price change makes a version that keeps the form.
    const v3 = (await a.api.patch(`/plans/${p.id}`, { priceCents: 41000 })).json();
    expect(v3.version).toBe(3);
    expect((await a.api.get(`/plans/${p.id}`)).json().versions[0].intake.id).toBe(mine.id);

    // The database refuses another company's form, or a form that is not an intake form, written directly.
    const insert = (templateId: string) => sql`
      insert into plan_versions (organization_id, plan_id, version, name, customer_type, term_months, visits_per_term, price_cents, billing_frequency, service_type, intake_template_id)
      values (${a.org.id}, ${p.id}, 99, 'x', 'residential', 12, 2, 1, 'annual', 'aerobic_inspection', ${templateId})`.execute(ctx.db);
    await expect(insert(theirs.id)).rejects.toThrow(/intake form of its own company/);
    await expect(insert(repairForm.id)).rejects.toThrow(/intake form of its own company/);
  });
});

describe("intake at online signing", () => {
  async function offered(t: Tenant) {
    await t.api.post(`/customers/${t.customer.id}/contacts`, { name: "Billing", email: "billing@a.test", type: "billing" });
    const form = await intakeForm(t.api);
    const p = await plan(t.api, { intakeTemplateId: form.id });
    const contract = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: p.id, startOn: "2025-04-01" })).json();
    const r = (await t.api.post(`/contracts/${contract.id}/renewal`, {})).json();
    return { form, plan: p, renewal: r as { id: string; link: string }, token: (r.link as string).split("/renew/")[1]! };
  }

  it("asks the questions, refuses an incomplete answer, and keeps the answers only in the signed agreement", async () => {
    const t = await createTenant(ctx, "Org A");
    const { form, renewal, token } = await offered(t);
    const anon = client(ctx.app);
    const view = (await anon.get(`/renew/${token}`)).json();
    expect(view.intake.name).toBe("Before you renew");
    expect(view.intake.definition.fields.map((f: { key: string }) => f.key)).toEqual(["changes", "what_changed", "visit_time"]);

    const sign = (intakeAnswers: object) =>
      anon.post(`/renew/${token}/sign`, { version: 1, contact: { email: "pat@example.test" }, signerName: "Pat Homeowner", signature: { kind: "typed" }, agree: true, intakeAnswers });
    const missing = await sign({});
    expect(missing.statusCode).toBe(422);
    expect(missing.json().message).toContain("Anything changed at the property? is required");
    // A question shown by an earlier answer becomes required with it.
    expect((await sign({ changes: true })).json().message).toContain("What changed? is required");
    expect((await sign({ changes: true, what_changed: "New driveway", visit_time: "midnight" })).statusCode).toBe(422);
    expect(await ctx.db.selectFrom("signedDocuments").select("id").where("renewalId", "=", renewal.id).execute()).toEqual([]);

    // An answer to a question the form does not show is not kept.
    const signed = await sign({ changes: false, what_changed: "ignored", visit_time: "pm" });
    expect(signed.statusCode, signed.body).toBe(200);
    const doc = await ctx.db.selectFrom("signedDocuments").select(["content", "contentSha256"]).where("renewalId", "=", renewal.id).executeTakeFirstOrThrow();
    const content = doc.content as { intake: unknown };
    expect(content.intake).toEqual({
      templateId: form.id,
      key: "renewal-questions",
      version: 1,
      name: "Before you renew",
      answers: [
        { key: "changes", label: "Anything changed at the property?", value: false, answer: "No" },
        { key: "visit_time", label: "Preferred visit time", value: "pm", answer: "Afternoon" },
      ],
    });
    expect(doc.contentSha256).toBe(sha256Hex(canonicalJson(content)));
    expect((await t.api.get(`/renewals/${renewal.id}`)).json().intake).toEqual(content.intake);
    // Once signed, the page no longer asks.
    expect((await anon.get(`/renew/${token}`)).json().intake).toBeNull();
    // Versions stay immutable, the one the answers name included.
    await expect(sql`update inspection_templates set name = 'changed' where id = ${form.id}`.execute(ctx.db)).rejects.toThrow();
  });

  it("with the plan builder off, asks nothing and signs the agreement exactly as before", async () => {
    const t = await createTenant(ctx, "Org A");
    const { renewal, token } = await offered(t);
    const anon = client(await appWithout());
    expect((await anon.get(`/renew/${token}`)).json().intake).toBeNull();
    const signed = await anon.post(`/renew/${token}/sign`, { version: 1, contact: { email: "pat@example.test" }, signerName: "Pat Homeowner", signature: { kind: "typed" }, agree: true });
    expect(signed.statusCode, signed.body).toBe(200);
    const doc = await ctx.db.selectFrom("signedDocuments").select("content").where("renewalId", "=", renewal.id).executeTakeFirstOrThrow();
    expect(Object.keys(doc.content as object).sort()).toEqual(["addons", "charges", "customer", "format", "offerVersion", "previousTerm", "provider", "serviceAddress", "term", "terms", "title"]);
  });
});

describe("the demo's plan tiers", () => {
  it("adds fictional Basic, Gold and Platinum tiers with different coverage when the plan builder is on, and the reset clears them", async () => {
    const files = mkdtempSync(join(tmpdir(), "aerowise-story-"));
    await reseedDemo(ctx.db, { filesDir: files });
    expect(await playDemoStory({ db: ctx.db, store: new LocalDiskStore(files), features: new Set<Feature>(ON) })).toBe(true);
    const tiers = await ctx.db
      .selectFrom("plans as p")
      .innerJoin("planVersions as v", "v.id", "p.currentVersionId")
      .innerJoin("organizations as o", "o.id", "p.organizationId")
      .select(["p.name", "p.organizationId", "v.termsText", "v.coverage", "v.options", "v.intakeTemplateId", "o.demo"])
      .where("p.name", "like", "%(demo)")
      .orderBy("p.priceCents")
      .execute();
    expect(tiers.map((t) => t.name)).toEqual(["Basic (demo)", "Gold (demo)", "Platinum (demo)"]);
    expect(tiers.every((t) => t.demo && t.termsText?.startsWith("DEMO ONLY.") && t.termsText.includes("no service or coverage is promised"))).toBe(true);
    const ruleKeys = tiers.map((t) => (t.coverage as { ruleKey: string }[]).map((r) => r.ruleKey));
    expect(ruleKeys).toEqual([["pumping-discount"], ["repairs", "pumping-discount"], ["repairs", "pumping", "service-calls"]]);
    expect(tiers.map((t) => t.intakeTemplateId !== null)).toEqual([false, true, true]);
    expect(tiers.map((t) => (t.options as unknown[]).length)).toEqual([0, 1, 2]);

    await reseedDemo(ctx.db, { filesDir: files });
    expect(await ctx.db.selectFrom("plans").select("id").where("organizationId", "=", tiers[0]!.organizationId).where("name", "like", "%(demo)").execute()).toEqual([]);
    // It plays the whole demo story (about 20 s on CI), longer than the default 20 s limit.
  }, 120_000);
});
