import { countActiveContracts, runPlanLifecycle, TestBillingProvider } from "@aerowise/billing";
import type { EmailMessage, EmailTransport } from "@aerowise/compliance";
import { DEFAULT_SUBSCRIPTION_CONFIG, type SubscriptionState } from "@aerowise/domain";
import { drainTasks, scheduleBillingRuns } from "@aerowise/tasks";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { setup } from "./inspection-helpers.ts";

const ctx = setupTestApp();
const config = DEFAULT_SUBSCRIPTION_CONFIG;

function recorder() {
  const sent: EmailMessage[] = [];
  const keys = new Set<string>();
  const transport: EmailTransport = {
    name: "recorder",
    async send(m) {
      // Like every transport: a repeated idempotency key is delivered once.
      if (!keys.has(m.idempotencyKey)) sent.push(m);
      keys.add(m.idempotencyKey);
      return { messageId: m.idempotencyKey, acceptedAt: new Date().toISOString(), response: {} };
    },
  };
  return { sent, mail: { transport, from: "accounts@example.com", appUrl: "https://app.example.com" } };
}

async function setPlan(c: TestContext, organizationId: string, state: SubscriptionState, endsOn: string | null, extra: { price?: number; minimum?: number } = {}) {
  await c.db
    .updateTable("organizations")
    .set({
      subscriptionState: state,
      subscriptionStartsOn: "2026-03-01",
      subscriptionEndsOn: endsOn,
      pricePerContractCentsOverride: extra.price ?? null,
      monthlyMinimumCentsOverride: extra.minimum ?? null,
    })
    .where("id", "=", organizationId)
    .execute();
}

const planOf = (c: TestContext, organizationId: string) =>
  c.db.selectFrom("organizations").select(["subscriptionState", "subscriptionStartsOn", "subscriptionEndsOn"]).where("id", "=", organizationId).executeTakeFirstOrThrow();

const at = (c: TestContext, date: string) => {
  c.now = new Date(`${date}T18:00:00Z`);
};

