import { createDb, hashPassword, type Database } from "@aerowise/db";
import type { Role } from "@aerowise/domain";
import { sql } from "kysely";
import { afterAll, beforeEach } from "vitest";
import { buildApp, type App } from "../src/app.ts";
import { testDatabaseUrl } from "./db-url.ts";

export const PASSWORD = "correct horse battery staple";
let passwordHash: string | undefined;

export interface TestContext {
  db: Database;
  app: App;
  /** Pinned clock: tests set `ctx.now` to control "today". */
  now: Date;
}

/** One app + db per test file; every table is emptied before each test. */
export function setupTestApp(): TestContext {
  const ctx = {} as TestContext;
  ctx.db = createDb(testDatabaseUrl());
  ctx.now = new Date("2026-03-01T18:00:00Z");
  beforeEach(async () => {
    ctx.app ??= await buildApp({ db: ctx.db, loginRateLimit: 1000, now: () => ctx.now });
    ctx.now = new Date("2026-03-01T18:00:00Z");
    // audit_events rejects DELETE via trigger, but TRUNCATE is not a row-level change.
    await sql`truncate audit_events, jobs, service_obligations, contracts, plans, sessions, wastewater_systems, contacts, sites, customers, memberships, users, organizations restart identity cascade`.execute(
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
  };
}
