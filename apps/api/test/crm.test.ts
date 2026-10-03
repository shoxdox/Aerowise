import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createTenant, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();

describe("customers, sites and systems", () => {
  it("creates a customer with a site, contact and system and returns them together", async () => {
    const t = await createTenant(ctx, "Org A");
    const customer = (await t.api.get(`/customers/${t.customer.id}`)).json();
    expect(customer.sites).toHaveLength(1);
    expect(customer.contacts[0]).toMatchObject({ name: "Pat", siteId: t.site.id, type: "primary" });

    const site = (await t.api.get(`/sites/${t.site.id}`)).json();
    expect(site).toMatchObject({ state: "TX", customer: { id: t.customer.id, displayName: "Org A customer" } });
    expect(site.systems).toEqual([expect.objectContaining({ manufacturer: "Acme", active: true })]);
  });

  it("stores access details technicians need on site", async () => {
    const t = await createTenant(ctx, "Org A");
    const res = await t.api.patch(`/sites/${t.site.id}`, {
      gateCode: "4821",
      safetyFlags: ["dog", "locked_gate"],
      accessNotes: "Gate on the east side",
      permitNumber: "P-123",
      lat: 30.19,
      lng: -98.09,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ gateCode: "4821", safetyFlags: ["dog", "locked_gate"], lat: 30.19 });
  });

  it("only changes the fields a PATCH sends", async () => {
    const t = await createTenant(ctx, "Org A");
    await t.api.patch(`/customers/${t.customer.id}`, { notes: "Prefers mornings", tags: ["vip"] });
    const res = await t.api.patch(`/customers/${t.customer.id}`, { status: "inactive" });
    expect(res.json()).toMatchObject({ displayName: "Org A customer", notes: "Prefers mornings", tags: ["vip"], status: "inactive" });

    await t.api.patch(`/sites/${t.site.id}`, { safetyFlags: ["dog"] });
    const site = (await t.api.patch(`/sites/${t.site.id}`, { gateCode: "1" })).json();
    expect(site).toMatchObject({ safetyFlags: ["dog"], active: true, state: "TX" });
  });

  it("rejects invalid input with field-level errors", async () => {
    const t = await createTenant(ctx, "Org A");
    const res = await t.api.post("/customers", { displayName: "", billingPostalCode: "abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    const badFlag = await t.api.patch(`/sites/${t.site.id}`, { safetyFlags: ["unicorn"] });
    expect(badFlag.statusCode).toBe(400);
  });

  it("finds customers by name, site address or permit number", async () => {
    const t = await createTenant(ctx, "Org A");
    await t.api.patch(`/sites/${t.site.id}`, { permitNumber: "PERMIT-778" });
    const other = (await t.api.post("/customers", { displayName: "Zed Zimmerman" })).json();
    for (const [q, expected] of [["zimmer", other.id], ["main st", t.customer.id], ["permit-778", t.customer.id]]) {
      const res = (await t.api.get(`/customers?search=${encodeURIComponent(q!)}`)).json();
      expect(res.items.map((c: { id: string }) => c.id)).toEqual([expected]);
    }
    // LIKE wildcards in the search are matched literally.
    expect((await t.api.get("/customers?search=%25")).json().items).toHaveLength(0);
  });

  it("pages through customers with a stable order and site counts", async () => {
    const t = await createTenant(ctx, "Org A");
    for (const name of ["Bravo", "alpha", "Charlie"]) await t.api.post("/customers", { displayName: name });
    const page = (await t.api.get("/customers?limit=2&offset=0")).json();
    expect(page.total).toBe(4);
    expect(page.items.map((c: { displayName: string }) => c.displayName)).toEqual(["alpha", "Bravo"]);
    const all = (await t.api.get("/customers")).json();
    expect(all.items.find((c: { id: string }) => c.id === t.customer.id).siteCount).toBe(1);
  });
});

describe("audit log", () => {
  it("records who changed what", async () => {
    const t = await createTenant(ctx, "Org A");
    await t.api.patch(`/sites/${t.site.id}`, { gateCode: "1111" });
    const events = await ctx.db
      .selectFrom("auditEvents")
      .select(["action", "entityId", "actorUserId", "organizationId", "changes"])
      .orderBy("id")
      .execute();
    expect(events.map((e) => e.action)).toEqual(["customer.created", "site.created", "contact.created", "system.created", "site.updated"]);
    expect(events.at(-1)).toMatchObject({ entityId: t.site.id, actorUserId: t.owner.id, organizationId: t.org.id, changes: { gateCode: "1111" } });
  });

  it("cannot be edited or deleted", async () => {
    await createTenant(ctx, "Org A");
    await expect(sql`update audit_events set action = 'x'`.execute(ctx.db)).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit_events`.execute(ctx.db)).rejects.toThrow(/append-only/);
  });
});
