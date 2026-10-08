import { TestCompanies, TestQuickBooksProvider, TokenCipher } from "@aerowise/quickbooks";
import { drainTasks } from "@aerowise/tasks";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";

// SW-3: the service item catalog, fractional quantities and invoicing a work order.

const ctx = setupTestApp({ features: ["work_orders", "service_items"] });

type Tenant = Awaited<ReturnType<typeof createTenant>>;
type Api = Tenant["api"];

const repairType = async (api: Api) => ((await api.get("/work-types")).json().items as { id: string; key: string }[]).find((t) => t.key === "repair")!.id;

async function catalog(api: Api) {
  const labor = (await api.post("/service-items", { name: "Labor", unit: "hour", unitPriceCents: 9500, category: "repair" })).json();
  const pumping = (await api.post("/service-items", { name: "Pumping", unit: "gallon", unitPriceCents: 35, category: "pumping" })).json();
  return { labor, pumping };
}

/** A completed work order with an hour and a half of labor and 1,000 gallons pumped. */
async function finishedWork(t: Tenant, opts: { complete?: boolean } = {}) {
  const items = await catalog(t.api);
  const tech = await createUser(ctx.db, t.org.id, "technician");
  const wo = (
    await t.api.post("/work-orders", {
      siteId: t.site.id,
      workTypeId: await repairType(t.api),
      lines: [
        { description: "Labor", quantity: 1.5, unitPriceCents: 9500, serviceItemId: items.labor.id },
        { description: "Pumping", quantity: 1000, unitPriceCents: 35, serviceItemId: items.pumping.id },
      ],
    })
  ).json();
  expect((await t.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: tech.id, scheduledDate: "2026-03-02" })).statusCode).toBe(201);
  if (opts.complete !== false) expect((await t.api.post(`/work-orders/${wo.id}/complete`, { reason: "TEST paper ticket" })).statusCode).toBe(200);
  return { wo: wo as { id: string }, items, tech };
}

const liveInvoices = async (workOrderId: string) =>
  ctx.db.selectFrom("invoices").select(["id", "status"]).where("workOrderId", "=", workOrderId).where("status", "<>", "void").execute();

describe("service items", () => {
  it("keeps a catalog per company, with active names unique and switched-off items kept", async () => {
    const t = await createTenant(ctx, "Org A");
    const { labor } = await catalog(t.api);
    expect(labor).toMatchObject({ name: "Labor", unit: "hour", unitPriceCents: 9500, taxable: false, category: "repair", active: true, description: null });
    const dup = await t.api.post("/service-items", { name: "labor", unitPriceCents: 1 });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("duplicate_name");

    expect((await t.api.patch(`/service-items/${labor.id}`, { active: false })).json().active).toBe(false);
    // The name is free again once the old item is switched off.
    expect((await t.api.post("/service-items", { name: "Labor", unit: "hour", unitPriceCents: 10500 })).statusCode).toBe(201);
    expect((await t.api.get("/service-items")).json().items.map((i: { unitPriceCents: number }) => i.unitPriceCents)).toEqual([10500, 35]);
    expect((await t.api.get("/service-items?active=all")).json().items).toHaveLength(3);
    expect((await t.api.get("/service-items?active=false")).json().items).toEqual([expect.objectContaining({ id: labor.id })]);
  });

  it("lets the office manage it and technicians read it; other companies' items are not found", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const { labor } = await catalog(a.api);
    const office = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, a.org.id, "office")).email));
    const tech = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, a.org.id, "technician")).email));
    expect((await office.post("/service-items", { name: "Riser", unitPriceCents: 12000 })).statusCode).toBe(201);
    expect((await tech.get("/service-items")).json().items).toHaveLength(3);
    expect((await tech.post("/service-items", { name: "Free", unitPriceCents: 0 })).statusCode).toBe(403);
    expect((await tech.patch(`/service-items/${labor.id}`, { unitPriceCents: 0 })).statusCode).toBe(403);

    expect((await b.api.get("/service-items")).json().items).toEqual([]);
    expect((await b.api.patch(`/service-items/${labor.id}`, { unitPriceCents: 1 })).statusCode).toBe(404);
    // Nor can another company's item be put on a line.
    expect((await b.api.post("/invoices", { customerId: b.customer.id, lines: [{ description: "Labor", unitPriceCents: 9500, serviceItemId: labor.id }] })).statusCode).toBe(404);
    const wo = await b.api.post("/work-orders", { siteId: b.site.id, workTypeId: await repairType(b.api), lines: [{ description: "Labor", quantity: 1, unitPriceCents: 9500, serviceItemId: labor.id }] });
    expect(wo.statusCode).toBe(404);
  });
});

