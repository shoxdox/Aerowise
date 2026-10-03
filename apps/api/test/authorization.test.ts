import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { authPlugin } from "../src/auth/plugin.ts";
import { client, createOrg, createTenant, createUser, login, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();

describe("role permissions", () => {
  it("lets office staff create and edit records", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const office = await createUser(ctx.db, org.id, "office");
    const api = client(ctx.app, await login(ctx.app, office.email));
    const created = await api.post("/customers", { displayName: "New customer" });
    expect(created.statusCode).toBe(201);
    expect((await api.patch(`/customers/${created.json().id}`, { notes: "Prefers mornings" })).statusCode).toBe(200);
  });

  it.each(["technician", "read_only"] as const)("lets a %s read records but not change them", async (role) => {
    const tenant = await createTenant(ctx, "Org A");
    const user = await createUser(ctx.db, tenant.org.id, role);
    const api = client(ctx.app, await login(ctx.app, user.email));

    expect((await api.get(`/customers/${tenant.customer.id}`)).statusCode).toBe(200);
    expect((await api.get(`/sites/${tenant.site.id}`)).statusCode).toBe(200);

    const writes = [
      await api.post("/customers", { displayName: "X" }),
      await api.patch(`/customers/${tenant.customer.id}`, { notes: "x" }),
      await api.post(`/customers/${tenant.customer.id}/contacts`, { name: "X" }),
      await api.patch(`/contacts/${tenant.contact.id}`, { name: "X" }),
      await api.post(`/customers/${tenant.customer.id}/sites`, { addressLine1: "2 Main", city: "Austin" }),
      await api.patch(`/sites/${tenant.site.id}`, { gateCode: "1234" }),
      await api.post(`/sites/${tenant.site.id}/systems`, { manufacturer: "X" }),
      await api.patch(`/systems/${tenant.system.id}`, { model: "X" }),
    ];
    for (const res of writes) expect(res.statusCode).toBe(403);
  });
});

describe("deny by default", () => {
  it("refuses to register a route that declares no permission", async () => {
    const app = Fastify();
    await app.register(cookie);
    await app.register(authPlugin, { db: ctx.db });
    expect(() => app.get("/unguarded", async () => "nope")).toThrow(/must declare config.permission/);
    await app.close();
  });

  it("requires a session on every CRM route", async () => {
    const id = crypto.randomUUID();
    const api = client(ctx.app);
    const calls = [
      api.get("/customers"),
      api.get(`/customers/${id}`),
      api.post("/customers", { displayName: "X" }),
      api.patch(`/customers/${id}`, {}),
      api.post(`/customers/${id}/contacts`, { name: "X" }),
      api.patch(`/contacts/${id}`, {}),
      api.post(`/customers/${id}/sites`, { addressLine1: "1", city: "A" }),
      api.get("/sites"),
      api.get(`/sites/${id}`),
      api.patch(`/sites/${id}`, {}),
      api.post(`/sites/${id}/systems`, {}),
      api.patch(`/systems/${id}`, {}),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(401);
  });
});
