import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createTenant, setupTestApp } from "./helpers.ts";

// A double click, or a retry after an answer that never arrived, sends the same create twice.
// Work orders, contacts and plan versions are made once however many times the save arrives.

const ctx = setupTestApp({ features: ["work_orders", "plan_builder"] });

type Tenant = Awaited<ReturnType<typeof createTenant>>;

const workType = async (t: Tenant) => ((await t.api.get("/work-types")).json().items as { id: string; key: string }[]).find((w) => w.key === "repair")!.id;
const count = async (table: string, organizationId: string) =>
  Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(table)} where organization_id = ${organizationId}`.execute(ctx.db)).rows[0]!.n);

describe("repeated saves", () => {
  it("makes one work order for a creationId sent twice at once, and refuses the id for a different order", async () => {
    const t = await createTenant(ctx, "Org A");
    const creationId = crypto.randomUUID();
    const body = { siteId: t.site.id, workTypeId: await workType(t), title: "Riser lid", creationId };
    const [a, b] = await Promise.all([t.api.post("/work-orders", body), t.api.post("/work-orders", body)]);
    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode, b.body).toBe(201);
    expect(a.json().id).toBe(creationId);
    expect(b.json()).toMatchObject({ id: creationId, label: a.json().label });
    expect(await count("work_orders", t.org.id)).toBe(1);

    // The retry after a lost answer finds the same order.
    expect((await t.api.post("/work-orders", body)).json().id).toBe(creationId);

    // The id cannot be reused for another site, or by another company.
    const site2 = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "2 Main St", city: "Austin" })).json();
    expect((await t.api.post("/work-orders", { ...body, siteId: site2.id })).statusCode).toBe(422);
    const other = await createTenant(ctx, "Org B");
    const theirs = await other.api.post("/work-orders", { siteId: other.site.id, workTypeId: await workType(other), creationId });
    expect(theirs.statusCode).toBe(422);
    expect(await count("work_orders", other.org.id)).toBe(0);

    // Without a creationId each save is its own order, as before.
    await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: await workType(t) });
    expect(await count("work_orders", t.org.id)).toBe(2);
  });

  it("adds a contact once for a creationId sent twice", async () => {
    const t = await createTenant(ctx, "Org A");
    const before = await count("contacts", t.org.id);
    const creationId = crypto.randomUUID();
    const body = { name: "Dana Doe", phone: "5125550199", type: "billing", creationId };
    const [a, b] = await Promise.all([t.api.post(`/customers/${t.customer.id}/contacts`, body), t.api.post(`/customers/${t.customer.id}/contacts`, body)]);
    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode, b.body).toBe(201);
    expect(a.json()).toMatchObject({ id: creationId, name: "Dana Doe", type: "billing" });
    expect(b.json()).toMatchObject({ id: creationId, name: "Dana Doe" });
    expect(await count("contacts", t.org.id)).toBe(before + 1);

    const otherCustomer = (await t.api.post("/customers", { displayName: "Someone else" })).json();
    expect((await t.api.post(`/customers/${otherCustomer.id}/contacts`, body)).statusCode).toBe(422);
  });

  it("refuses a plan version saved against a version that is no longer current, so a double click makes one", async () => {
    const t = await createTenant(ctx, "Org A");
    const plan = (await t.api.post("/plans", { name: "Basic", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
    const v1 = (await t.api.get(`/plans/${plan.id}`)).json();
    const body = { termsText: null, options: [], coverage: [], expectedVersion: v1.version };
    const [a, b] = await Promise.all([t.api.post(`/plans/${plan.id}/versions`, body), t.api.post(`/plans/${plan.id}/versions`, body)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expect(refused.json()).toMatchObject({ error: "plan_version_changed", message: expect.stringContaining("version 2") });
    expect(await count("plan_versions", t.org.id)).toBe(2);

    // Saved against the version now current, it goes through.
    expect((await t.api.post(`/plans/${plan.id}/versions`, { ...body, expectedVersion: 2 })).statusCode).toBe(201);
    // Without expectedVersion the save is accepted as before.
    expect((await t.api.post(`/plans/${plan.id}/versions`, { termsText: null, options: [], coverage: [] })).statusCode).toBe(201);
  });
});

describe("the session", () => {
  it("carries the deployment's features and the company's own date, so the office menu draws once", async () => {
    const t = await createTenant(ctx, "Org A");
    // 8:30 PM in Texas on Feb 28 is already Mar 1 in UTC.
    ctx.now = new Date("2026-03-01T02:30:00Z");
    const me = (await t.api.get("/auth/me")).json();
    expect(me.features).toEqual(["plan_builder", "work_orders"]);
    expect(me.today).toBe("2026-02-28");
  });
});