describe("fractional quantities", () => {
  it("prices a fraction in thousandths, rounding half a cent up as the database does", async () => {
    const t = await createTenant(ctx, "Org A");
    const { labor } = await catalog(t.api);
    const res = await t.api.post("/invoices", {
      customerId: t.customer.id,
      lines: [
        { description: "Labor", quantity: 2.333, unitPriceCents: 9500, serviceItemId: labor.id },
        { description: "Filter", quantity: 2, unitPriceCents: 1250 },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const inv = res.json();
    // 2.333 × $95.00 = $221.635, which rounds to $221.64.
    expect(inv.lines).toMatchObject([
      { quantity: 2.333, quantityMilli: 2333, unitPriceCents: 9500, amountCents: 22164, serviceItemId: labor.id },
      { quantity: 2, quantityMilli: null, unitPriceCents: 1250, amountCents: 2500, serviceItemId: null },
    ]);
    expect(inv.subtotalCents).toBe(24664);
    const half = await sql<{ n: string }>`select round(2333::numeric * 9500 / 1000) as n`.execute(ctx.db);
    expect(Number(half.rows[0]!.n)).toBe(22164);

    // Changing only the memo keeps the fractional line as it was.
    const memo = await t.api.patch(`/invoices/${inv.id}`, { memo: "Thanks" });
    expect(memo.json().lines[0]).toMatchObject({ quantity: 2.333, quantityMilli: 2333, amountCents: 22164 });
    const issued = (await t.api.post(`/invoices/${inv.id}/issue`, { send: false })).json();
    expect(issued.totalCents).toBe(24664);
    const snap = (await ctx.db.selectFrom("invoices").select("snapshot").where("id", "=", inv.id).executeTakeFirstOrThrow()).snapshot as { lines: { quantity: number; amountCents: number }[] };
    expect(snap.lines.map((l) => [l.quantity, l.amountCents])).toEqual([
      [2.333, 22164],
      [2, 2500],
    ]);
    await drainTasks({ db: ctx.db, store: ctx.store, now: () => ctx.now });
    expect((await t.api.get(`/invoices/${inv.id}/pdf`)).statusCode).toBe(200);
  });

  it("refuses more than three decimals, and stored amounts that disagree with the quantity", async () => {
    const t = await createTenant(ctx, "Org A");
    expect((await t.api.post("/invoices", { customerId: t.customer.id, lines: [{ description: "Labor", quantity: 1.2345, unitPriceCents: 9500 }] })).statusCode).toBe(400);
    const inv = (await t.api.post("/invoices", { customerId: t.customer.id, lines: [{ description: "Labor", quantity: 1.5, unitPriceCents: 9500 }] })).json();
    const line = { organization_id: t.org.id, invoice_id: inv.id, position: 2, description: "Forged", unit_price_cents: 9500, taxable: false };
    await expect(sql`insert into invoice_lines (organization_id, invoice_id, position, description, unit_price_cents, taxable, quantity, quantity_milli, amount_cents) values (${line.organization_id}, ${line.invoice_id}, 2, 'Forged', 9500, false, 2, 1500, 19000)`.execute(ctx.db)).rejects.toThrow(/invoice_lines_amount_check/);
    await expect(sql`insert into invoice_lines (organization_id, invoice_id, position, description, unit_price_cents, taxable, quantity, quantity_milli, amount_cents) values (${line.organization_id}, ${line.invoice_id}, 2, 'Forged', 9500, false, 2, null, 14250)`.execute(ctx.db)).rejects.toThrow(/invoice_lines_amount_check/);
    await sql`insert into invoice_lines (organization_id, invoice_id, position, description, unit_price_cents, taxable, quantity, quantity_milli, amount_cents) values (${line.organization_id}, ${line.invoice_id}, 2, 'Fine', 9500, false, 2, 1500, 14250)`.execute(ctx.db);
  });

  it("keeps whole numbers only, and the catalog closed, where service items are off", async () => {
    const t = await createTenant(ctx, "Org A");
    const off = await buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store, loginRateLimit: 1000, features: new Set(["work_orders"]) });
    try {
      const api = client(off, await login(off, t.owner.email));
      const frac = await api.post("/invoices", { customerId: t.customer.id, lines: [{ description: "Labor", quantity: 1.5, unitPriceCents: 9500 }] });
      expect(frac.statusCode).toBe(409);
      expect(frac.json().error).toBe("feature_off");
      const whole = await api.post("/invoices", { customerId: t.customer.id, lines: [{ description: "Labor", quantity: 2, unitPriceCents: 9500 }] });
      expect(whole.statusCode).toBe(201);
      expect(whole.json().lines[0]).toMatchObject({ quantity: 2, quantityMilli: null, amountCents: 19000 });
      expect((await api.patch(`/invoices/${whole.json().id}`, { lines: [{ description: "Labor", quantity: 0.5, unitPriceCents: 9500 }] })).statusCode).toBe(409);
      expect((await api.post("/service-items", { name: "Labor", unitPriceCents: 9500 })).json().error).toBe("feature_off");
      expect((await api.get("/service-items")).statusCode).toBe(200);
      // A fractional draft made while it was on can still be finished.
      const made = (await t.api.post("/invoices", { customerId: t.customer.id, lines: [{ description: "Labor", quantity: 1.5, unitPriceCents: 9500 }] })).json();
      expect((await api.patch(`/invoices/${made.id}`, { memo: "Finish it" })).json().lines[0].amountCents).toBe(14250);
      expect((await api.post(`/invoices/${made.id}/issue`, { send: false })).statusCode).toBe(200);
    } finally {
      await off.close();
    }
  });

  it("saves a fractional draft from the office editor after the flag is turned off, but takes no new fraction", async () => {
    const t = await createTenant(ctx, "Org A");
    const made = (
      await t.api.post("/invoices", {
        customerId: t.customer.id,
        lines: [
          { description: "Labor", quantity: 1.5, unitPriceCents: 9500 },
          { description: "Filter", quantity: 2, unitPriceCents: 1250 },
        ],
      })
    ).json();
    const off = await buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store, loginRateLimit: 1000, features: new Set(["work_orders"]) });
    try {
      const api = client(off, await login(off, t.owner.email));
      // Every line, as the office editor sends them on Save draft (InvoiceEditor), with a changed price.
      const editorLines = (draft: { lines: { id: string; description: string; quantity: number; unitPriceCents: number; taxable: boolean; serviceItemId: string | null }[] }) =>
        draft.lines.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, taxable: l.taxable, serviceItemId: l.serviceItemId }));
      const lines = editorLines((await api.get(`/invoices/${made.id}`)).json());
      lines[0]!.unitPriceCents = 10000;
      const saved = await api.patch(`/invoices/${made.id}`, { taxRateBps: 0, discountCents: 0, termsDays: 30, memo: "Edited after the flag went off", lines });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().lines).toMatchObject([
        { quantity: 1.5, quantityMilli: 1500, amountCents: 15000 },
        { quantity: 2, quantityMilli: null, amountCents: 2500 },
      ]);

      // A different fraction, or a fraction on a new or whole-number line, is new and refused.
      const again = editorLines(saved.json());
      for (const bad of [
        again.map((l, i) => (i === 0 ? { ...l, quantity: 1.75 } : l)),
        again.map((l, i) => (i === 1 ? { ...l, quantity: 2.5 } : l)),
        [...again, { description: "More labor", quantity: 0.5, unitPriceCents: 9500, taxable: false, serviceItemId: null }],
        again.map((l, i) => (i === 0 ? { ...l, id: undefined } : l)),
      ]) {
        const res = await api.patch(`/invoices/${made.id}`, { lines: bad });
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error).toBe("feature_off");
      }
      // A fraction can always become a whole number.
      const whole = await api.patch(`/invoices/${made.id}`, { lines: again.map((l, i) => (i === 0 ? { ...l, quantity: 2 } : l)) });
      expect(whole.json().lines[0]).toMatchObject({ quantity: 2, quantityMilli: null, amountCents: 20000 });
    } finally {
      await off.close();
    }
  });
});

