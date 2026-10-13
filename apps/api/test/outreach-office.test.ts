import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp({ features: ["work_orders", "estimates", "pumping"] });

// Only the disposable test namespace is populated. Cloned fictional rows test real SQL pagination and aggregates.
async function copies(table: string, original: string, count: number, overrides: object = {}) {
  await sql`insert into ${sql.table(table)} select (jsonb_populate_record(null::${sql.ref(table)}, to_jsonb(t) || ${JSON.stringify(overrides)}::jsonb || jsonb_build_object('id', gen_random_uuid(), 'number', 2000 + n, 'public_token', gen_random_uuid()::text))).* from ${sql.table(table)} t cross join generate_series(1, ${count}) n where t.id = ${original}::uuid`.execute(ctx.db);
}

describe("office recovery and full-dataset correctness", () => {
  it("rolls customer/contact back after a later site write failure and makes concurrent retries one operation", async () => {
    const t = await createTenant(ctx, "Atomic customer fixture");
    const creationId = crypto.randomUUID();
    const body = { creationId, customer: { displayName: "Fictional Casey" }, contact: { name: "Fictional Casey", email: "casey@example.test", type: "primary" }, site: { addressLine1: "5 Test Lane", city: "Austin", permitIntervalMonths: 3 } };
    // Missing source note is checked after customer and contact inserts, inside the transaction.
    const failed = await t.api.post("/customers/create-with-site", body);
    expect(failed.statusCode, failed.body).toBe(422);
    expect(await ctx.db.selectFrom("customers").select("id").where("id", "=", creationId).execute()).toEqual([]);
    expect(await ctx.db.selectFrom("contacts").select("id").where("customerId", "=", creationId).execute()).toEqual([]);
    const valid = { ...body, site: { ...body.site, permitIntervalNote: "Fictional test permit" } };
    const repeated = await Promise.all([t.api.post("/customers/create-with-site", valid), t.api.post("/customers/create-with-site", valid)]);
    for (const r of repeated) expect(r.statusCode, r.body).toBe(201);
    expect(repeated.map((r) => r.json().id)).toEqual([creationId, creationId]);
    expect(await ctx.db.selectFrom("contacts").select("id").where("customerId", "=", creationId).execute()).toHaveLength(1);
    expect(await ctx.db.selectFrom("sites").select("id").where("customerId", "=", creationId).execute()).toHaveLength(1);
    expect((await t.api.post("/customers/create-with-site", { ...valid, contact: { ...valid.contact, email: "changed@example.test" } })).statusCode).toBe(422);
    const outsider = await createTenant(ctx, "Other fictional tenant");
    expect((await outsider.api.get(`/customers/${creationId}/overview`)).statusCode).toBe(404);
    const tech = await createUser(ctx.db, t.org.id, "technician");
    expect((await client(ctx.app, await login(ctx.app, tech.email)).post("/customers/create-with-site", { ...valid, creationId: crypto.randomUUID() })).statusCode).toBe(403);
  });

  it("paginates 502 invoices and uses the full customer ledger independently of the visible rows", async () => {
    const t = await createTenant(ctx, "Large ledger fixture");
    const draft = (await t.api.post("/invoices", { customerId: t.customer.id, siteId: t.site.id, lines: [{ description: "Fictional service", quantity: 1, unitPriceCents: 2000 }] })).json();
    expect((await t.api.post(`/invoices/${draft.id}/issue`, { send: false })).statusCode).toBe(200);
    await copies("invoices", draft.id, 501);
    const page = (await t.api.get(`/invoices?view=all&customerId=${t.customer.id}&limit=50`)).json();
    expect(page.items).toHaveLength(50);
    expect(page.total).toBe(502);
    expect(page.owedCents).toBe(502 * 2000);
    const last = (await t.api.get(`/invoices?view=all&customerId=${t.customer.id}&limit=50&offset=500`)).json();
    expect(last.items).toHaveLength(2);
    expect(last.owedCents).toBe(page.owedCents);
    expect(last.items.every((i: { id: string }) => !page.items.some((j: { id: string }) => j.id === i.id))).toBe(true);
    const other = await createTenant(ctx, "Other ledger fixture");
    expect((await other.api.get(`/invoices?view=all&customerId=${t.customer.id}`)).json()).toMatchObject({ items: [], total: 0, owedCents: 0 });
  });

  it("keeps older unpaid portal invoices first, aggregates the full ledger and pages all customer requests beyond their caps", async () => {
    const t = await createTenant(ctx, "Fictional portal paging fixture");
    const draft = (await t.api.post("/invoices", { customerId: t.customer.id, siteId: t.site.id, lines: [{ description: "Older fictional balance", quantity: 1, unitPriceCents: 2000 }] })).json();
    const currentTime = ctx.now;
    ctx.now = new Date("2025-01-01T18:00:00Z");
    try { expect((await t.api.post(`/invoices/${draft.id}/issue`, { send: false })).statusCode).toBe(200); }
    finally { ctx.now = currentTime; }
    await copies("invoices", draft.id, 251, { issued_on: "2026-03-01", due_on: "2026-03-15", paid_cents: 2000, payment_status: "paid" });
    const link = (await t.api.post(`/customers/${t.customer.id}/portal-link`, { send: false })).json();
    const path = new URL(link.url).pathname;
    const request = await client(ctx.app).post(`${path}/service-requests`, { siteId: t.site.id, kind: "alarm", description: "Fictional alarm review" });
    expect(request.statusCode, request.body).toBe(201);
    await copies("service_requests", request.json().id, 250);
    const first = (await client(ctx.app).get(path)).json();
    expect(first).toMatchObject({ invoiceTotal: 252, amountDueCents: 2000, serviceRequestTotal: 251 });
    expect(first.invoices).toHaveLength(50);
    expect(first.invoices[0]).toMatchObject({ issuedOn: "2025-01-01", amountDueCents: 2000 });
    const last = (await client(ctx.app).get(`${path}?invoiceOffset=250&requestOffset=250`)).json();
    expect(last.invoices).toHaveLength(2); expect(last.amountDueCents).toBe(2000);
    expect(last.sites[0].serviceRequests).toHaveLength(1);
    expect(last.invoices.every((i: { number: string }) => !first.invoices.some((j: { number: string }) => j.number === i.number))).toBe(true);
    const officeFirst = (await t.api.get(`/service-requests?customerId=${t.customer.id}&limit=50`)).json();
    const officeLast = (await t.api.get(`/service-requests?customerId=${t.customer.id}&limit=50&offset=250`)).json();
    expect(officeFirst.total).toBe(251); expect(officeFirst.items).toHaveLength(50); expect(officeLast.items).toHaveLength(1);
    const other = await createTenant(ctx, "Other fictional portal fixture");
    expect((await other.api.get(`/service-requests?customerId=${t.customer.id}&limit=50&offset=250`)).json()).toEqual({ items: [], total: 0 });
    const otherLink = (await other.api.post(`/customers/${other.customer.id}/portal-link`, { send: false })).json();
    expect((await client(ctx.app).get(new URL(otherLink.url).pathname)).json()).toMatchObject({ amountDueCents: 0, invoiceTotal: 0, serviceRequestTotal: 0 });
    expect((await client(ctx.app).get(`${path}?invoiceOffset=-1`)).statusCode).toBe(400);
    // More outstanding rows than one page must not shrink the account balance.
    await sql`insert into invoices select (jsonb_populate_record(null::invoices, to_jsonb(i) || jsonb_build_object('id', gen_random_uuid(), 'number', 9000 + n, 'public_token', gen_random_uuid()::text))).* from invoices i cross join generate_series(1,51) n where i.id=${draft.id}::uuid`.execute(ctx.db);
    const enlarged = (await client(ctx.app).get(path)).json();
    expect(enlarged.amountDueCents).toBe(52 * 2000); expect(enlarged.invoiceTotal).toBe(303);
    expect(enlarged.invoices).toHaveLength(50); expect(enlarged.invoices.every((i: { amountDueCents: number }) => i.amountDueCents === 2000)).toBe(true);
    expect((await client(ctx.app).get(`${path}?invoiceOffset=300`)).json()).toMatchObject({ amountDueCents: 52 * 2000, invoiceTotal: 303 });
    await t.api.post(`/customers/${t.customer.id}/portal-links/revoke`, {});
    expect((await client(ctx.app).get(`${path}?invoiceOffset=250`)).statusCode).toBe(410);
  });

  it("counts overdue visits beyond 500, pages the last row and finds a target beyond the default horizon", async () => {
    const t = await createTenant(ctx, "Large due fixture");
    const plan = (await t.api.post("/plans", { name: "Fictional annual", termMonths: 12, visitsPerTerm: 3, priceCents: 20000 })).json();
    const contract = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2025-01-01" })).json();
    const first = contract.obligations[0].id;
    await sql`insert into service_obligations select (jsonb_populate_record(null::service_obligations, to_jsonb(o) || jsonb_build_object('id', gen_random_uuid(), 'sequence', 1000 + n))).* from service_obligations o cross join generate_series(1, 501) n where o.id = ${first}::uuid`.execute(ctx.db);
    const due = (await t.api.get("/obligations/due?limit=50&overdueOnly=true")).json();
    expect(due.items).toHaveLength(50);
    expect(due.total).toBe(504);
    expect(due.overdueTotal).toBe(504);
    expect((await t.api.get("/obligations/due?upcomingOnly=true")).json().total).toBe(0);
    const last = (await t.api.get("/obligations/due?limit=50&offset=500&overdueOnly=true")).json();
    expect(last.items).toHaveLength(4);
    const target = last.items[0].id;
    await ctx.db.updateTable("serviceObligations").set({ dueOn: "2030-01-01" }).where("id", "=", target).execute();
    const focused = (await t.api.get(`/obligations/due?obligationId=${target}`)).json();
    expect(focused.items.map((i: { id: string }) => i.id)).toEqual([target]);
    expect(focused.overdueTotal).toBe(0);
    const other = await createTenant(ctx, "Other due fixture");
    expect((await other.api.get(`/obligations/due?obligationId=${target}`)).json().items).toEqual([]);
  });

  it("pages work and estimates beyond their former 200-row UI slice, with tenant filtering intact", async () => {
    const t = await createTenant(ctx, "Large work fixture");
    const types = (await t.api.get("/work-types")).json().items;
    const work = (await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: types[0].id, title: "Fictional pump-out" })).json();
    await copies("work_orders", work.id, 201);
    const estimate = (await t.api.post("/estimates", { siteId: t.site.id, title: "Fictional repair", lines: [{ description: "Labor", quantity: 1, unitPriceCents: 1500 }] })).json();
    await copies("estimates", estimate.id, 201);
    for (const path of ["work-orders", "estimates"]) {
      const page = (await t.api.get(`/${path}?limit=50&siteId=${t.site.id}`)).json();
      const last = (await t.api.get(`/${path}?limit=50&offset=200&siteId=${t.site.id}`)).json();
      expect(page.items).toHaveLength(50); expect(page.total).toBe(202); expect(last.items).toHaveLength(2);
      expect(last.items.every((i: { id: string }) => !page.items.some((j: { id: string }) => j.id === i.id))).toBe(true);
    }
    const other = await createTenant(ctx, "Other work fixture");
    expect((await other.api.get(`/work-orders?siteId=${t.site.id}`)).json().total).toBe(0);
    expect((await other.api.get(`/estimates?siteId=${t.site.id}`)).json().total).toBe(0);
  });

  it("pages site history beyond 200 and keeps latest context independent of displayed history", async () => {
    const t = await createTenant(ctx, "Large history fixture");
    await ctx.db.insertInto("complianceEvents").values(Array.from({ length: 201 }, (_, i) => ({ organizationId: t.org.id, siteId: t.site.id, eventType: "test_record", summary: `Fictional event ${i}`, occurredAt: ctx.now }))).execute();
    const page = (await t.api.get(`/sites/${t.site.id}/compliance-events?limit=50`)).json();
    const last = (await t.api.get(`/sites/${t.site.id}/compliance-events?limit=50&offset=200`)).json();
    expect(page.total).toBe(201); expect(page.items).toHaveLength(50); expect(last.items).toHaveLength(1);
    expect((await t.api.get(`/sites/${t.site.id}/overview`)).json()).toMatchObject({ contract: null, obligation: null, visit: null, report: null, issues: [] });
    const other = await createTenant(ctx, "Other history fixture");
    expect((await other.api.get(`/sites/${t.site.id}/overview`)).statusCode).toBe(404);
  });
  it("pages renewed/lost history beyond 500 without filtering a capped slice", async () => {
    const t = await createTenant(ctx, "Large renewal fixture");
    const plan = (await t.api.post("/plans", { name: "Fictional annual", termMonths: 12, visitsPerTerm: 3, priceCents: 20000 })).json();
    const contract = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2025-03-15" })).json();
    const r = await t.api.post(`/contracts/${contract.id}/renewal`, { send: false });
    expect(r.statusCode, r.body).toBe(201);
    await copies("renewals", r.json().id, 501, { status: "expired" });
    const page = (await t.api.get("/renewals?statuses=expired&limit=50")).json();
    const last = (await t.api.get("/renewals?statuses=expired&limit=50&offset=500")).json();
    expect(page.total).toBe(501); expect(page.counts.expired).toBe(501); expect(page.items).toHaveLength(50); expect(last.items).toHaveLength(1);
    expect((await t.api.get("/renewals?statuses=upcoming&limit=50")).json().total).toBe(1);
  });

  it("pages 501 filings and counts risk from the full dataset while labeling the inbox sample", async () => {
    const t = await createTenant(ctx, "Large filing fixture");
    const plan = (await t.api.post("/plans", { name: "Fictional annual", termMonths: 12, visitsPerTerm: 3, priceCents: 20000 })).json();
    const contract = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2025-01-01" })).json();
    const cloned = await sql<{ id: string }>`insert into contracts select (jsonb_populate_record(null::contracts, to_jsonb(c) || jsonb_build_object('id', gen_random_uuid(), 'status', 'cancelled', 'cancelled_at', ${ctx.now.toISOString()}::timestamptz, 'cancel_reason', 'Fictional capacity fixture'))).* from contracts c cross join generate_series(1, 501) n where c.id = ${contract.id}::uuid returning id`.execute(ctx.db);
    await sql`insert into filings (organization_id, kind, inspection_id, contract_id, site_id, template_id, status, state_machine_version, review_reason) select organization_id, 'contract', null, id, site_id, null, 'needs_review', 1, 'Fictional capacity fixture: review required' from contracts where id = any(${cloned.rows.map((r) => r.id)}::uuid[])`.execute(ctx.db);
    const page = (await t.api.get("/filings?view=attention&limit=50")).json();
    const last = (await t.api.get("/filings?view=attention&limit=50&offset=500")).json();
    expect(page.total).toBe(501); expect(page.items).toHaveLength(50); expect(last.items).toHaveLength(1);
    const inbox = (await t.api.get("/inbox")).json();
    expect(inbox.counts.filingsAtRisk).toBe(501);
    expect(inbox.limited).toBe(true);
    const other = await createTenant(ctx, "Other filing fixture");
    expect((await other.api.get("/filings?view=all")).json().total).toBe(0);
  });

});
