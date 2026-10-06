import { describe, expect, it } from "vitest";
import { client, createOrg, createTenant, createUser, login, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();

describe("first-run intros", () => {
  it("each person closes and reopens their own intros, kept on their account", async () => {
    const t = await createTenant(ctx, "Org A");
    expect((await t.api.get("/auth/me")).json().introsDismissed).toEqual([]);

    const closed = await t.api.put("/auth/me/intros/office", { dismissed: true });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toEqual({ introsDismissed: ["office"] });
    // Closing again keeps one entry.
    expect((await t.api.put("/auth/me/intros/office", { dismissed: true })).json()).toEqual({ introsDismissed: ["office"] });
    expect((await t.api.get("/auth/me")).json().introsDismissed).toEqual(["office"]);

    // Someone else in the company still sees theirs.
    const office = await createUser(ctx.db, t.org.id, "office");
    const other = client(ctx.app, await login(ctx.app, office.email));
    expect((await other.get("/auth/me")).json().introsDismissed).toEqual([]);

    // Signed in again, or in another company, it stays closed for the same person.
    const second = await createOrg(ctx.db, "Org B");
    await ctx.db.insertInto("memberships").values({ organizationId: second.id, userId: t.owner.id, role: "technician", technicianLicense: null, active: true }).execute();
    const elsewhere = client(ctx.app, await login(ctx.app, t.owner.email, undefined, second.id));
    expect((await elsewhere.get("/auth/me")).json().introsDismissed).toEqual(["office"]);

    expect((await t.api.put("/auth/me/intros/office", { dismissed: false })).json()).toEqual({ introsDismissed: [] });
  });

  it("a technician closes theirs, also while the plan is read-only; unknown intros and signed-out callers are refused", async () => {
    const t = await createTenant(ctx, "Org A");
    const tech = await createUser(ctx.db, t.org.id, "technician");
    const api = client(ctx.app, await login(ctx.app, tech.email));
    await ctx.db.updateTable("organizations").set({ subscriptionState: "read_only" }).where("id", "=", t.org.id).execute();
    expect((await api.put("/auth/me/intros/technician", { dismissed: true })).json()).toEqual({ introsDismissed: ["technician"] });

    expect((await api.put("/auth/me/intros/billing", { dismissed: true })).statusCode).toBe(400);
    expect((await client(ctx.app).put("/auth/me/intros/office", { dismissed: true })).statusCode).toBe(401);
  });
});
