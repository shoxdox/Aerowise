import type { Feature } from "@aerowise/domain";
import { canonicalJson, sha256Hex } from "@aerowise/renewals";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { client, createTenant, createUser, login, setupTestApp } from "./helpers.ts";

// SW-8: versioned plans with their own terms, options and coverage, frozen per contract,
// and coverage reserved, used and given back on work orders (service workflows plan §4.2,
// §4.3). The pinned clock is 2026-03-01.

const ON: Feature[] = ["work_orders", "service_items", "plan_builder"];
const ctx = setupTestApp({ features: ON });

type Tenant = Awaited<ReturnType<typeof createTenant>>;
type Api = Tenant["api"];

/** The same database through an app with the plan builder off. */
const appWithout = () => buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store, loginRateLimit: 1000, features: new Set<Feature>(["work_orders", "service_items"]) });

const workType = async (api: Api, key: string) => ((await api.get("/work-types")).json().items as { id: string; key: string }[]).find((t) => t.key === key)!.id;

const TERMS = "1. Gold service. The provider services the system as listed above and covers the repairs this plan lists. (Fictional test terms.)";

const GOLD = {
  termsText: TERMS,
  options: [
    { optionKey: "filter", name: "Effluent filter cleaning", priceCents: 2500, required: true, default: true },
    { optionKey: "alarm", name: "Alarm battery", priceCents: 4000 },
  ],
  coverage: [
    { ruleKey: "repairs", label: "Repairs", match: { category: "repair" }, effect: "included", limit: { count: 1, per: "term" } },
    { ruleKey: "pumping", label: "Pumping", match: { category: "pumping" }, effect: "percent_off", percentOff: 20 },
  ],
};

/** A "Gold" plan whose current version has terms, options and coverage. */
async function goldPlan(api: Api, coverage: object[] = GOLD.coverage) {
  const plan = (await api.post("/plans", { name: "Gold", termMonths: 12, visitsPerTerm: 2, priceCents: 40000 })).json();
  const res = await api.post(`/plans/${plan.id}/versions`, { ...GOLD, coverage });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; currentVersionId: string; version: number };
}

async function goldContract(t: Tenant, coverage?: object[]) {
  const plan = await goldPlan(t.api, coverage);
  const res = await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2026-01-01" });
  expect(res.statusCode, res.body).toBe(201);
  return { plan, contract: res.json() };
}

