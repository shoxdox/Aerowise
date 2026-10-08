import { checkConfig, ConfigError, configProblems, createPlatformAdmin } from "@aerowise/db";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { createOrg, createUser, PASSWORD, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();

/** A production staging deployment with only what is always required. */
const staging = {
  NODE_ENV: "production",
  DEPLOY_ENV: "staging",
  DATABASE_URL: "postgres://x",
  FILE_SIGNING_SECRET: "k".repeat(43),
  PUBLIC_APP_URL: "https://aerowise-web-staging.onrender.com",
};
const r2 = { R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "c", R2_SECRET_ACCESS_KEY: "d" };
const resend = { RESEND_API_KEY: "re_x", RESEND_WEBHOOK_SECRET: "whsec_x", FILING_EMAIL_FROM: "f@x.com", INVOICE_EMAIL_FROM: "i@x.com", ACCOUNT_EMAIL_FROM: "a@x.com" };
const production = { ...staging, DEPLOY_ENV: "production", ...r2, ...resend };

describe("boot-time configuration check", () => {
  it("requires nothing outside production, where test providers stand in", () => {
    expect(configProblems({})).toEqual([]);
    expect(configProblems({ NODE_ENV: "development", R2_BUCKET: "half" })).toEqual([]);
    expect(() => checkConfig({ NODE_ENV: "test" })).not.toThrow();
  });

  it("accepts a complete staging and a complete production configuration", () => {
    expect(configProblems(staging)).toEqual([]);
    expect(configProblems({ ...staging, ...r2, ...resend, EMAIL_REDIRECT_TO: "inbox@test.example" })).toEqual([]);
    expect(configProblems(production)).toEqual([]);
  });

  it.each([
    ["DATABASE_URL", "DATABASE_URL is required in production"],
    ["FILE_SIGNING_SECRET", "FILE_SIGNING_SECRET is required in production"],
    ["PUBLIC_APP_URL", "PUBLIC_APP_URL is required in production"],
    ["DEPLOY_ENV", 'DEPLOY_ENV must be "staging" or "production" when NODE_ENV=production'],
    ["RESEND_API_KEY", "RESEND_API_KEY is required in production (otherwise email is only written to the outbox)"],
    ["RESEND_WEBHOOK_SECRET", "RESEND_WEBHOOK_SECRET is required when Resend is configured"],
    ["ACCOUNT_EMAIL_FROM", "ACCOUNT_EMAIL_FROM is required when Resend is configured"],
    ["R2_BUCKET", "R2_BUCKET is required together for Cloudflare R2"],
  ])("refuses production without %s and names it", (key, message) => {
    const env: Record<string, string | undefined> = { ...production, [key]: undefined };
    expect(configProblems(env)).toEqual([message]);
    expect(() => checkConfig(env)).toThrow(message);
  });

  it("refuses a feature name it does not know, so a typo never leaves a feature silently off", () => {
    expect(configProblems({ ...staging, AEROWISE_FEATURES: "work_orders" })).toEqual([]);
    expect(configProblems({ ...staging, AEROWISE_FEATURES: "workorders" })).toEqual(['AEROWISE_FEATURES: unknown feature "workorders"; it may list work_orders, service_items, field_work']);
  });

  it("names every problem at once", () => {
    let error: unknown;
    try {
      checkConfig({ NODE_ENV: "production", DEPLOY_ENV: "production" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([
      "DATABASE_URL, FILE_SIGNING_SECRET, PUBLIC_APP_URL are required in production",
      "RESEND_API_KEY is required in production (otherwise email is only written to the outbox)",
      "R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are required in production (otherwise files stay on the server's disk)",
    ]);
    expect((error as Error).message).toMatch(/^Refusing to start/);
  });

  it("refuses weak or development secrets and plain-HTTP app addresses", () => {
    expect(configProblems({ ...staging, FILE_SIGNING_SECRET: "short" })).toEqual(["FILE_SIGNING_SECRET must be a long random value (at least 32 characters)"]);
    expect(configProblems({ ...staging, FILE_SIGNING_SECRET: "aerowise-development-only-signing-secret" })).toHaveLength(1);
    expect(configProblems({ ...staging, PUBLIC_APP_URL: "http://example.com" })).toEqual(["PUBLIC_APP_URL must start with https:// in production"]);
  });

  it("refuses half-configured providers", () => {
    expect(configProblems({ ...staging, QUICKBOOKS_CLIENT_ID: "id", QUICKBOOKS_CLIENT_SECRET: "s" })).toEqual(["QUICKBOOKS_TOKEN_KEY is required when QuickBooks is configured"]);
    expect(configProblems({ ...staging, QUICKBOOKS_CLIENT_ID: "id", QUICKBOOKS_CLIENT_SECRET: "s", QUICKBOOKS_TOKEN_KEY: "aerowise-development-only-quickbooks-key" })).toEqual([
      "QUICKBOOKS_TOKEN_KEY must not be the development key",
    ]);
    expect(configProblems({ ...staging, STRIPE_SECRET_KEY: "sk_test_x" })).toEqual(["STRIPE_WEBHOOK_SECRET is required when Stripe is configured"]);
    expect(configProblems({ ...staging, STRIPE_BILLING_SECRET_KEY: "sk_live_x" })).toEqual(["STRIPE_BILLING_WEBHOOK_SECRET is required when Stripe Billing is configured"]);
    expect(configProblems({ ...staging, TWILIO_ACCOUNT_SID: "AC1", SMS_REDIRECT_TO: "+15125550199" })).toEqual(["TWILIO_AUTH_TOKEN is required together"]);
  });

  it("keeps staging's Stripe in test mode, QuickBooks in the sandbox and texts on one test phone, and the demo's live services off production", () => {
    expect(configProblems({ ...staging, STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })).toEqual([]);
    expect(configProblems({ ...staging, STRIPE_SECRET_KEY: "rk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })).toEqual([]);
    expect(configProblems({ ...staging, STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })).toEqual([
      "STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_) on staging",
    ]);
    const qbo = { QUICKBOOKS_CLIENT_ID: "id", QUICKBOOKS_CLIENT_SECRET: "s", QUICKBOOKS_TOKEN_KEY: "k".repeat(64) };
    expect(configProblems({ ...staging, ...qbo, QUICKBOOKS_ENVIRONMENT: "sandbox" })).toEqual([]);
    expect(configProblems({ ...staging, ...qbo, QUICKBOOKS_ENVIRONMENT: "production" })).toEqual(['QUICKBOOKS_ENVIRONMENT must be "sandbox" on staging']);
    const twilio = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" };
    expect(configProblems({ ...staging, ...twilio })).toEqual(["SMS_REDIRECT_TO is required on staging when Twilio is configured, so test texts never reach a real customer"]);
    expect(configProblems({ ...staging, ...twilio, SMS_REDIRECT_TO: "+15125550199" })).toEqual([]);
    // The demo ignores Twilio's keys unless DEMO_LIVE_SERVICES lists sms, which needs the redirect itself.
    expect(configProblems({ ...staging, ...twilio, DEMO_MODE: "true" })).toEqual([]);
    expect(configProblems({ ...production, SMS_REDIRECT_TO: "+15125550199" })).toEqual(["SMS_REDIRECT_TO must be empty in production: it would send every customer's texts to one phone"]);
    expect(configProblems({ ...production, DEMO_LIVE_SERVICES: "stripe" })).toEqual(["DEMO_LIVE_SERVICES is for the staging demo only; leave it empty in production"]);
  });

  it("keeps staging email in a test inbox, and production email out of one", () => {
    expect(configProblems({ ...staging, ...resend })).toEqual([
      "EMAIL_REDIRECT_TO is required on staging when Resend is configured, so test email never reaches a real authority or customer",
    ]);
    expect(configProblems({ ...production, EMAIL_REDIRECT_TO: "inbox@test.example" })).toEqual([
      "EMAIL_REDIRECT_TO must be empty in production: it would send every customer's and authority's email to one inbox",
    ]);
  });
});

describe("security headers and cookies", () => {
  it("marks every API response not to be sniffed, framed or referred, and adds HSTS in production", async () => {
    const dev = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(dev.headers).toMatchObject({ "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin" });
    expect(dev.headers["strict-transport-security"]).toBeUndefined();
    // Errors carry them too.
    expect((await ctx.app.inject({ method: "GET", url: "/customers" })).headers["x-frame-options"]).toBe("DENY");

    const prod = await buildApp({ db: ctx.db, production: true, fileSigningSecret: "s".repeat(40) });
    expect((await prod.inject({ method: "GET", url: "/health" })).headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
    await prod.close();
  });

  it("sets session cookies HttpOnly, SameSite=Lax and, in production, Secure (tenant and platform admin sign-in)", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const user = await createUser(ctx.db, org.id, "owner");
    await createPlatformAdmin(ctx.db, { name: "Admin", email: "admin@example.com", password: PASSWORD });
    for (const production of [false, true]) {
      const app = await buildApp({ db: ctx.db, production, fileSigningSecret: "s".repeat(40) });
      const tenant = await app.inject({ method: "POST", url: "/auth/login", payload: { email: user.email, password: PASSWORD } });
      const admin = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "admin@example.com", password: PASSWORD } });
      for (const res of [tenant, admin]) {
        expect(res.statusCode).toBe(200);
        const cookie = res.cookies[0]!;
        expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
        expect(!!cookie.secure).toBe(production);
      }
      await app.close();
    }
  });
});

describe("rate limits", () => {
  it("limits sign-in per client and email, without locking out other accounts", async () => {
    const app = await buildApp({ db: ctx.db, loginRateLimit: 3 });
    const attempt = (email: string) => app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "guess" } });
    for (let i = 0; i < 3; i++) expect((await attempt("victim@example.com")).statusCode).toBe(401);
    expect((await attempt("VICTIM@example.com")).statusCode).toBe(429);
    expect((await attempt("someone-else@example.com")).statusCode).toBe(401);
    await app.close();
  });

  it("limits portal link requests per client and address, so one network cannot lock every customer out", async () => {
    const app = await buildApp({ db: ctx.db });
    const ask = (email: string) => app.inject({ method: "POST", url: "/portal/request", payload: { email } });
    for (let i = 0; i < 5; i++) expect((await ask("pat@example.test")).statusCode).toBe(202);
    expect((await ask("Pat@Example.test")).statusCode).toBe(429);
    expect((await ask("lee@example.test")).statusCode).toBe(202);
    await app.close();
  });

  it("ignores X-Forwarded-For unless the proxy in front is trusted", async () => {
    const attempt = (app: Awaited<ReturnType<typeof buildApp>>, ip: string) =>
      app.inject({ method: "POST", url: "/auth/login", payload: { email: "victim@example.com", password: "guess" }, headers: { "x-forwarded-for": ip } });
    // Not trusted: a client cannot dodge the limit by making up addresses.
    const direct = await buildApp({ db: ctx.db, loginRateLimit: 2 });
    expect((await attempt(direct, "203.0.113.1")).statusCode).toBe(401);
    expect((await attempt(direct, "203.0.113.2")).statusCode).toBe(401);
    expect((await attempt(direct, "203.0.113.3")).statusCode).toBe(429);
    // Trusted (the proxy sets it): each real client has its own limit.
    const proxied = await buildApp({ db: ctx.db, loginRateLimit: 2, trustProxy: true });
    for (let i = 0; i < 2; i++) expect((await attempt(proxied, "203.0.113.1")).statusCode).toBe(401);
    expect((await attempt(proxied, "203.0.113.1")).statusCode).toBe(429);
    expect((await attempt(proxied, "203.0.113.9")).statusCode).toBe(401);
    await Promise.all([direct.close(), proxied.close()]);
  });
});
