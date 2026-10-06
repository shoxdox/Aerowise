import { TestPaymentProvider } from "@aerowise/payments";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { adminLogin, client, createAdmin, createTenant, setupTestApp, type TestContext } from "./helpers.ts";

const ctx = setupTestApp();

const LINES = [
  { description: "Aerator repair", quantity: 1, unitPriceCents: 30000 },
  { description: "Chlorine tablets", quantity: 2, unitPriceCents: 1250, taxable: true },
];

describe("platform fee on homeowner payments", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  /** An app whose Stripe Connect stand-in the test can look into, and a company ready to take payments on it. */
  async function world(c: TestContext) {
    const stripe = new TestPaymentProvider();
    const app = await buildApp({ db: c.db, loginRateLimit: 1000, now: () => c.now, store: c.store, payments: stripe });
    apps.push(app);
    const t = await createTenant(c, "Org A");
    const office = client(app, t.cookie);
    expect((await office.post("/billing/stripe/connect", {})).statusCode).toBe(200);
    expect((await office.post("/billing/stripe/refresh", {})).json().stripe.chargesEnabled).toBe(true);
    await createAdmin(c);
    const admin = client(app, await adminLogin(c));
    const issue = async () => {
      const draft = (await office.post("/invoices", { customerId: t.customer.id, siteId: t.site.id, lines: LINES })).json();
      const inv = (await office.post(`/invoices/${draft.id}/issue`, { send: false })).json();
      return { id: inv.id as string, token: (inv.payUrl as string).split("/pay/")[1]! };
    };
    const checkout = async (token: string) => (await client(app).post(`/pay/${token}/checkout`, {})).json().url as string;
    const sessions = () => c.db.selectFrom("checkoutSessions").select(["amountCents", "applicationFeeCents"]).orderBy("createdAt").execute();
    return { stripe, app, t, office, admin, issue, checkout, sessions };
  }

  it("takes no fee by default", async () => {
    const w = await world(ctx);
    const inv = await w.issue();
    await w.checkout(inv.token);
    expect(w.stripe.checkouts).toHaveLength(1);
    expect(w.stripe.checkouts[0]).toMatchObject({ amountCents: 32500, applicationFeeCents: 0 });
    expect(await w.sessions()).toEqual([{ amountCents: 32500, applicationFeeCents: 0 }]);
    const listed = (await w.admin.get("/admin/organizations")).json().items;
    expect(listed[0]).toMatchObject({ id: w.t.org.id, platformFeeBps: 0 });
  });

  it("passes the organization's fee to Stripe on every new payment page, audited", async () => {
    const w = await world(ctx);
    const inv = await w.issue();
    const before = await w.checkout(inv.token);

    // 2.5%: $325.00 pays Aerowise $8.12 (rounded down to the cent).
    const res = await w.admin.put(`/admin/organizations/${w.t.org.id}/platform-fee`, { platformFeeBps: 250 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: w.t.org.id, platformFeeBps: 250 });

    // The page opened at no fee is not reused: the homeowner gets one at the new fee.
    const after = await w.checkout(inv.token);
    expect(after).not.toBe(before);
    expect(w.stripe.checkouts.map((c) => c.applicationFeeCents)).toEqual([0, 812]);
    expect(await w.sessions()).toEqual([
      { amountCents: 32500, applicationFeeCents: 0 },
      { amountCents: 32500, applicationFeeCents: 812 },
    ]);
    // Pressing Pay again reuses the page at the current fee.
    expect(await w.checkout(inv.token)).toBe(after);

    const audit = await ctx.db.selectFrom("platformAuditEvents").select(["action", "organizationId", "changes"]).where("action", "=", "organization.platform_fee_changed").execute();
    expect(audit).toEqual([{ action: "organization.platform_fee_changed", organizationId: w.t.org.id, changes: { before: 0, after: 250 } }]);
    // Setting the same fee again changes nothing.
    await w.admin.put(`/admin/organizations/${w.t.org.id}/platform-fee`, { platformFeeBps: 250 });
    expect(await ctx.db.selectFrom("platformAuditEvents").select("id").where("action", "=", "organization.platform_fee_changed").execute()).toHaveLength(1);
  });

  it("is set by Aerowise admins only, within 0 to 10%", async () => {
    const w = await world(ctx);
    const other = await createTenant(ctx, "Org B");
    expect((await w.admin.put(`/admin/organizations/${w.t.org.id}/platform-fee`, { platformFeeBps: 1001 })).statusCode).toBe(400);
    expect((await w.admin.put(`/admin/organizations/${w.t.org.id}/platform-fee`, { platformFeeBps: -1 })).statusCode).toBe(400);
    expect((await w.admin.put(`/admin/organizations/${w.t.org.id}/platform-fee`, { platformFeeBps: 12.5 })).statusCode).toBe(400);
    // A company's own owner cannot set it, for itself or anyone else.
    expect((await w.office.put(`/admin/organizations/${w.t.org.id}/platform-fee`, { platformFeeBps: 0 })).statusCode).toBe(401);
    expect((await w.admin.put(`/admin/organizations/${other.org.id}/platform-fee`, { platformFeeBps: 1000 })).statusCode).toBe(200);
    // One company's fee never touches another's payments.
    await w.checkout((await w.issue()).token);
    expect(w.stripe.checkouts[0]!.applicationFeeCents).toBe(0);
  });
});