/** A repair work order requested on 2026-03-01 with an hour of labor and 1,000 gallons pumped from the catalog. */
async function repairOrder(t: Tenant, opts: { workType?: "repair" | "service_call" } = {}) {
  const labor = (await t.api.post("/service-items", { name: `Labor ${Math.random()}`, unit: "hour", unitPriceCents: 9500, category: "repair" })).json();
  const pump = (await t.api.post("/service-items", { name: `Pumping ${Math.random()}`, unit: "gallon", unitPriceCents: 35, category: "pumping" })).json();
  const res = await t.api.post("/work-orders", {
    siteId: t.site.id,
    workTypeId: await workType(t.api, opts.workType ?? "repair"),
    requestedOn: "2026-03-01",
    lines: [
      { description: "Labor", quantity: 1, unitPriceCents: 9500, serviceItemId: labor.id },
      { description: "Pumping", quantity: 1000, unitPriceCents: 35, serviceItemId: pump.id },
    ],
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}

const uses = (workOrderId: string) => ctx.db.selectFrom("coverageUses").select(["state", "invoiceId", "reason"]).where("workOrderId", "=", workOrderId).orderBy("createdAt").execute();

describe("plan versions", () => {
  it("starts every plan at version 1, keeps the builder's content through later term changes, and ignores switching it off", async () => {
    const t = await createTenant(ctx, "Org A");
    const created = (await t.api.post("/plans", { name: "Gold", termMonths: 12, visitsPerTerm: 2, priceCents: 40000 })).json();
    expect(created.version).toBe(1);
    const v2 = (await t.api.post(`/plans/${created.id}/versions`, GOLD)).json();
    expect(v2).toMatchObject({ version: 2, preview: { termsSource: "plan", terms: TERMS } });
    expect(v2.preview.coverage.map((c: { summary: string }) => c.summary)).toEqual(["Repairs: Repair work, no charge, up to 1 work order per term", "Pumping: Pumping work, 20% off"]);

    const v3 = (await t.api.patch(`/plans/${created.id}`, { priceCents: 42000 })).json();
    expect(v3.version).toBe(3);
    expect((await t.api.patch(`/plans/${created.id}`, { active: false })).json().version).toBe(3);

    const detail = (await t.api.get(`/plans/${created.id}`)).json();
    expect(detail.versions.map((v: { version: number; priceCents: number }) => [v.version, v.priceCents])).toEqual([
      [3, 42000],
      [2, 40000],
      [1, 40000],
    ]);
    // The price change kept the builder's terms, options and coverage.
    expect(detail.versions[0]).toMatchObject({ termsText: TERMS, options: GOLD.options.map((o) => expect.objectContaining({ optionKey: o.optionKey })), coverage: [expect.objectContaining({ ruleKey: "repairs" }), expect.objectContaining({ ruleKey: "pumping" })] });
    expect(detail.versions[2]).toMatchObject({ termsText: null, options: [], coverage: [] });
  });

  it("never changes a version or a contract's frozen rules, and versions plans written by older code", async () => {
    const t = await createTenant(ctx, "Org A");
    const { plan, contract } = await goldContract(t);
    await expect(sql`update plan_versions set price_cents = 1 where id = ${plan.currentVersionId}`.execute(ctx.db)).rejects.toThrow(/cannot be changed/);
    await expect(sql`delete from plan_versions where id = ${plan.currentVersionId}`.execute(ctx.db)).rejects.toThrow(/cannot be changed/);
    await expect(sql`update contract_coverage_rules set limit_count = 9 where contract_id = ${contract.id}`.execute(ctx.db)).rejects.toThrow(/frozen/);
    await expect(sql`delete from contract_coverage_rules where contract_id = ${contract.id}`.execute(ctx.db)).rejects.toThrow(/frozen/);

    // A plan inserted the way a release before versions did still gets its version 1.
    const old = await sql<{ id: string; currentVersionId: string }>`
      insert into plans (organization_id, name, term_months, visits_per_term, price_cents) values (${t.org.id}, 'Old writer', 12, 3, 30000)
      returning id, current_version_id`.execute(ctx.db);
    const v = await ctx.db.selectFrom("planVersions").selectAll().where("id", "=", old.rows[0]!.currentVersionId).executeTakeFirstOrThrow();
    expect(v).toMatchObject({ planId: old.rows[0]!.id, version: 1, priceCents: 30000, termsText: null, options: [], coverage: [] });
    expect(v.serviceCycles).toEqual([{ cycleKey: "aerobic", serviceType: "aerobic_inspection", schedule: { kind: "visits_per_term", visitsPerTerm: 3 } }]);
    // A contract may name a version only of its own plan.
    await expect(sql`update contracts set plan_version_id = ${old.rows[0]!.currentVersionId} where id = ${contract.id}`.execute(ctx.db)).rejects.toThrow(/foreign key/);
  });

  it("needs the plan builder, the owner or office, valid rules and the company's own catalog", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const plan = (await a.api.post("/plans", { name: "Gold", termMonths: 12, visitsPerTerm: 2, priceCents: 40000 })).json();
    const off = client(await appWithout(), a.cookie);
    const refused = await off.post(`/plans/${plan.id}/versions`, GOLD);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("feature_off");

    const twice = await a.api.post(`/plans/${plan.id}/versions`, { ...GOLD, coverage: [GOLD.coverage[0], GOLD.coverage[0]] });
    expect(twice.statusCode).toBe(400);
    expect((await a.api.post(`/plans/${plan.id}/versions`, { ...GOLD, coverage: [{ ...GOLD.coverage[1], percentOff: null }] })).statusCode).toBe(400);
    expect((await a.api.post(`/plans/${plan.id}/versions`, { ...GOLD, options: [{ optionKey: "x", name: "X", priceCents: 1, required: true, default: false }] })).statusCode).toBe(400);
    const theirItem = (await b.api.post("/service-items", { name: "Riser", unitPriceCents: 1000 })).json();
    const foreign = await a.api.post(`/plans/${plan.id}/versions`, { ...GOLD, coverage: [{ ruleKey: "riser", label: "Riser", match: { serviceItemId: theirItem.id }, effect: "included" }] });
    expect(foreign.statusCode).toBe(422);

    const tech = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, a.org.id, "technician")).email));
    expect((await tech.post(`/plans/${plan.id}/versions`, GOLD)).statusCode).toBe(403);
    expect((await b.api.post(`/plans/${plan.id}/versions`, GOLD)).statusCode).toBe(404);
    expect((await b.api.get(`/plans/${plan.id}`)).statusCode).toBe(404);
    expect((await a.api.get(`/plans/${plan.id}`)).json().version).toBe(1);
  });
});