describe("invoicing a work order", () => {
  it("makes one draft from the order's lines and marks the order invoiced", async () => {
    const t = await createTenant(ctx, "Org A");
    const { wo, items } = await finishedWork(t);
    const res = await t.api.post(`/work-orders/${wo.id}/invoice`, {});
    expect(res.statusCode, res.body).toBe(201);
    const { invoiceId, workOrder } = res.json();
    expect(workOrder).toMatchObject({ status: "completed", billingStatus: "invoiced", invoices: [{ id: invoiceId, status: "draft", totalCents: 49250 }] });
    expect(workOrder.events.map((e: { eventType: string }) => e.eventType)).toEqual(["created", "visit_scheduled", "completed", "invoiced"]);
    const inv = (await t.api.get(`/invoices/${invoiceId}`)).json();
    expect(inv).toMatchObject({ status: "draft", customer: { id: t.customer.id }, site: { id: t.site.id }, subtotalCents: 49250, taxCents: 0, totalCents: 49250 });
    expect(inv.lines).toMatchObject([
      { description: "Labor", quantity: 1.5, quantityMilli: 1500, unitPriceCents: 9500, amountCents: 14250, serviceItemId: items.labor.id },
      { description: "Pumping", quantity: 1000, quantityMilli: null, unitPriceCents: 35, amountCents: 35000, serviceItemId: items.pumping.id },
    ]);
    expect(inv.events.map((e: { summary: string }) => e.summary)).toEqual([expect.stringMatching(/^Draft created from work order WO-\d+$/)]);

    // Asking again finds the same invoice.
    const again = await t.api.post(`/work-orders/${wo.id}/invoice`, {});
    expect(again.statusCode).toBe(200);
    expect(again.json().invoiceId).toBe(invoiceId);
  });

  it("makes exactly one invoice when asked many times at once", async () => {
    const t = await createTenant(ctx, "Org A");
    for (let round = 0; round < 4; round++) {
      const { wo } = await finishedWork(t);
      const results = await Promise.all(Array.from({ length: 6 }, () => t.api.post(`/work-orders/${wo.id}/invoice`, {})));
      for (const r of results) expect(r.statusCode, r.body).toBeLessThan(300);
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(new Set(results.map((r) => r.json().invoiceId)).size).toBe(1);
      expect(await liveInvoices(wo.id)).toHaveLength(1);
      expect(await ctx.db.selectFrom("invoices").select("id").where("workOrderId", "=", wo.id).execute()).toHaveLength(1);
    }
  });

  it("has the database refuse a second live invoice for the same order", async () => {
    const t = await createTenant(ctx, "Org A");
    const { wo } = await finishedWork(t);
    const { invoiceId } = (await t.api.post(`/work-orders/${wo.id}/invoice`, {})).json();
    const other = (await t.api.post("/invoices", { customerId: t.customer.id, lines: [{ description: "Other", unitPriceCents: 100 }] })).json();
    await expect(ctx.db.updateTable("invoices").set({ workOrderId: wo.id }).where("id", "=", other.id).execute()).rejects.toThrow(/invoices_one_live_per_work_order/);
    // Another company's order cannot be linked at all.
    const b = await createTenant(ctx, "Org B");
    const bInv = (await b.api.post("/invoices", { customerId: b.customer.id, lines: [{ description: "Other", unitPriceCents: 100 }] })).json();
    await expect(ctx.db.updateTable("invoices").set({ workOrderId: wo.id }).where("id", "=", bInv.id).execute()).rejects.toThrow(/foreign key/);
    expect(invoiceId).toBeTruthy();
  });

  it("returns the order to unbilled when its invoice is voided or discarded, without reopening the work", async () => {
    const t = await createTenant(ctx, "Org A");
    const { wo } = await finishedWork(t);
    const first = (await t.api.post(`/work-orders/${wo.id}/invoice`, {})).json().invoiceId;
    expect((await t.api.post(`/invoices/${first}/issue`, { send: false })).statusCode).toBe(200);
    const voided = await t.api.post(`/invoices/${first}/void`, { reason: "TEST wrong price" });
    expect(voided.statusCode, voided.body).toBe(200);
    let order = (await t.api.get(`/work-orders/${wo.id}`)).json();
    expect(order).toMatchObject({ status: "completed", billingStatus: "unbilled" });
    expect(order.events.at(-1)).toMatchObject({ eventType: "invoice_ended", summary: "Invoice INV-1001 voided: TEST wrong price" });

    // A replacement can be made, and the void one stays listed.
    const second = await t.api.post(`/work-orders/${wo.id}/invoice`, {});
    expect(second.statusCode).toBe(201);
    expect(second.json().invoiceId).not.toBe(first);
    expect(second.json().workOrder.invoices.map((i: { status: string }) => i.status)).toEqual(["void", "draft"]);

    expect((await t.api.post(`/invoices/${second.json().invoiceId}/discard`, {})).statusCode).toBe(204);
    order = (await t.api.get(`/work-orders/${wo.id}`)).json();
    expect(order).toMatchObject({ status: "completed", billingStatus: "unbilled" });
    expect(order.events.at(-1)).toMatchObject({ eventType: "invoice_ended", summary: "Draft invoice discarded" });
    expect(await liveInvoices(wo.id)).toEqual([]);
  });

  it("never fails with a server error when an invoice is voided while another is being made", async () => {
    const t = await createTenant(ctx, "Org A");
    for (let round = 0; round < 4; round++) {
      const { wo } = await finishedWork(t);
      const id = (await t.api.post(`/work-orders/${wo.id}/invoice`, {})).json().invoiceId;
      await t.api.post(`/invoices/${id}/issue`, { send: false });
      const results = await Promise.all([t.api.post(`/invoices/${id}/void`, { reason: "TEST redo" }), t.api.post(`/work-orders/${wo.id}/invoice`, {}), t.api.post(`/work-orders/${wo.id}/invoice`, {})]);
      for (const r of results) expect(r.statusCode, r.body).toBeLessThan(500);
      expect((await liveInvoices(wo.id)).length).toBeLessThanOrEqual(1);
      const order = await ctx.db.selectFrom("workOrders").select("billingStatus").where("id", "=", wo.id).executeTakeFirstOrThrow();
      expect(order.billingStatus).toBe((await liveInvoices(wo.id)).length ? "invoiced" : "unbilled");
    }
  });

  it("refuses drafts, cancelled orders, no-charge orders and orders with nothing to bill", async () => {
    const t = await createTenant(ctx, "Org A");
    const type = await repairType(t.api);
    const draft = (await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: type, draft: true, lines: [{ description: "Labor", quantity: 1, unitPriceCents: 9500 }] })).json();
    expect((await t.api.post(`/work-orders/${draft.id}/invoice`, {})).json().error).toBe("not_billable");
    const empty = (await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: type })).json();
    expect((await t.api.post(`/work-orders/${empty.id}/invoice`, {})).statusCode).toBe(422);
    const free = (await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: type, lines: [{ description: "Warranty", quantity: 1, unitPriceCents: 0 }] })).json();
    expect((await t.api.patch(`/work-orders/${free.id}`, { billingStatus: "no_charge" })).statusCode).toBe(200);
    expect((await t.api.post(`/work-orders/${free.id}/invoice`, {})).json().error).toBe("no_charge");
    const cancelled = (await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: type, lines: [{ description: "Labor", quantity: 1, unitPriceCents: 9500 }] })).json();
    await t.api.post(`/work-orders/${cancelled.id}/cancel`, { reason: "TEST customer cancelled" });
    expect((await t.api.post(`/work-orders/${cancelled.id}/invoice`, {})).json().error).toBe("not_billable");

    // An invoiced order's billing status follows its invoice.
    const open = (await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: type, lines: [{ description: "Labor", quantity: 1, unitPriceCents: 9500 }] })).json();
    expect((await t.api.post(`/work-orders/${open.id}/invoice`, {})).statusCode).toBe(201);
    expect((await t.api.patch(`/work-orders/${open.id}`, { billingStatus: "no_charge" })).json().error).toBe("invoiced");
  });

  it("is for the office and the owner of the order's company only, and off with service items", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const { wo, tech } = await finishedWork(a);
    const techApi = client(ctx.app, await login(ctx.app, tech.email));
    expect((await techApi.post(`/work-orders/${wo.id}/invoice`, {})).statusCode).toBe(403);
    expect((await b.api.post(`/work-orders/${wo.id}/invoice`, {})).statusCode).toBe(404);

    const off = await buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store, loginRateLimit: 1000, features: new Set(["work_orders"]) });
    try {
      const api = client(off, await login(off, a.owner.email));
      expect((await api.post(`/work-orders/${wo.id}/invoice`, {})).json().error).toBe("feature_off");
      // One made while it was on is still found.
      const made = (await a.api.post(`/work-orders/${wo.id}/invoice`, {})).json().invoiceId;
      const found = await api.post(`/work-orders/${wo.id}/invoice`, {});
      expect(found.statusCode).toBe(200);
      expect(found.json().invoiceId).toBe(made);
    } finally {
      await off.close();
    }
    expect(await liveInvoices(wo.id)).toHaveLength(1);
  });
});