describe("plan reminders", () => {
  it("emails the active owners 14, 7 and 1 days before a trial ends, once each", async () => {
    const a = await createTenant(ctx, "Org A");
    const secondOwner = await createUser(ctx.db, a.org.id, "owner");
    const formerOwner = await createUser(ctx.db, a.org.id, "owner", { membershipActive: false });
    await createUser(ctx.db, a.org.id, "office");
    await setPlan(ctx, a.org.id, "trial", "2026-03-31");
    const { sent, mail } = recorder();
    const run = () => runPlanLifecycle({ db: ctx.db, provider: new TestBillingProvider(), config, now: ctx.now, mail }, a.org.id);

    expect((await run()).reminded).toEqual([]);
    at(ctx, "2026-03-17");
    expect((await run()).reminded).toEqual([14]);
    expect((await run()).reminded).toEqual([]);
    at(ctx, "2026-03-20");
    expect((await run()).reminded).toEqual([]);
    at(ctx, "2026-03-24");
    expect((await run()).reminded).toEqual([7]);
    at(ctx, "2026-03-30");
    expect((await run()).reminded).toEqual([1]);
    expect((await run()).reminded).toEqual([]);

    expect(sent.map((m) => m.subject)).toEqual([
      "Your Aerowise trial ends in 14 days",
      "Your Aerowise trial ends in 14 days",
      "Your Aerowise trial ends in 7 days",
      "Your Aerowise trial ends in 7 days",
      "Your Aerowise trial ends tomorrow",
      "Your Aerowise trial ends tomorrow",
    ]);
    expect(new Set(sent.map((m) => m.to))).toEqual(new Set([a.owner.email, secondOwner.email]));
    expect(sent.map((m) => m.to)).not.toContain(formerOwner.email);
    expect(sent[0]).toMatchObject({ organizationId: a.org.id, from: "accounts@example.com" });
    expect(sent[0]!.text).toContain("Org A's Aerowise trial ends in 14 days, on 2026-03-31.");
    expect(sent[0]!.text).toContain("$1.50 per active contract per month, with a $99.00 monthly minimum");
    expect(sent[0]!.text).toContain("Add a payment method before then");
    expect(sent[0]!.text).toContain("https://app.example.com/settings/subscription");
    // Still a trial: reminders never change the plan.
    expect((await planOf(ctx, a.org.id)).subscriptionState).toBe("trial");
  });

  it("sends one reminder, not several, for a period that starts inside the window, and keeps organizations apart", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    await setPlan(ctx, a.org.id, "design_partner", "2026-03-05");
    await setPlan(ctx, b.org.id, "trial", "2026-04-30");
    const { sent, mail } = recorder();
    const provider = new TestBillingProvider();
    for (const org of [a.org.id, b.org.id]) await runPlanLifecycle({ db: ctx.db, provider, config, now: ctx.now, mail }, org);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: a.owner.email, organizationId: a.org.id, subject: "Your Aerowise design partner period ends in 4 days" });
    const rows = await ctx.db.selectFrom("planReminders").select(["organizationId", "endsOn", "daysBefore"]).orderBy("daysBefore").execute();
    expect(rows).toEqual([
      { organizationId: a.org.id, endsOn: "2026-03-05", daysBefore: 7 },
      { organizationId: a.org.id, endsOn: "2026-03-05", daysBefore: 14 },
    ]);
  });

  it("starts over for a new end date, mentions a saved payment method, and records nothing without email", async () => {
    const a = await createTenant(ctx, "Org A");
    await setPlan(ctx, a.org.id, "trial", "2026-03-10");
    const provider = new TestBillingProvider();
    expect((await runPlanLifecycle({ db: ctx.db, provider, config, now: ctx.now }, a.org.id)).reminded).toEqual([]);
    expect(await ctx.db.selectFrom("planReminders").select("id").execute()).toHaveLength(0);

    const { sent, mail } = recorder();
    expect((await runPlanLifecycle({ db: ctx.db, provider, config, now: ctx.now, mail }, a.org.id)).reminded).toEqual([14]);
    // The trial is extended: the new end date gets its own reminders.
    await setPlan(ctx, a.org.id, "trial", "2026-03-08");
    const org = await ctx.db.selectFrom("organizations").select(["id", "name"]).where("id", "=", a.org.id).executeTakeFirstOrThrow();
    const { customerId } = await provider.createCustomer({ organizationId: org.id, name: org.name });
    await ctx.db.updateTable("organizations").set({ billingCustomerId: customerId }).where("id", "=", a.org.id).execute();
    await provider.managePaymentMethod({ customerId, returnUrl: "https://app.example.com/settings/subscription" });
    expect((await runPlanLifecycle({ db: ctx.db, provider, config, now: ctx.now, mail }, a.org.id)).reminded).toEqual([14, 7]);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain("Your saved payment method will be charged each month from then on.");
  });
});

