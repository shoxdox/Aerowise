import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StripeBillingProvider, TestBillingProvider } from "@aerowise/billing";
import { OutboxTransport, ProviderTransport, ResendEmailProvider } from "@aerowise/compliance";
import { createDb, migrate, reseedDemo, type Database } from "@aerowise/db";
import { sql } from "kysely";
import { StripeProvider, TestPaymentProvider } from "@aerowise/payments";
import { IntuitQuickBooksProvider, TestQuickBooksProvider } from "@aerowise/quickbooks";
import { CensusGeocoder, TestGeocoder } from "@aerowise/routing";
import { TestSmsProvider, TwilioSmsProvider } from "@aerowise/sms";
import { LocalDiskStore } from "@aerowise/storage";
import { demoLiveServicesFromEnv, demoModeFromEnv, providersFromEnv } from "@aerowise/tasks";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { testDatabaseUrl } from "./db-url.ts";
import { createOrg, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();
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
    expect(p.payments).toBeInstanceOf(StripeProvider);
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
    expect(p.quickbooks?.provider).toBeInstanceOf(IntuitQuickBooksProvider);
    expect((p.quickbooks?.provider as IntuitQuickBooksProvider).environment).toBe("sandbox");
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
    expect(both.payments).toBeInstanceOf(StripeProvider);
  });

  it("uses the real services when demo mode is off", () => {
    const p = providersFromEnv({ db: ctx.db, store, env: realKeys, production: true });
    expect(p.demo).toBe(false);
    expect(p.mail).toBeInstanceOf(ProviderTransport);
    expect(p.mailProvider).toBeInstanceOf(ResendEmailProvider);
    expect(p.payments).toBeInstanceOf(StripeProvider);
    expect(p.quickbooks?.provider).toBeInstanceOf(IntuitQuickBooksProvider);
    expect(p.sms?.provider).toBeInstanceOf(TwilioSmsProvider);
    expect(p.geocoder).toBeInstanceOf(CensusGeocoder);
    expect(p.billing).toBeInstanceOf(StripeBillingProvider);
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
    expect((await app.inject({ method: "GET", url: "/app-info" })).json()).toEqual({ demo: false });
    expect(await exampleRules(db)).toHaveLength(0);
    expect(app.hasRoute({ method: "POST", url: "/pay/:token/test-checkout" })).toBe(false);
    await app.close();
    await db.destroy();
  });

  it("says so, loads the fictional rules and offers test checkout, in production", async () => {
    const db = await fresh();
    const app = await buildApp({ db, production: true, demo: true, fileSigningSecret: "s" });
    expect((await app.inject({ method: "GET", url: "/app-info" })).json()).toEqual({ demo: true });
    expect(await exampleRules(db)).toHaveLength(1);
    expect(app.hasRoute({ method: "POST", url: "/pay/:token/test-checkout" })).toBe(true);
    await app.close();
    await db.destroy();
  });
});

describe("demo reseed", () => {
  it("empties everything but the rules and platform admins, removes files, and seeds again", async () => {
    const before = await ctx.db.selectFrom("jurisdictionRulesets").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow();
    await createOrg(ctx.db, "Someone's real-looking company");
    const admin = await ctx.db
      .insertInto("platformAdmins")
      .values({ name: "Kept Admin", email: "kept@example.com", passwordHash: "x" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const files = mkdtempSync(join(tmpdir(), "aerowise-reseed-"));
    mkdirSync(join(files, "some-org"));
    writeFileSync(join(files, "some-org", "photo.jpg"), "x");

    await reseedDemo(ctx.db, { filesDir: files });
    await reseedDemo(ctx.db, { filesDir: files }); // nightly, again and again

    const orgs = await ctx.db.selectFrom("organizations").select("name").execute();
    expect(orgs).toEqual([{ name: "Hill Country Aerobic Services (demo)" }]);
    const users = await ctx.db.selectFrom("users").select("email").orderBy("email").execute();
    expect(users.map((u) => u.email)).toEqual(["office@example.com", "owner@example.com", "tech@example.com"]);
    expect(await ctx.db.selectFrom("platformAdmins").select("id").where("id", "=", admin.id).execute()).toHaveLength(1);
    const after = await ctx.db.selectFrom("jurisdictionRulesets").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
    expect(readdirSync(files)).toEqual([]);
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
