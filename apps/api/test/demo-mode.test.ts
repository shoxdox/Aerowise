import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StripeBillingProvider, TestBillingProvider } from "@aerowise/billing";
import { OutboxTransport, ProviderTransport, ResendEmailProvider, signatureRequiredForInspection } from "@aerowise/compliance";
import { createDb, migrate, reseedDemo, type Database } from "@aerowise/db";
import { sql } from "kysely";
import { StripeProvider, TestPaymentProvider } from "@aerowise/payments";
import { IntuitQuickBooksProvider, TestQuickBooksProvider } from "@aerowise/quickbooks";
import { CensusGeocoder, TestGeocoder } from "@aerowise/routing";
import { RedirectingSmsProvider, TestSmsProvider, TwilioSmsProvider } from "@aerowise/sms";
import { LocalDiskStore } from "@aerowise/storage";
import { DemoGatedBilling, DemoGatedPayments, DemoGatedQuickBooks, DemoGatedSms, DemoGatedTransport, demoLiveServicesFromEnv, demoModeFromEnv, providersFromEnv } from "@aerowise/tasks";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { playDemoStory } from "../src/demo-story.ts";
import { testDatabaseUrl } from "./db-url.ts";
import { createOrg, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();

/** The real service behind a demo gate (or the provider itself when there is no gate). */
const live = (p: unknown) => (p && typeof p === "object" && "live" in p ? (p as { live: unknown }).live : p);
const store = new LocalDiskStore(mkdtempSync(join(tmpdir(), "aerowise-demo-")));

// Every real outside service configured, as on a host where someone pasted live keys.
const realKeys = {
  STRIPE_SECRET_KEY: "sk_live_not_a_real_key",
  STRIPE_WEBHOOK_SECRET: "whsec_not_real",
  STRIPE_BILLING_SECRET_KEY: "sk_live_not_a_real_billing_key",
  STRIPE_BILLING_WEBHOOK_SECRET: "whsec_billing_not_real",
  QUICKBOOKS_CLIENT_ID: "intuit-client",
  QUICKBOOKS_CLIENT_SECRET: "intuit-secret",
  QUICKBOOKS_ENVIRONMENT: "production",
  QUICKBOOKS_TOKEN_KEY: "0".repeat(64),
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: "twilio-token",
  GEOCODER: "census",
  RESEND_API_KEY: "re_not_a_real_key",
  EMAIL_REDIRECT_TO: "inbox@example.com",
  PUBLIC_APP_URL: "https://demo.example.com",
};

describe("demo mode providers", () => {
  it("uses every test stand-in in demo mode, even with real keys set in production", () => {
    for (const production of [true, false]) {
      const p = providersFromEnv({ db: ctx.db, store, env: { ...realKeys, DEMO_MODE: "true" }, production });
      expect(p.demo).toBe(true);
      expect(p.mail).toBeInstanceOf(OutboxTransport);
      expect(p.mailProvider).toBeNull();
      expect(p.payments).toBeInstanceOf(TestPaymentProvider);
      expect(p.quickbooks?.provider).toBeInstanceOf(TestQuickBooksProvider);
      expect(p.sms?.provider).toBeInstanceOf(TestSmsProvider);
      expect(p.sms?.webhookBaseUrl).toBe("https://demo.example.com/api");
      expect(p.geocoder).toBeInstanceOf(TestGeocoder);
      expect(p.billing).toBeInstanceOf(TestBillingProvider);
    }
  });

  it("uses real Stripe in demo mode only when DEMO_LIVE_SERVICES names it and the key is test mode", () => {
    const testKeys = { ...realKeys, STRIPE_SECRET_KEY: "sk_test_not_a_real_key", DEMO_MODE: "true" };
    const p = providersFromEnv({ db: ctx.db, store, env: { ...testKeys, DEMO_LIVE_SERVICES: " Stripe " }, production: true });
    expect(p.demoLive).toEqual(["stripe"]);
    expect(live(p.payments)).toBeInstanceOf(StripeProvider);
    // Everything else stays a stand-in.
    expect(p.mail).toBeInstanceOf(OutboxTransport);
    expect(p.quickbooks?.provider).toBeInstanceOf(TestQuickBooksProvider);
    expect(p.sms?.provider).toBeInstanceOf(TestSmsProvider);
    expect(p.billing).toBeInstanceOf(TestBillingProvider);
    // Not listed: the stand-in, whatever key is set.
    expect(providersFromEnv({ db: ctx.db, store, env: testKeys, production: true }).payments).toBeInstanceOf(TestPaymentProvider);
    // A live key, a missing key or an unknown service refuses to start.
    expect(() => providersFromEnv({ db: ctx.db, store, env: { ...realKeys, DEMO_MODE: "true", DEMO_LIVE_SERVICES: "stripe" }, production: true })).toThrow(/test-mode key/);
    expect(() => demoLiveServicesFromEnv({ DEMO_LIVE_SERVICES: "stripe" })).toThrow(/test-mode key/);
    expect(() => demoLiveServicesFromEnv({ DEMO_LIVE_SERVICES: "stripe,resend", STRIPE_SECRET_KEY: "sk_test_x" })).toThrow(/unknown service "resend"/);
    expect([...demoLiveServicesFromEnv({ DEMO_LIVE_SERVICES: "" })]).toEqual([]);
  });

  it("uses real QuickBooks in demo mode only when DEMO_LIVE_SERVICES names it and it points at Intuit's sandbox", () => {
    const sandbox = { ...realKeys, QUICKBOOKS_ENVIRONMENT: "sandbox", DEMO_MODE: "true" };
    const p = providersFromEnv({ db: ctx.db, store, env: { ...sandbox, DEMO_LIVE_SERVICES: "quickbooks" }, production: true });
    expect(p.demoLive).toEqual(["quickbooks"]);
    expect(live(p.quickbooks?.provider)).toBeInstanceOf(IntuitQuickBooksProvider);
    expect(p.quickbooks?.provider.environment).toBe("sandbox");
    expect(p.payments).toBeInstanceOf(TestPaymentProvider);
    expect(p.sms?.provider).toBeInstanceOf(TestSmsProvider);
    // Not listed: the stand-in.
    expect(providersFromEnv({ db: ctx.db, store, env: sandbox, production: true }).quickbooks?.provider).toBeInstanceOf(TestQuickBooksProvider);
    // A real company's books, or no Intuit app, refuses to start.
    expect(() => demoLiveServicesFromEnv({ ...realKeys, DEMO_LIVE_SERVICES: "quickbooks" })).toThrow(/QUICKBOOKS_ENVIRONMENT must be "sandbox"/);
    expect(() => demoLiveServicesFromEnv({ DEMO_LIVE_SERVICES: "quickbooks", QUICKBOOKS_ENVIRONMENT: "sandbox" })).toThrow(/QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET/);
    // Both together.
    const both = providersFromEnv({ db: ctx.db, store, env: { ...sandbox, STRIPE_SECRET_KEY: "sk_test_x", DEMO_LIVE_SERVICES: "stripe,quickbooks" }, production: true });
    expect(both.demoLive).toEqual(["stripe", "quickbooks"]);
    expect(live(both.payments)).toBeInstanceOf(StripeProvider);
  });

  it("uses real Twilio in demo mode only when DEMO_LIVE_SERVICES names it, and only to the one test phone", () => {
    const env = { ...realKeys, DEMO_MODE: "true", SMS_REDIRECT_TO: "+15125550199" };
    const p = providersFromEnv({ db: ctx.db, store, env: { ...env, DEMO_LIVE_SERVICES: "sms" }, production: true });
    expect(p.demoLive).toEqual(["sms"]);
    expect(live(p.sms?.provider)).toBeInstanceOf(RedirectingSmsProvider);
    expect((live(p.sms?.provider) as RedirectingSmsProvider).redirectTo).toBe("+15125550199");
    expect(p.sms?.webhookBaseUrl).toBe("https://demo.example.com/api");
    expect(providersFromEnv({ db: ctx.db, store, env, production: true }).sms?.provider).toBeInstanceOf(TestSmsProvider);
    expect(() => demoLiveServicesFromEnv({ ...realKeys, DEMO_LIVE_SERVICES: "sms" })).toThrow(/SMS_REDIRECT_TO must be one test phone/);
    expect(() => demoLiveServicesFromEnv({ DEMO_LIVE_SERVICES: "sms", SMS_REDIRECT_TO: "+15125550199" })).toThrow(/TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN/);
  });

  it("uses the real services when demo mode is off", () => {
    const p = providersFromEnv({ db: ctx.db, store, env: realKeys, production: true });
    expect(p.demo).toBe(false);
    expect(live(p.mail)).toBeInstanceOf(ProviderTransport);
    expect(p.mailProvider).toBeInstanceOf(ResendEmailProvider);
    expect(live(p.payments)).toBeInstanceOf(StripeProvider);
    expect(live(p.quickbooks?.provider)).toBeInstanceOf(IntuitQuickBooksProvider);
    expect(live(p.sms?.provider)).toBeInstanceOf(TwilioSmsProvider);
    expect(p.geocoder).toBeInstanceOf(CensusGeocoder);
    expect(live(p.billing)).toBeInstanceOf(StripeBillingProvider);
    // Each real one sits behind a gate that keeps demo companies on its stand-in.
    expect(p.mail).toBeInstanceOf(DemoGatedTransport);
    expect(p.payments).toBeInstanceOf(DemoGatedPayments);
    expect(p.quickbooks?.provider).toBeInstanceOf(DemoGatedQuickBooks);
    expect(p.sms?.provider).toBeInstanceOf(DemoGatedSms);
    expect(p.billing).toBeInstanceOf(DemoGatedBilling);
  });

  it("turns unconfigured services off in production and uses stand-ins elsewhere", () => {
    const prod = providersFromEnv({ db: ctx.db, store, env: { DEMO_MODE: "false" }, production: true });
    expect([prod.payments, prod.quickbooks, prod.sms, prod.mailProvider, prod.billing]).toEqual([null, null, null, null, null]);
    expect(prod.mail).toBeInstanceOf(OutboxTransport);
    expect(prod.geocoder).toBeInstanceOf(CensusGeocoder);
    const dev = providersFromEnv({ db: ctx.db, store, env: {}, production: false });
    expect(dev.payments).toBeInstanceOf(TestPaymentProvider);
    expect(dev.quickbooks?.provider).toBeInstanceOf(TestQuickBooksProvider);
    expect(dev.sms?.provider).toBeInstanceOf(TestSmsProvider);
    expect(dev.geocoder).toBeInstanceOf(TestGeocoder);
    expect(dev.billing).toBeInstanceOf(TestBillingProvider);
  });

  it("accepts only true or false", () => {
    expect(demoModeFromEnv({})).toBe(false);
    expect(demoModeFromEnv({ DEMO_MODE: " TRUE " })).toBe(true);
    expect(() => demoModeFromEnv({ DEMO_MODE: "yes" })).toThrow(/DEMO_MODE must be true or false/);
  });
});

describe("the API in demo mode", () => {
  // A database of its own, so whether the fictional rules get loaded can be seen.
  const fresh = async () => {
    const url = new URL(testDatabaseUrl());
    url.pathname = "/aerowise_test_demo_mode";
    const admin = new URL(url);
    admin.pathname = "/postgres";
    const adminDb = createDb(admin.toString());
    await sql`drop database if exists aerowise_test_demo_mode with (force)`.execute(adminDb);
    await sql`create database aerowise_test_demo_mode`.execute(adminDb);
    await adminDb.destroy();
    await migrate(url.toString());
    return createDb(url.toString());
  };
  const exampleRules = (db: Database) => db.selectFrom("jurisdictions").select("key").where("key", "=", "tx-example-county").execute();

  it("is off by default, and production keeps the fictional rules and test checkout out", async () => {
    const db = await fresh();
    const app = await buildApp({ db, production: true, fileSigningSecret: "s" });
    expect((await app.inject({ method: "GET", url: "/app-info" })).json()).toEqual({ demo: false, demoCompany: false, demoVisitor: false, features: [] });
    expect(await exampleRules(db)).toHaveLength(0);
    expect(app.hasRoute({ method: "POST", url: "/pay/:token/test-checkout" })).toBe(false);
    await app.close();
    await db.destroy();
  });

  it("says so, loads the fictional rules and offers test checkout, in production", async () => {
    const db = await fresh();
    const app = await buildApp({ db, production: true, demo: true, fileSigningSecret: "s" });
    expect((await app.inject({ method: "GET", url: "/app-info" })).json()).toEqual({ demo: true, demoCompany: true, demoVisitor: false, features: [] });
    expect(await exampleRules(db)).toHaveLength(1);
    expect(app.hasRoute({ method: "POST", url: "/pay/:token/test-checkout" })).toBe(true);
    await app.close();
    await db.destroy();
  });
});

describe("demo reseed", () => {
  it("replaces the public demo company, keeps the rules, platform admins and other companies, and removes only its files", async () => {
    const before = await ctx.db.selectFrom("jurisdictionRulesets").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow();
    const real = await createOrg(ctx.db, "Someone's real-looking company");
    const admin = await ctx.db
      .insertInto("platformAdmins")
      .values({ name: "Kept Admin", email: "kept@example.com", passwordHash: "x" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const files = mkdtempSync(join(tmpdir(), "aerowise-reseed-"));
    await reseedDemo(ctx.db, { filesDir: files });
    const first = await ctx.db.selectFrom("organizations").select("id").where("demo", "=", true).executeTakeFirstOrThrow();
    mkdirSync(join(files, first.id));
    writeFileSync(join(files, first.id, "photo.jpg"), "x");
    mkdirSync(join(files, real.id));
    writeFileSync(join(files, real.id, "photo.jpg"), "x");

    await reseedDemo(ctx.db, { filesDir: files }); // nightly, again and again

    const orgs = await ctx.db.selectFrom("organizations").select(["id", "name", "demo"]).where("demoExpiresAt", "is", null).orderBy("name").execute();
    expect(orgs.map(({ name, demo }) => ({ name, demo }))).toEqual([
      // A demo company: it only ever reaches the stand-ins, and holds made-up contact details.
      { name: "Hill Country Aerobic Services (demo)", demo: true },
      { name: "Someone's real-looking company", demo: false },
    ]);
    expect(orgs[0]!.id).not.toBe(first.id);
    // Earlier shared companies stay only as ended, emptied tombstones.
    const tombstones = await ctx.db.selectFrom("organizations").select("id").where("demoExpiresAt", "is not", null).execute();
    expect(tombstones.map((t) => t.id)).toContain(first.id);
    expect(await ctx.db.selectFrom("customers").select("id").where("organizationId", "in", tombstones.map((t) => t.id)).execute()).toEqual([]);
    const users = await ctx.db.selectFrom("users").select("email").orderBy("email").execute();
    expect(users.map((u) => u.email)).toEqual(["office@example.com", "owner@example.com", "tech@example.com"]);
    expect(await ctx.db.selectFrom("platformAdmins").select("id").where("id", "=", admin.id).execute()).toHaveLength(1);
    const after = await ctx.db.selectFrom("jurisdictionRulesets").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
    expect(readdirSync(files)).toEqual([real.id]);
  });

  it("plays the five-minute story once on top of the seed, through the stand-ins", async () => {
    const files = mkdtempSync(join(tmpdir(), "aerowise-story-"));
    await reseedDemo(ctx.db, { filesDir: files });
    const store = new LocalDiskStore(files);
    // Another company on the same server, with work queued for the real worker.
    const other = await createOrg(ctx.db, "Real company on the demo server");
    const queued = await ctx.db
      .insertInto("backgroundTasks")
      .values({ organizationId: other.id, kind: "email.send", payload: "{}", dedupeKey: null, runAt: new Date(0), lockedAt: null, lockedBy: null, lastError: null, completedAt: null, failedAt: null })
      .returning("id")
      .executeTakeFirstOrThrow();
    expect(await playDemoStory({ db: ctx.db, store })).toBe(true);
    // The story ran only the demo company's tasks.
    const untouched = await ctx.db.selectFrom("backgroundTasks").select(["attempts", "completedAt", "lockedBy"]).where("id", "=", queued.id).executeTakeFirstOrThrow();
    expect(untouched).toEqual({ attempts: 0, completedAt: null, lockedBy: null });
    expect(await playDemoStory({ db: ctx.db, store })).toBe(false); // already played

    const filings = await ctx.db.selectFrom("filings").select(["organizationId", "inspectionId", "status", "confirmationReference"]).where("inspectionId", "is not", null).execute();
    expect(filings.map((f) => f.status).sort()).toEqual(["confirmed", "sent"]);
    // The fictional county's rules don't hold a filing for the MP's signature (the page says so).
    for (const f of filings) expect(await signatureRequiredForInspection(ctx.db, f.organizationId, f.inspectionId!)).toBe(false);
    expect(filings.find((f) => f.status === "confirmed")?.confirmationReference).toBe("EC-DEMO-0042");
    const counties = await ctx.db.selectFrom("sites").select("county").distinct().execute();
    expect(counties).toEqual([{ county: "Example County" }]);
    const renewals = await ctx.db.selectFrom("renewals").select("status").execute();
    expect(renewals.map((r) => r.status)).toContain("sent");
    const payments = await ctx.db.selectFrom("payments").select("status").execute();
    expect(payments.map((p) => p.status)).toContain("succeeded");
    // Everything went to the stand-ins: the outbox, never a real provider.
    const org = await ctx.db.selectFrom("organizations").select(["stripeAccountId"]).where("demo", "=", true).where("demoExpiresAt", "is", null).executeTakeFirstOrThrow();
    expect(org.stripeAccountId).toMatch(/^acct_test_/);
    // Work orders are switched off by default, so the story leaves them out.
    expect(await ctx.db.selectFrom("workOrders").select("id").execute()).toEqual([]);
  });

  it("adds the work order story when work orders are switched on, and the nightly reset clears it", async () => {
    const files = mkdtempSync(join(tmpdir(), "aerowise-story-"));
    await reseedDemo(ctx.db, { filesDir: files });
    const store = new LocalDiskStore(files);
    expect(await playDemoStory({ db: ctx.db, store, features: new Set(["work_orders"]) })).toBe(true);
    const orders = await ctx.db
      .selectFrom("workOrders as w")
      .select(["w.organizationId", "w.category", "w.status", "w.sourceKind", "w.completedWithoutRecordReason"])
      .orderBy("w.number")
      .execute();
    expect(orders.map((w) => [w.category, w.status, w.sourceKind])).toEqual([
      ["pumping", "completed", "inspection_issue"],
      ["repair", "scheduled", "inspection_issue"],
      ["other", "open", "portal_request"],
    ]);
    expect(orders[0]!.completedWithoutRecordReason).toMatch(/^Fictional:/);
    const organizationId = orders[0]!.organizationId;
    // The pump-out's visit is billed; the inspections' filings are the story's two, nothing more.
    const billed = await ctx.db
      .selectFrom("invoiceLines as l")
      .innerJoin("jobs as j", "j.id", "l.jobId")
      .select(["j.type"])
      .where("l.organizationId", "=", organizationId)
      .execute();
    expect(billed).toEqual([{ type: "work" }]);
    expect((await ctx.db.selectFrom("filings").select("id").where("organizationId", "=", organizationId).where("inspectionId", "is not", null).execute()).length).toBe(2);

    await reseedDemo(ctx.db, { filesDir: files });
    for (const table of ["workOrders", "workOrderEvents", "workOrderLines", "workOrderNotes"] as const) {
      expect(await ctx.db.selectFrom(table).select("id").where("organizationId", "=", organizationId).execute()).toEqual([]);
    }
  });

  it("refuses to seed or reseed a production database outside demo mode", async () => {
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const cli = fileURLToPath(new URL("../../../packages/db/src/cli.ts", import.meta.url));
    for (const command of ["seed", "reseed-demo"]) {
      const run = promisify(execFile)(tsx, [cli, command], { env: { ...process.env, DATABASE_URL: testDatabaseUrl(), NODE_ENV: "production", DEMO_MODE: "" } });
      await expect(run).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(`refusing to ${command}`) });
    }
  });
});