describe("plan lifecycle", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  /** An app and worker sharing one Stripe Billing stand-in, as the API and worker share Stripe. */
  async function world() {
    const provider = new TestBillingProvider();
    const app = await buildApp({ db: ctx.db, loginRateLimit: 1000, now: () => ctx.now, store: ctx.store, billing: provider });
    apps.push(app);
    const { sent, mail } = recorder();
    const work = async () => {
      await scheduleBillingRuns(ctx.db, ctx.now, 3_600_000);
      await drainTasks({ db: ctx.db, store: ctx.store, now: () => ctx.now, billing: { provider, config }, mail: mail.transport, appUrl: mail.appUrl });
    };
    const deliver = (e: { body: string; signature: string }) =>
      app.inject({ method: "POST", url: "/webhooks/stripe-billing", payload: e.body, headers: { "content-type": "application/json", "stripe-signature": e.signature } });
    return { provider, app, sent, work, deliver };
  }

  it("goes trial → active → past due → read-only → active, charging the right amount, and read-only still sees due work", async () => {
    const w = await world();
    const a = await setup(ctx, "Org A");
    const owner = client(w.app, a.cookie);
    await setPlan(ctx, a.org.id, "trial", "2026-03-20", { price: 2500, minimum: 0 });

    // 1 March, on the trial: the month is counted but free.
    await w.work();
    expect((await owner.post("/subscription/payment-method", {})).statusCode).toBe(200);

    // The trial ends with a card saved: active, without charging the rest of March.
    at(ctx, "2026-03-21");
    await w.work();
    expect(await planOf(ctx, a.org.id)).toEqual({ subscriptionState: "active", subscriptionStartsOn: "2026-03-21", subscriptionEndsOn: null });
    expect(w.provider.invoices).toHaveLength(0);

    // 1 April: the first paid month, at the founder price for the contracts in force.
    at(ctx, "2026-04-01");
    await w.work();
    const contracts = await countActiveContracts(ctx.db, a.org.id, "2026-04-01");
    expect(contracts).toBeGreaterThan(0);
    expect(w.provider.invoices).toHaveLength(1);
    const invoice = w.provider.invoices[0]!;
    expect(invoice.totalCents).toBe(contracts * 2500);
    const april = await ctx.db.selectFrom("billingPeriods").selectAll().where("startsOn", "=", "2026-04-01").executeTakeFirstOrThrow();
    expect(april).toMatchObject({ subscriptionState: "active", activeContracts: contracts, amountCents: contracts * 2500, status: "open" });

    // The card is declined: past due for the grace period, still working.
    expect((await w.deliver(w.provider.signedEvent("invoice.payment_failed", { id: invoice.invoiceId, object: "invoice" }))).statusCode).toBe(200);
    expect(await planOf(ctx, a.org.id)).toMatchObject({ subscriptionState: "past_due", subscriptionEndsOn: "2026-04-15" });
    expect((await owner.post("/customers", { displayName: "Still working" })).statusCode).toBe(201);
    at(ctx, "2026-04-15");
    await w.work();
    expect((await planOf(ctx, a.org.id)).subscriptionState).toBe("past_due");

    // Grace is over: read-only. Due inspections, records and filings are still there to see.
    at(ctx, "2026-04-16");
    await w.work();
    expect(await planOf(ctx, a.org.id)).toEqual({ subscriptionState: "read_only", subscriptionStartsOn: "2026-04-16", subscriptionEndsOn: null });
    const due = await owner.get("/obligations/due");
    expect(due.statusCode).toBe(200);
    expect(due.json().total).toBeGreaterThan(0);
    for (const url of ["/filings", "/inbox", `/contracts/${a.contract.id}`, "/invoices", "/subscription"]) expect((await owner.get(url)).statusCode, url).toBe(200);
    expect((await a.techApi.get("/route")).statusCode).toBe(200);
    expect((await owner.post("/customers", { displayName: "Refused" })).statusCode).toBe(403);

    // Stripe's retry goes through: active again, and writes work.
    expect((await w.deliver(w.provider.signedEvent("invoice.paid", { id: invoice.invoiceId, object: "invoice" }))).statusCode).toBe(200);
    expect(await planOf(ctx, a.org.id)).toEqual({ subscriptionState: "active", subscriptionStartsOn: "2026-04-16", subscriptionEndsOn: null });
    expect((await owner.post("/customers", { displayName: "Back in business" })).statusCode).toBe(201);

    // May is charged at the same price for the same count.
    at(ctx, "2026-05-01");
    await w.work();
    expect(w.provider.invoices).toHaveLength(2);
    expect(w.provider.invoices[1]!.totalCents).toBe((await countActiveContracts(ctx.db, a.org.id, "2026-05-01")) * 2500);

    // Every change Aerowise made on its own is in the platform audit log, with its reason.
    const changes = await ctx.db
      .selectFrom("platformAuditEvents")
      .select(["adminId", "action", "changes"])
      .where("organizationId", "=", a.org.id)
      .orderBy("occurredAt")
      .execute();
    expect(changes.map((c) => [c.adminId, c.action, (c.changes as { before: { state: string } }).before.state, (c.changes as { after: { state: string } }).after.state])).toEqual([
      [null, "organization.plan_changed", "trial", "active"],
      [null, "organization.plan_changed", "active", "past_due"],
      [null, "organization.plan_changed", "past_due", "read_only"],
      [null, "organization.plan_changed", "read_only", "active"],
    ]);
  });

  it("makes a trial that ends without a payment method read-only, and adding one reactivates it", async () => {
    const w = await world();
    const a = await createTenant(ctx, "Org A");
    const owner = client(w.app, a.cookie);
    await setPlan(ctx, a.org.id, "trial", "2026-03-20");
    at(ctx, "2026-03-21");
    await w.work();
    expect((await planOf(ctx, a.org.id)).subscriptionState).toBe("read_only");
    expect((await w.app.inject({ method: "GET", url: "/auth/me", headers: { cookie: a.cookie } })).json().organization.subscription.readOnly).toBe(true);

    // Nothing has changed yet: checking again keeps it read-only.
    expect((await owner.post("/subscription/refresh", {})).json()).toEqual({ state: "read_only", changed: false });
    // The owner saves a card and comes back from Stripe.
    expect((await owner.post("/subscription/payment-method", {})).statusCode).toBe(200);
    expect((await owner.post("/subscription/refresh", {})).json()).toEqual({ state: "active", changed: true });
    expect((await owner.post("/customers", { displayName: "Back" })).statusCode).toBe(201);
    const audit = await ctx.db.selectFrom("auditEvents").select(["action", "changes"]).where("action", "=", "subscription.plan_changed").execute();
    expect(audit).toEqual([{ action: "subscription.plan_changed", changes: { from: "read_only", to: "active" } }]);
  });

  it("charges a failed invoice again when a lapsed company saves a new card, and stays read-only on a decline", async () => {
    const w = await world();
    const a = await createTenant(ctx, "Org A");
    const owner = client(w.app, a.cookie);
    await setPlan(ctx, a.org.id, "active", null);
    await w.work();
    const invoice = w.provider.invoices[0]!;
    await w.deliver(w.provider.signedEvent("invoice.payment_failed", { id: invoice.invoiceId, object: "invoice" }));
    at(ctx, "2026-03-16");
    await w.work();
    expect((await planOf(ctx, a.org.id)).subscriptionState).toBe("read_only");

    // The new card is declined too.
    w.provider.declineRetries = true;
    await owner.post("/subscription/payment-method", {});
    expect((await owner.post("/subscription/refresh", {})).json()).toEqual({ state: "read_only", changed: false });
    // The hourly run does not keep charging the card; only the owner's return from Stripe does.
    await w.work();
    expect(w.provider.retried).toEqual([invoice.invoiceId]);

    w.provider.declineRetries = false;
    expect((await owner.post("/subscription/refresh", {})).json()).toEqual({ state: "active", changed: true });
    const march = await ctx.db.selectFrom("billingPeriods").select("status").where("organizationId", "=", a.org.id).executeTakeFirstOrThrow();
    expect(march.status).toBe("paid");
  });

  it("leaves free periods alone when no billing provider is configured", async () => {
    const a = await createTenant(ctx, "Org A");
    await setPlan(ctx, a.org.id, "trial", "2026-03-01");
    at(ctx, "2026-03-05");
    expect(await runPlanLifecycle({ db: ctx.db, provider: null, config, now: ctx.now }, a.org.id)).toEqual({ state: "trial", changedFrom: null, reminded: [] });
    expect((await planOf(ctx, a.org.id)).subscriptionState).toBe("trial");
  });

  it("lets only the owner check the plan again", async () => {
    const a = await createTenant(ctx, "Org A");
    const office = await createUser(ctx.db, a.org.id, "office");
    expect((await client(ctx.app, await login(ctx.app, office.email)).post("/subscription/refresh", {})).statusCode).toBe(403);
    expect((await a.api.post("/subscription/refresh", {})).json()).toEqual({ state: "active", changed: false });
  });
});