describe("contracts on a plan version", () => {
  it("freezes the version's coverage on the contract; a later version changes nothing for it", async () => {
    const t = await createTenant(ctx, "Org A");
    const { plan, contract } = await goldContract(t);
    expect(contract.planVersion).toEqual({ id: plan.currentVersionId, version: 2 });
    expect(contract.coverage).toEqual([
      expect.objectContaining({ ruleKey: "repairs", limit: 1, used: 0, summary: "Repairs: Repair work, no charge, up to 1 work order per term" }),
      expect.objectContaining({ ruleKey: "pumping", limit: null, used: 0 }),
    ]);
    const row = await ctx.db.selectFrom("contracts").select(["planVersionId", "agreementSnapshot"]).where("id", "=", contract.id).executeTakeFirstOrThrow();
    expect(row.agreementSnapshot).toMatchObject({ signed: false, plan: { version: 2, termsSource: "plan" }, terms: TERMS });

    // The plan now excludes repairs; the contract keeps what it was made with.
    expect((await t.api.post(`/plans/${plan.id}/versions`, { ...GOLD, coverage: [{ ruleKey: "repairs", label: "Repairs", match: { category: "repair" }, effect: "excluded" }] })).statusCode).toBe(201);
    const after = (await t.api.get(`/contracts/${contract.id}`)).json();
    expect(after.coverage.map((c: { ruleKey: string }) => c.ruleKey)).toEqual(["repairs", "pumping"]);
    const wo = await repairOrder(t);
    const applied = (await t.api.post(`/work-orders/${wo.id}/coverage/apply`, {})).json();
    expect(applied.rules.filter((r: { use: unknown }) => r.use).map((r: { ruleKey: string }) => r.ruleKey)).toEqual(["repairs", "pumping"]);
  });

  it("with the plan builder off, makes contracts and renewal agreements exactly as before", async () => {
    const t = await createTenant(ctx, "Org A");
    const plan = await goldPlan(t.api);
    const off = client(await appWithout(), t.cookie);
    const contract = (await off.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2025-04-01" })).json();
    expect(contract).toMatchObject({ planVersion: { id: plan.currentVersionId, version: 2 }, coverage: [] });
    expect((await ctx.db.selectFrom("contracts").select("agreementSnapshot").where("id", "=", contract.id).executeTakeFirstOrThrow()).agreementSnapshot).toBeNull();

    await t.api.post(`/customers/${t.customer.id}/contacts`, { name: "Billing", email: "billing@a.test", type: "billing" });
    const r = (await off.post(`/contracts/${contract.id}/renewal`, {})).json();
    const token = (r.link as string).split("/renew/")[1]!;
    const anon = client(await appWithout());
    const view = (await anon.get(`/renew/${token}`)).json();
    expect(view).toMatchObject({ options: [], selectedOptionKeys: [], coverage: [] });
    expect(view.agreementText).not.toBe(TERMS);
    expect((await anon.post(`/renew/${token}/sign`, { version: 1, contact: { email: "pat@example.test" }, signerName: "Pat Homeowner", signature: { kind: "typed" }, agree: true, optionKeys: ["alarm"] })).statusCode).toBe(422);
    expect((await anon.post(`/renew/${token}/sign`, { version: 1, contact: { email: "pat@example.test" }, signerName: "Pat Homeowner", signature: { kind: "typed" }, agree: true })).statusCode).toBe(200);
    const doc = await ctx.db.selectFrom("signedDocuments").select(["content"]).where("renewalId", "=", r.id).executeTakeFirstOrThrow();
    const content = doc.content as Record<string, unknown>;
    // The same fields an agreement has always had, and the organization's terms.
    expect(Object.keys(content).sort()).toEqual(["addons", "charges", "customer", "format", "offerVersion", "previousTerm", "provider", "serviceAddress", "term", "terms", "title"]);
    expect(content.terms).not.toBe(TERMS);
    const activated = await off.post(`/renewals/${r.id}/activate`, {});
    expect(activated.statusCode, activated.body).toBe(200);
    const next = (await t.api.get(`/contracts/${activated.json().newContractId}`)).json();
    expect(next).toMatchObject({ planVersion: { version: 2 }, coverage: [] });
  });
});

describe("renewals on a plan version", () => {
  it("offers the version's terms, options and coverage; the signed agreement and the next contract carry them", async () => {
    const t = await createTenant(ctx, "Org A");
    await t.api.post(`/customers/${t.customer.id}/contacts`, { name: "Billing", email: "billing@a.test", type: "billing" });
    const plan = await goldPlan(t.api);
    const contract = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2025-04-01" })).json();
    const r = (await t.api.post(`/contracts/${contract.id}/renewal`, {})).json();
    expect(r.planVersion).toEqual({ id: plan.currentVersionId, version: 2 });
    const token = (r.link as string).split("/renew/")[1]!;
    const anon = client(ctx.app);
    const view = (await anon.get(`/renew/${token}`)).json();
    expect(view).toMatchObject({ agreementText: TERMS, selectedOptionKeys: ["filter"], coverage: ["Repairs: Repair work, no charge, up to 1 work order per term", "Pumping: Pumping work, 20% off"] });
    expect(view.options.map((o: { optionKey: string }) => o.optionKey)).toEqual(["filter", "alarm"]);

    const sign = (extra: object) => anon.post(`/renew/${token}/sign`, { version: 1, contact: { email: "pat@example.test" }, signerName: "Pat Homeowner", signature: { kind: "typed" }, agree: true, ...extra });
    expect((await sign({ optionKeys: ["gold-plated"] })).statusCode).toBe(422);
    // The required option comes whether or not it is sent.
    const signed = await sign({ optionKeys: ["alarm"] });
    expect(signed.statusCode, signed.body).toBe(200);
    const detail = (await t.api.get(`/renewals/${r.id}`)).json();
    expect(detail.selectedOptions.map((o: { optionKey: string }) => o.optionKey)).toEqual(["filter", "alarm"]);
    const doc = await ctx.db.selectFrom("signedDocuments").select(["content", "contentSha256"]).where("renewalId", "=", r.id).executeTakeFirstOrThrow();
    const content = doc.content as { terms: string; plan: object; options: { optionKey: string }[]; coverage: { ruleKey: string }[]; charges: { lines: { description: string; amountCents: number }[] } };
    expect(content.terms).toBe(TERMS);
    expect(content.plan).toEqual({ versionId: plan.currentVersionId, version: 2, termsSource: "plan" });
    expect(content.options.map((o) => o.optionKey)).toEqual(["filter", "alarm"]);
    expect(content.coverage.map((c) => c.ruleKey)).toEqual(["repairs", "pumping"]);
    expect(content.charges.lines.slice(1)).toEqual([
      { description: "Effluent filter cleaning", amountCents: 2500, taxable: false },
      { description: "Alarm battery", amountCents: 4000, taxable: false },
    ]);
    expect(doc.contentSha256).toBe(sha256Hex(canonicalJson(content)));
    const invoiceLines = await ctx.db.selectFrom("invoiceLines").select(["description", "amountCents"]).where("invoiceId", "=", detail.invoice.id).orderBy("position").execute();
    expect(invoiceLines.map((l) => l.amountCents)).toEqual([40000, 2500, 4000]);

    // A later version does not change what was signed: the next contract takes version 2's coverage.
    expect((await t.api.post(`/plans/${plan.id}/versions`, { ...GOLD, coverage: [] })).statusCode).toBe(201);
    const activated = (await t.api.post(`/renewals/${r.id}/activate`, {})).json();
    const next = (await t.api.get(`/contracts/${activated.newContractId}`)).json();
    expect(next).toMatchObject({ planVersion: { version: 2 }, startOn: "2026-04-01" });
    expect(next.coverage.map((c: { ruleKey: string }) => c.ruleKey)).toEqual(["repairs", "pumping"]);
  });
});

describe("coverage on work orders", () => {
  it("applies, prices, bills and gives back coverage", async () => {
    const t = await createTenant(ctx, "Org A");
    const { contract } = await goldContract(t);
    const wo = await repairOrder(t);
    const before = (await t.api.get(`/work-orders/${wo.id}/coverage`)).json();
    expect(before).toMatchObject({ contract: { id: contract.id, planName: "Gold", planVersion: 2 }, notice: null, canApply: true });
    expect(before.rules.map((r: { ruleKey: string; matches: boolean; use: unknown }) => [r.ruleKey, r.matches, r.use])).toEqual([
      ["repairs", true, null],
      ["pumping", true, null],
    ]);

    const applied = (await t.api.post(`/work-orders/${wo.id}/coverage/apply`, {})).json();
    expect(applied.rules.map((r: { use: { state: string } }) => r.use.state)).toEqual(["reserved", "reserved"]);
    expect(applied.canApply).toBe(false);
    const snap = (await ctx.db.selectFrom("workOrders").select("coverageSnapshot").where("id", "=", wo.id).executeTakeFirstOrThrow()).coverageSnapshot;
    expect(snap).toMatchObject({ planName: "Gold", covered: true, rules: [{ ruleKey: "repairs", state: "reserved" }, { ruleKey: "pumping", state: "reserved" }] });
    // Applying again is a no-op.
    expect((await t.api.post(`/work-orders/${wo.id}/coverage/apply`, {})).statusCode).toBe(200);
    expect(await uses(wo.id)).toHaveLength(2);

    // The invoice prices each line under the first applied rule that fits it, and says so.
    const inv = (await t.api.post(`/work-orders/${wo.id}/invoice`, {})).json();
    const lines = (await t.api.get(`/invoices/${inv.invoiceId}`)).json().lines;
    expect(lines.map((l: { description: string; unitPriceCents: number; amountCents: number }) => [l.description, l.unitPriceCents, l.amountCents])).toEqual([
      ["Labor (Covered by Gold: Repairs)", 0, 0],
      ["Pumping (20% off with Gold: Pumping)", 28, 28000],
    ]);
    expect((await t.api.post(`/invoices/${inv.invoiceId}/issue`, { send: false })).statusCode).toBe(200);
    expect((await uses(wo.id)).map((u) => [u.state, u.invoiceId])).toEqual([
      ["consumed", inv.invoiceId],
      ["consumed", inv.invoiceId],
    ]);
    // Declining billed coverage needs the invoice voided first.
    expect((await t.api.post(`/work-orders/${wo.id}/coverage/decline`, { reason: "Changed our mind" })).statusCode).toBe(409);

    // Voiding while the work order is live reserves it again, for the replacement invoice.
    expect((await t.api.post(`/invoices/${inv.invoiceId}/void`, { reason: "TEST wrong price" })).statusCode).toBe(200);
    expect((await uses(wo.id)).map((u) => [u.state, u.invoiceId])).toEqual([
      ["reserved", null],
      ["reserved", null],
    ]);
    expect((await t.api.get(`/contracts/${contract.id}`)).json().coverage.map((c: { used: number }) => c.used)).toEqual([1, 1]);

    // Declining gives the uses back, with the reason.
    const declined = (await t.api.post(`/work-orders/${wo.id}/coverage/decline`, { reason: "TEST customer caused the damage" })).json();
    expect(declined.rules.map((r: { use: { state: string; reason: string } }) => [r.use.state, r.use.reason])).toEqual([
      ["released", "TEST customer caused the damage"],
      ["released", "TEST customer caused the damage"],
    ]);
    expect((await t.api.get(`/contracts/${contract.id}`)).json().coverage.map((c: { used: number }) => c.used)).toEqual([0, 0]);
    expect((await ctx.db.selectFrom("workOrders").select("coverageSnapshot").where("id", "=", wo.id).executeTakeFirstOrThrow()).coverageSnapshot).toBeNull();
    // A replacement invoice made now is at full price.
    const full = (await t.api.post(`/work-orders/${wo.id}/invoice`, {})).json();
    expect((await t.api.get(`/invoices/${full.invoiceId}`)).json().lines.map((l: { amountCents: number }) => l.amountCents)).toEqual([9500, 35000]);
  });

  it("gives ten work orders reaching for the last use of a rule exactly one", async () => {
    const t = await createTenant(ctx, "Org A");
    const { contract } = await goldContract(t, [GOLD.coverage[0]!]);
    const orders = [];
    for (let i = 0; i < 10; i++) orders.push(await repairOrder(t));
    const results = await Promise.all(orders.map((wo) => t.api.post(`/work-orders/${wo.id}/coverage/apply`, {})));
    expect(results.map((r) => r.statusCode)).toEqual(Array(10).fill(200));
    const winners = results.filter((r) => r.json().rules[0].use?.state === "reserved");
    expect(winners).toHaveLength(1);
    const reserved = await ctx.db.selectFrom("coverageUses").select("workOrderId").where("state", "in", ["reserved", "consumed"]).execute();
    expect(reserved).toHaveLength(1);
    const loser = orders.find((o) => o.id !== reserved[0]!.workOrderId)!;
    const events = await ctx.db.selectFrom("workOrderEvents").select("summary").where("workOrderId", "=", loser.id).where("eventType", "=", "coverage_applied").execute();
    expect(events.map((e) => e.summary)).toEqual(["Limit reached, not covered: Repairs"]);

    // Cancelling the winner gives the use back, and another order can take it.
    expect((await t.api.post(`/work-orders/${reserved[0]!.workOrderId}/cancel`, { reason: "TEST customer cancelled" })).statusCode).toBe(200);
    expect((await t.api.get(`/contracts/${contract.id}`)).json().coverage[0].used).toBe(0);
    expect((await t.api.post(`/work-orders/${loser.id}/coverage/apply`, {})).json().rules[0].use.state).toBe("reserved");
  });

  it("uses coverage on a no-charge completion, restores a billed benefit with a reason, and releases it when the invoice is voided after cancelling", async () => {
    const t = await createTenant(ctx, "Org A");
    const { contract } = await goldContract(t);
    const tech = await createUser(ctx.db, t.org.id, "technician");

    const free = await repairOrder(t);
    await t.api.post(`/work-orders/${free.id}/coverage/apply`, {});
    expect((await t.api.patch(`/work-orders/${free.id}`, { billingStatus: "no_charge" })).statusCode).toBe(200);
    expect((await t.api.post(`/work-orders/${free.id}/schedule`, { technicianId: tech.id, scheduledDate: "2026-03-02" })).statusCode).toBe(201);
    expect((await t.api.post(`/work-orders/${free.id}/complete`, { reason: "TEST paper ticket" })).statusCode).toBe(200);
    expect((await uses(free.id)).map((u) => [u.state, u.invoiceId])).toEqual([
      ["consumed", null],
      ["consumed", null],
    ]);
    const restored = await t.api.post(`/work-orders/${free.id}/coverage/restore`, { reason: "TEST goodwill after a complaint" });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await uses(free.id)).map((u) => [u.state, u.reason])).toEqual([
      ["released", "Benefit restored: TEST goodwill after a complaint"],
      ["released", "Benefit restored: TEST goodwill after a complaint"],
    ]);
    expect((await t.api.post(`/work-orders/${free.id}/coverage/restore`, { reason: "again" })).statusCode).toBe(409);

    const billed = await repairOrder(t);
    await t.api.post(`/work-orders/${billed.id}/coverage/apply`, {});
    const inv = (await t.api.post(`/work-orders/${billed.id}/invoice`, {})).json();
    await t.api.post(`/invoices/${inv.invoiceId}/issue`, { send: false });
    // Cancelling keeps billed uses with their invoice; voiding it then releases them.
    expect((await t.api.post(`/work-orders/${billed.id}/cancel`, { reason: "TEST work not needed" })).statusCode).toBe(200);
    expect((await uses(billed.id)).map((u) => u.state)).toEqual(["consumed", "consumed"]);
    expect((await t.api.post(`/invoices/${inv.invoiceId}/void`, { reason: "TEST cancelled" })).statusCode).toBe(200);
    expect((await uses(billed.id)).map((u) => [u.state, u.reason])).toEqual([
      ["released", "Invoice voided after the work order was cancelled"],
      ["released", "Invoice voided after the work order was cancelled"],
    ]);
    expect((await t.api.get(`/contracts/${contract.id}`)).json().coverage.map((c: { used: number }) => c.used)).toEqual([0, 0]);
  });

  it("says when there is nothing to cover, and never covers excluded work", async () => {
    const t = await createTenant(ctx, "Org A");
    const none = await repairOrder(t);
    expect((await t.api.get(`/work-orders/${none.id}/coverage`)).json()).toMatchObject({ contract: null, canApply: false, notice: expect.stringContaining("No contract at this site covers 2026-03-01") });
    expect((await t.api.post(`/work-orders/${none.id}/coverage/apply`, {})).json().error).toBe("no_contract");

    const plain = (await t.api.post("/plans", { name: "Basic", termMonths: 12, visitsPerTerm: 2, priceCents: 30000 })).json();
    expect((await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plain.id, startOn: "2026-01-01" })).statusCode).toBe(201);
    expect((await t.api.get(`/work-orders/${none.id}/coverage`)).json()).toMatchObject({ rules: [], canApply: false, notice: "Its plan has no coverage rules, so it covers nothing." });

    const u = await createTenant(ctx, "Org U");
    await goldContract(u, [{ ruleKey: "other", label: "Odd jobs", match: { category: "other" }, effect: "excluded" }, GOLD.coverage[1]!]);
    // A service call (category "other") with a repair-category labor line and a pumping line.
    const odd = await repairOrder(u, { workType: "service_call" });
    const view = (await u.api.get(`/work-orders/${odd.id}/coverage`)).json();
    // The pumping line still matches its own rule; the exclusion is never reserved.
    expect(view.rules.map((r: { ruleKey: string; matches: boolean }) => [r.ruleKey, r.matches])).toEqual([
      ["other", false],
      ["pumping", true],
    ]);
    await u.api.post(`/work-orders/${odd.id}/coverage/apply`, {});
    const inv = (await u.api.post(`/work-orders/${odd.id}/invoice`, {})).json();
    expect((await u.api.get(`/invoices/${inv.invoiceId}`)).json().lines.map((l: { description: string; amountCents: number }) => [l.description, l.amountCents])).toEqual([
      ["Labor", 9500],
      ["Pumping (20% off with Gold: Pumping)", 28000],
    ]);
  });

  it("is the office's: other companies are not found, technicians are refused, and applying needs the plan builder", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    await goldContract(a);
    const wo = await repairOrder(a);
    expect((await b.api.get(`/work-orders/${wo.id}/coverage`)).statusCode).toBe(404);
    expect((await b.api.post(`/work-orders/${wo.id}/coverage/apply`, {})).statusCode).toBe(404);
    const tech = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, a.org.id, "technician")).email));
    expect((await tech.get(`/work-orders/${wo.id}/coverage`)).statusCode).toBe(403);

    const off = client(await appWithout(), a.cookie);
    expect((await off.get(`/work-orders/${wo.id}/coverage`)).json().canApply).toBe(false);
    expect((await off.post(`/work-orders/${wo.id}/coverage/apply`, {})).json().error).toBe("feature_off");
    // What was applied while it was on can still be finished with it off.
    await a.api.post(`/work-orders/${wo.id}/coverage/apply`, {});
    expect((await off.post(`/work-orders/${wo.id}/coverage/decline`, { reason: "TEST" })).statusCode).toBe(200);
  });
});
