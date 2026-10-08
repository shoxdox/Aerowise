import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmailTransport } from "@aerowise/compliance";
import { createDb, createPlatformAdmin, hashPassword, type Database } from "@aerowise/db";
import type { Feature, Role } from "@aerowise/domain";
import { sql } from "kysely";
import { afterAll, beforeEach } from "vitest";
import { buildApp, type App } from "../src/app.ts";
import { LocalDiskStore, type ObjectStore } from "@aerowise/storage";
import { TestSmsProvider } from "@aerowise/sms";
import { testDatabaseUrl } from "./db-url.ts";

export const PASSWORD = "correct horse battery staple";
let passwordHash: string | undefined;

export interface TestContext {
  db: Database;
  app: App;
  /** Pinned clock: tests set `ctx.now` to control "today". */
  now: Date;
  /** Where uploads and reports go: a fresh temporary directory per test file. */
  store: ObjectStore;
  /** Texting: the built-in test provider, which keeps what it "sent". */
  sms: { provider: TestSmsProvider; webhookBaseUrl: string };
}

/** One app + db per test file; every table is emptied before each test. */
export function setupTestApp(opts: { mail?: EmailTransport; features?: Feature[] } = {}): TestContext {
  const ctx = {} as TestContext;
  ctx.db = createDb(testDatabaseUrl());
  ctx.now = new Date("2026-03-01T18:00:00Z");
  ctx.store = new LocalDiskStore(mkdtempSync(join(tmpdir(), "aerowise-files-")));
  ctx.sms = { provider: new TestSmsProvider(), webhookBaseUrl: "http://localhost:3000/api" };
  beforeEach(async () => {
    ctx.app ??= await buildApp({ db: ctx.db, loginRateLimit: 1000, now: () => ctx.now, store: ctx.store, sms: ctx.sms, mail: opts.mail, features: new Set(opts.features ?? []) });
    ctx.now = new Date("2026-03-01T18:00:00Z");
    // audit_events rejects DELETE via trigger, but TRUNCATE is not a row-level change.
    await sql`truncate estimate_links, estimate_events, estimate_versions, estimate_lines, estimates, work_attachments, work_sync_conflicts, work_records, job_assignments, work_order_notes, work_order_events, work_order_lines, work_orders, work_types, service_items, demo_access_links, demo_visits, authority_evidence_answers, authority_evidence, legal_acceptances, support_sessions, password_reset_tokens, demo_requests, plan_reminders, billing_events, billing_periods, system_monitoring, email_events, email_sends, lab_tests, invitations, platform_audit_events, platform_admin_sessions, platform_admins, report_signatures, customer_deliveries, submission_packages, contract_documents, site_authority_identifiers, site_authority_assignments, provider_credentials, sms_messages, sms_opt_outs, service_requests, portal_links, signed_documents, renewals, renewal_addons, quickbooks_links, quickbooks_connections, quickbooks_test_companies, stripe_events, invoice_events, checkout_sessions, refunds, payments, invoice_lines, invoices, import_rows, imports, audit_events, background_tasks, compliance_events, filing_attempts, filings, reports, issues, attachments, inspection_values, inspections, inspection_templates, jobs, service_obligations, contracts, plans, sessions, wastewater_systems, contacts, sites, customers, memberships, users, organizations restart identity cascade`.execute(

      ctx.db,
    );
  });
  afterAll(async () => {
    await ctx.app?.close();
    await ctx.db.destroy();
  });
  return ctx;
}

export async function createOrg(db: Database, name: string) {
  return db.insertInto("organizations").values({ name } as never).returning("id").executeTakeFirstOrThrow();
}

export async function createUser(
  db: Database,
  organizationId: string,
  role: Role,
  opts: { email?: string; active?: boolean; membershipActive?: boolean } = {},
) {
  passwordHash ??= await hashPassword(PASSWORD);
  const email = opts.email ?? `${role}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const user = await db
    .insertInto("users")
    .values({ name: `${role} user`, email, phone: null, passwordHash, active: opts.active ?? true })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("memberships")
    .values({ organizationId, userId: user.id, role, technicianLicense: null, active: opts.membershipActive ?? true })
    .execute();
  return { id: user.id, email };
}

/** Signs in and returns a Cookie header value for subsequent requests. */
export async function login(app: App, email: string, password = PASSWORD, organizationId?: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password, organizationId } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === "aw_session");
  if (!cookie) throw new Error("no session cookie");
  return `aw_session=${cookie.value}`;
}

/** An org with an owner session, a customer, a site, a contact tied to the site and a system. */
export async function createTenant(ctx: TestContext, name: string) {
  const org = await createOrg(ctx.db, name);
  const owner = await createUser(ctx.db, org.id, "owner");
  const cookie = await login(ctx.app, owner.email);
  const api = client(ctx.app, cookie);
  const customer = (await api.post("/customers", { displayName: `${name} customer` })).json();
  const site = (await api.post(`/customers/${customer.id}/sites`, { addressLine1: "1 Main St", city: "Austin" })).json();
  const contact = (await api.post(`/customers/${customer.id}/contacts`, { name: "Pat", siteId: site.id })).json();
  const system = (await api.post(`/sites/${site.id}/systems`, { manufacturer: "Acme" })).json();
  return { org, owner, cookie, api, customer, site, contact, system };
}

export function client(app: App, cookie?: string) {
  const headers = cookie ? { cookie } : {};
  return {
    get: (url: string) => app.inject({ method: "GET", url, headers }),
    post: (url: string, payload: object) => app.inject({ method: "POST", url, payload, headers }),
    patch: (url: string, payload: object) => app.inject({ method: "PATCH", url, payload, headers }),
    put: (url: string, payload: object) => app.inject({ method: "PUT", url, payload, headers }),
    putImage: (url: string, body: Buffer, extra: Record<string, string> = {}) =>
      app.inject({ method: "PUT", url, payload: body, headers: { ...headers, "content-type": "image/jpeg", ...extra } }),
  };
}

/** A platform admin for /admin, created the way the CLI does it. */
export async function createAdmin(c: TestContext, email = "founder@example.com") {
  return createPlatformAdmin(c.db, { name: "Founder", email, password: PASSWORD });
}

/** Signs a platform admin in and returns a Cookie header value. */
export async function adminLogin(c: TestContext, email = "founder@example.com", password = PASSWORD) {
  const res = await c.app.inject({ method: "POST", url: "/admin/auth/login", payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`admin login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((k) => k.name === "aw_admin_session");
  if (!cookie) throw new Error("no admin session cookie");
  return `aw_admin_session=${cookie.value}`;
}