// ---- QuickBooks ----

/** The invoice lines exactly as the sync hands them to QuickBooks, serialized as sent. */
const sentLines: string[] = [];
class RecordingProvider extends TestQuickBooksProvider {
  override company(realmId: string) {
    const company = super.company(realmId);
    const create = company.createInvoice.bind(company);
    company.createInvoice = (p, requestId) => {
      sentLines.push(JSON.stringify(p.lines));
      return create(p, requestId);
    };
    return company;
  }
}
const runWorker = (c: TestContext) =>
  drainTasks({ db: c.db, store: c.store, now: () => c.now, appUrl: "https://app.example.test", quickbooks: { provider: new RecordingProvider(c.db, () => c.now), cipher: new TokenCipher() } });

/** Connected to the test company with the default item mapped, and Nora (new to QuickBooks) as a customer. */
async function connected(t: Tenant) {
  const nora = (await t.api.post("/customers", { displayName: "Nora Quinn", billingLine1: "1 Oak Ln", billingCity: "Austin", billingState: "TX", billingPostalCode: "78701" })).json();
  const site = (await t.api.post(`/customers/${nora.id}/sites`, { addressLine1: "9 Elm St", city: "Austin" })).json();
  const start = await t.api.post("/quickbooks/connect", {});
  const url = new URL(start.json().url);
  expect((await t.api.get(`/quickbooks/callback${url.search}`)).statusCode).toBe(302);
  await t.api.post("/quickbooks/review/refresh", {});
  const items = (await t.api.get("/quickbooks/items")).json() as { id: string; name: string }[];
  expect((await t.api.put("/quickbooks/mapping", { defaultItemId: items.find((i) => i.name === "Services")!.id })).statusCode).toBe(200);
  expect((await t.api.put(`/quickbooks/review/${t.customer.id}`, { decision: "skip" })).statusCode).toBe(204);
  expect((await t.api.put(`/quickbooks/review/${nora.id}`, { decision: "create" })).statusCode).toBe(204);
  expect((await t.api.post("/quickbooks/review/commit", {})).statusCode).toBe(200);
  await runWorker(ctx);
  return { realm: url.searchParams.get("realmId")!, nora: nora as { id: string }, site: site as { id: string } };
}

