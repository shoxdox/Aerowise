import { describe, expect, it } from "vitest";
import { client, createOrg, createTenant, createUser, login, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();

const keysNotDone = (body: { items: { key: string; done: boolean }[] }) => body.items.filter((i) => !i.done).map((i) => i.key);

async function freshCompany() {
  const org = await createOrg(ctx.db, "Brand New Co");
  const owner = await createUser(ctx.db, org.id, "owner");
  return { org, owner, api: client(ctx.app, await login(ctx.app, owner.email)) };
}

describe("first-run checklist", () => {
  it("lists every step for a brand-new company", async () => {
    const { api } = await freshCompany();
    const res = await api.get("/onboarding");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().complete).toBe(false);
    expect(keysNotDone(res.json())).toEqual(["company_details", "responsible_mp", "technicians", "service_counties", "customers", "stripe", "quickbooks"]);
  });

  it("is complete once the company has done each step, and only from real records", async () => {
    const t = await createTenant(ctx, "Org A"); // comes with a customer
    await t.api.patch("/organization/settings", { phone: "(979) 555-0100", addressLine1: "12 Main St", city: "Bryan", state: "TX", postalCode: "77801", serviceCounties: ["Brazos County"] });
    const mp = (await t.api.post("/credentials", { userId: t.owner.id, holderName: "Owner Person", kind: "tceq_maintenance_provider", number: "MP0001234", verifiedOn: "2026-02-20", verificationSource: "TCEQ license search" })).json();
    await t.api.put("/settings/responsible-provider", { credentialId: mp.id });
    const tech = await createUser(ctx.db, t.org.id, "technician");
    expect(keysNotDone((await t.api.get("/onboarding")).json())).toEqual(["technicians", "stripe", "quickbooks"]);

    // A technician without a license keeps the step open, with their name.
    const tech1 = (await t.api.get("/onboarding")).json().items.find((i: { key: string }) => i.key === "technicians");
    expect(tech1.detail).toContain("technician user");
    const lic = (await t.api.post("/credentials", { userId: tech.id, holderName: "Tina Tech", kind: "tceq_maintenance_technician", number: "MT0005678", expiresOn: "2027-01-31" })).json();
    expect(lic.id).toBeTruthy();
    await ctx.db.updateTable("organizations").set({ stripeChargesEnabled: true }).where("id", "=", t.org.id).execute();

    const done = (await t.api.get("/onboarding")).json();
    expect(done.complete).toBe(true);
    expect(keysNotDone(done)).toEqual(["quickbooks"]);

    // An expired license reopens the step.
    await ctx.db.updateTable("providerCredentials").set({ expiresOn: "2026-02-01" }).where("id", "=", lic.id).execute();
    expect((await t.api.get("/onboarding")).json().complete).toBe(false);
  });

  it("is for the owner and office, and counts only the company's own records", async () => {
    const a = await createTenant(ctx, "Org A");
    const { api: freshApi } = await freshCompany();
    await a.api.patch("/organization/settings", { serviceCounties: ["Travis County"] });
    // Org A's customer and counties do not count for the new company.
    expect(keysNotDone((await freshApi.get("/onboarding")).json())).toContain("customers");
    expect(keysNotDone((await freshApi.get("/onboarding")).json())).toContain("service_counties");
    for (const role of ["technician", "read_only"] as const) {
      const u = await createUser(ctx.db, a.org.id, role);
      expect((await client(ctx.app, await login(ctx.app, u.email)).get("/onboarding")).statusCode).toBe(403);
    }
    const office = await createUser(ctx.db, a.org.id, "office");
    expect((await client(ctx.app, await login(ctx.app, office.email)).get("/onboarding")).statusCode).toBe(200);
  });
});
