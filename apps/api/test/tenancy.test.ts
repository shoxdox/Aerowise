import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();

// Acceptance test: a user from Org A cannot read or update any Org B record.
describe("tenant isolation", () => {
  const setup = async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    return { a, b };
  };

  it("hides other organizations' records from lists and searches", async () => {
    const { a, b } = await setup();
    const customers = (await a.api.get("/customers")).json();
    expect(customers.items.map((c: { id: string }) => c.id)).toEqual([a.customer.id]);
    expect(customers.total).toBe(1);
    const search = (await a.api.get("/customers?search=Org%20B")).json();
    expect(search.items).toHaveLength(0);
    const sites = (await a.api.get("/sites")).json();
    expect(sites.items.map((s: { id: string }) => s.id)).toEqual([a.site.id]);
    expect(sites.items[0].id).not.toBe(b.site.id);
  });

  it("answers 404 when reading another organization's customer or site", async () => {
    const { a, b } = await setup();
    expect((await a.api.get(`/customers/${b.customer.id}`)).statusCode).toBe(404);
    expect((await a.api.get(`/sites/${b.site.id}`)).statusCode).toBe(404);
  });

  it("answers 404 and changes nothing when updating another organization's records", async () => {
    const { a, b } = await setup();
    const attempts = [
      await a.api.patch(`/customers/${b.customer.id}`, { displayName: "Hijacked" }),
      await a.api.patch(`/contacts/${b.contact.id}`, { name: "Hijacked" }),
      await a.api.patch(`/sites/${b.site.id}`, { gateCode: "0000" }),
      await a.api.patch(`/systems/${b.system.id}`, { model: "Hijacked" }),
    ];
    for (const res of attempts) expect(res.statusCode).toBe(404);

    const customer = (await b.api.get(`/customers/${b.customer.id}`)).json();
    expect(customer.displayName).toBe("Org B customer");
    expect(customer.contacts[0].name).toBe("Pat");
    const site = (await b.api.get(`/sites/${b.site.id}`)).json();
    expect(site.gateCode).toBeNull();
    expect(site.systems[0].model).toBeNull();
  });

  it("refuses to attach new records to another organization's parents", async () => {
    const { a, b } = await setup();
    expect((await a.api.post(`/customers/${b.customer.id}/sites`, { addressLine1: "9 Elm", city: "Austin" })).statusCode).toBe(404);
    expect((await a.api.post(`/customers/${b.customer.id}/contacts`, { name: "X" })).statusCode).toBe(404);
    expect((await a.api.post(`/sites/${b.site.id}/systems`, { manufacturer: "X" })).statusCode).toBe(404);
    // A contact on A's own customer cannot point at B's site.
    const res = await a.api.post(`/customers/${a.customer.id}/contacts`, { name: "X", siteId: b.site.id });
    expect(res.statusCode).toBe(422);
    const moved = await a.api.patch(`/contacts/${a.contact.id}`, { siteId: b.site.id });
    expect(moved.statusCode).toBe(422);
  });

  it("enforces the same boundary in the database itself", async () => {
    const { a, b } = await setup();
    // Bypassing the API, a site in org A cannot reference org B's customer.
    await expect(
      ctx.db
        .insertInto("sites")
        .values({ organizationId: a.org.id, customerId: b.customer.id, addressLine1: "x", city: "x" })
        .execute(),
    ).rejects.toThrow(/foreign key/);
  });

  it("scopes a member of both organizations to the one their session is for", async () => {
    const { a, b } = await setup();
    const user = await createUser(ctx.db, a.org.id, "office");
    await ctx.db.insertInto("memberships").values({ organizationId: b.org.id, userId: user.id, role: "office", technicianLicense: null }).execute();
    const api = client(ctx.app, await login(ctx.app, user.email, undefined, a.org.id));
    expect((await api.get(`/customers/${a.customer.id}`)).statusCode).toBe(200);
    expect((await api.get(`/customers/${b.customer.id}`)).statusCode).toBe(404);
  });
});