const sentInvoice = async (realm: string, docNumber: string) => Object.values((await new TestCompanies(ctx.db, () => ctx.now).get(realm)).invoices).find((i) => i.docNumber === docNumber)!;

describe("QuickBooks", () => {
  it("sends whole-number invoices exactly as before, and a fraction as its quantity", async () => {
    const t = await createTenant(ctx, "Org A");
    const { realm, nora } = await connected(t);
    sentLines.length = 0;
    const whole = (await t.api.post("/invoices", { customerId: nora.id, lines: [{ description: "Aerator repair", quantity: 2, unitPriceCents: 15000 }, { description: "Filter", unitPriceCents: 1250 }] })).json();
    await t.api.post(`/invoices/${whole.id}/issue`, { send: false });
    const frac = (await t.api.post("/invoices", { customerId: nora.id, lines: [{ description: "Labor", quantity: 1.25, unitPriceCents: 9500 }] })).json();
    await t.api.post(`/invoices/${frac.id}/issue`, { send: false });
    // The customer goes first, then its invoices.
    await runWorker(ctx);
    await runWorker(ctx);

    const item = (await sentInvoice(realm, "INV-1001")).lines[0]!.itemId;
    // The payload of a whole-number invoice, byte for byte as it was before fractional quantities.
    expect(sentLines.sort()).toEqual([
      `[{"itemId":"${item}","description":"Aerator repair","quantity":2,"unitPriceCents":15000,"amountCents":30000},{"itemId":"${item}","description":"Filter","quantity":1,"unitPriceCents":1250,"amountCents":1250}]`,
      `[{"itemId":"${item}","description":"Labor","quantity":1.25,"unitPriceCents":9500,"amountCents":11875}]`,
    ]);
  });

  it("sends a service item's lines under the QuickBooks item chosen for it, and the default item otherwise", async () => {
    const t = await createTenant(ctx, "Org A");
    const { realm, nora } = await connected(t);
    const { labor, pumping } = await catalog(t.api);
    const items = (await t.api.get("/quickbooks/items")).json() as { id: string; name: string }[];
    const services = items.find((i) => i.name === "Services")!;
    const repair = items.find((i) => i.name === "Septic repair")!;
    const put = await t.api.put("/quickbooks/mapping", { serviceItems: [{ serviceItemId: labor.id, itemId: repair.id }] });
    expect(put.statusCode).toBe(200);
    expect(put.json().serviceItems).toEqual([
      { serviceItemId: labor.id, name: "Labor", active: true, item: { id: repair.id, name: "Septic repair" } },
      { serviceItemId: pumping.id, name: "Pumping", active: true, item: null },
    ]);
    // The choice is a mapping, not a sent record: the sync health counts it apart from invoices.
    expect((await t.api.get("/quickbooks")).json().counts.service_item).toEqual({ synced: 1 });

    const inv = (
      await t.api.post("/invoices", {
        customerId: nora.id,
        lines: [
          { description: "Labor", quantity: 1.5, unitPriceCents: 9500, serviceItemId: labor.id },
          { description: "Pumping", quantity: 1000, unitPriceCents: 35, serviceItemId: pumping.id },
          { description: "Trip charge", unitPriceCents: 4500 },
        ],
      })
    ).json();
    await t.api.post(`/invoices/${inv.id}/issue`, { send: false });
    await runWorker(ctx);
    await runWorker(ctx);
    expect((await sentInvoice(realm, "INV-1001")).lines.map((l) => [l.description, l.itemId])).toEqual([
      ["Labor", repair.id],
      ["Pumping", services.id],
      ["Trip charge", services.id],
    ]);

    // Clearing the choice puts the item's lines back on the default item.
    const cleared = await t.api.put("/quickbooks/mapping", { serviceItems: [{ serviceItemId: labor.id, itemId: null }] });
    expect(cleared.json().serviceItems.find((i: { serviceItemId: string }) => i.serviceItemId === labor.id).item).toBeNull();
    expect(await ctx.db.selectFrom("quickbooksLinks").select("id").where("entityType", "=", "service_item").execute()).toEqual([]);
  });

  it("holds an invoice whose service item maps to an archived QuickBooks item, naming the service item", async () => {
    const t = await createTenant(ctx, "Org A");
    const { realm, nora } = await connected(t);
    const { labor } = await catalog(t.api);
    const repair = ((await t.api.get("/quickbooks/items")).json() as { id: string; name: string }[]).find((i) => i.name === "Septic repair")!;
    await t.api.put("/quickbooks/mapping", { serviceItems: [{ serviceItemId: labor.id, itemId: repair.id }] });
    await new TestCompanies(ctx.db, () => ctx.now).setItemActive(realm, repair.id, false);
    const inv = (await t.api.post("/invoices", { customerId: nora.id, lines: [{ description: "Labor", quantity: 2, unitPriceCents: 9500, serviceItemId: labor.id }] })).json();
    await t.api.post(`/invoices/${inv.id}/issue`, { send: false });
    await runWorker(ctx);
    await runWorker(ctx);
    const link = await ctx.db.selectFrom("quickbooksLinks").select(["status", "conflictKind", "conflict"]).where("entityType", "=", "invoice").where("entityId", "=", inv.id).executeTakeFirstOrThrow();
    expect(link).toMatchObject({ status: "conflict", conflictKind: "item_missing", conflict: { reason: "inactive", itemId: repair.id, plans: ["Labor"] } });
  });

  it("maps only the company's own service items", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    await connected(a);
    const theirs = (await b.api.post("/service-items", { name: "Labor", unit: "hour", unitPriceCents: 9900 })).json();
    const repair = ((await a.api.get("/quickbooks/items")).json() as { id: string; name: string }[]).find((i) => i.name === "Septic repair")!;
    const res = await a.api.put("/quickbooks/mapping", { serviceItems: [{ serviceItemId: theirs.id, itemId: repair.id }] });
    expect(res.statusCode).toBe(404);
    expect(await ctx.db.selectFrom("quickbooksLinks").select("id").where("entityType", "=", "service_item").execute()).toEqual([]);
    // Org A's mapping never lists Org B's items.
    expect((await a.api.get("/quickbooks/mapping")).json().serviceItems).toEqual([]);
  });

  it("syncs an untaxed invoice made from a work order", async () => {
    const t = await createTenant(ctx, "Org A");
    const { realm, nora, site } = await connected(t);
    const tech = await createUser(ctx.db, t.org.id, "technician");
    const wo = (await t.api.post("/work-orders", { siteId: site.id, workTypeId: await repairType(t.api), lines: [{ description: "Labor", quantity: 0.75, unitPriceCents: 9500 }] })).json();
    await t.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: tech.id, scheduledDate: "2026-03-02" });
    await t.api.post(`/work-orders/${wo.id}/complete`, { reason: "TEST paper ticket" });
    const { invoiceId } = (await t.api.post(`/work-orders/${wo.id}/invoice`, {})).json();
    expect((await t.api.post(`/invoices/${invoiceId}/issue`, { send: false })).json()).toMatchObject({ customer: { id: nora.id }, taxCents: 0, totalCents: 7125 });
    await runWorker(ctx);
    await runWorker(ctx);
    expect(await ctx.db.selectFrom("quickbooksLinks").select(["status"]).where("entityType", "=", "invoice").where("entityId", "=", invoiceId).executeTakeFirst()).toEqual({ status: "synced" });
    expect((await sentInvoice(realm, "INV-1001")).lines).toEqual([expect.objectContaining({ description: "Labor", quantity: 0.75, amountCents: 7125 })]);
  });
});
