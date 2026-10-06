import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { drainTasks } from "@aerowise/tasks";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminLogin, client, createAdmin, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, payload, setup, signAsProvider, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

const ctx = setupTestApp();

const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now });

/** Every stored file of one organization, by key. */
async function filesOf(organizationId: string) {
  const root = (ctx.store as unknown as { root: string }).root;
  const entries = await readdir(join(root, organizationId), { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
}

async function complete(s: Setup) {
  await s.techApi.put("/inspections/sync", payload(s));
  await uploadRequiredPhotos(s, payload(s).clientId);
  const res = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: completeValues() }));
  expect(res.json().status, res.body).toBe("completed");
  return res.json() as { id: string };
}

/** Rows per tenant table for one organization, for every table that has an organization_id. */
async function rowsByTable(c: TestContext, organizationId: string) {
  const tables = (
    await sql<{ name: string }>`
      select c.table_name as name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = current_schema() and c.column_name = 'organization_id'
        and c.table_name not in ('organizations', 'platform_audit_events')
      order by 1`.execute(c.db)
  ).rows.map((r) => r.name);
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(t)} where organization_id = ${organizationId}`.execute(c.db);
    counts[t] = rows[0]!.n;
  }
  return counts;
}

describe("deleting an organization's data", () => {
  it("removes every record and file of the organization, leaves another untouched, and keeps the audit record", async () => {
    // One organization with a completed, signed inspection, its reports and an export, so
    // append-only and immutable tables hold rows too; and another just like it.
    const a = await setup(ctx, "Hill Country Aerobic");
    const b = await setup(ctx, "Org B");
    for (const s of [a, b]) {
      const insp = await complete(s);
      await runWorker(ctx);
      await signAsProvider(s, insp.id);
      expect((await s.api.post("/exports", {})).statusCode).toBe(201);
      await runWorker(ctx);
    }
    const demo = { id: a.org.id, name: "Hill Country Aerobic" };
    const demoUsers = (await ctx.db.selectFrom("memberships").select("userId").where("organizationId", "=", demo.id).execute()).map((m) => m.userId);
    const other = b;
    // Someone who works for both keeps their account for the other.
    await ctx.db.insertInto("memberships").values({ organizationId: other.org.id, userId: a.tech.id, role: "technician" }).execute();
    const otherFiles = await filesOf(other.org.id);
    expect(otherFiles.length).toBeGreaterThan(0);

    const before = await rowsByTable(ctx, demo.id);
    const filled = Object.entries(before).filter(([, n]) => n > 0).map(([t]) => t);
    expect(filled.length).toBeGreaterThanOrEqual(15);
    expect(filled).toEqual(expect.arrayContaining(["audit_events", "reports", "report_signatures", "provider_credentials", "inspections", "data_exports", "sessions"]));
    expect((await filesOf(demo.id)).length).toBeGreaterThan(0);
    const otherBefore = await rowsByTable(ctx, other.org.id);

    await createAdmin(ctx);
    const admin = client(ctx.app, await adminLogin(ctx));

    // The name must be typed exactly; nothing is deleted otherwise.
    const wrong = await admin.post(`/admin/organizations/${demo.id}/erase`, { confirmName: "Hill Country" });
    expect(wrong.statusCode).toBe(422);
    expect((await admin.post(`/admin/organizations/${demo.id}/erase`, { confirmName: "Org B" })).statusCode).toBe(422);
    expect(await rowsByTable(ctx, demo.id)).toEqual(before);

    const res = await admin.post(`/admin/organizations/${demo.id}/erase`, { confirmName: demo.name });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.organization).toMatchObject({ id: demo.id, name: demo.name, plan: { state: "read_only" } });
    expect(body.organization.dataDeletedAt).not.toBeNull();
    expect(body.files).toBeGreaterThan(0);
    expect(body.tables.customers).toBe(before.customers);

    const after = await rowsByTable(ctx, demo.id);
    expect(Object.entries(after).filter(([, n]) => n > 0)).toEqual([]);
    expect(await rowsByTable(ctx, other.org.id)).toEqual(otherBefore);
    expect(await filesOf(demo.id)).toEqual([]);
    expect(await filesOf(other.org.id)).toEqual(otherFiles);

    // The organization row stays as an empty tombstone; its people are gone unless they work elsewhere.
    const org = await ctx.db.selectFrom("organizations").selectAll().where("id", "=", demo.id).executeTakeFirstOrThrow();
    expect(org).toMatchObject({ email: null, phone: null, addressLine1: null, logoStorageKey: null, serviceCounties: [], stripeAccountId: null, smsFromNumber: null, subscriptionState: "read_only" });
    const remaining = await ctx.db.selectFrom("users").select("id").where("id", "in", demoUsers).execute();
    expect(remaining.map((u) => u.id)).toEqual([a.tech.id]);
    expect(body.users.deleted + body.users.anonymized).toBe(demoUsers.length - 1);

    // The audit record lives outside the deleted data and says what went.
    const audit = await ctx.db.selectFrom("platformAuditEvents").select(["action", "changes"]).where("organizationId", "=", demo.id).orderBy("occurredAt").execute();
    expect(audit.map((a) => a.action)).toEqual(["organization.data_deleted", "organization.files_deleted"]);
    expect(audit[0]!.changes).toMatchObject({ name: demo.name, tables: { customers: before.customers } });

    // Append-only tables still refuse deletes afterwards.
    await expect(sql`delete from audit_events where organization_id = ${other.org.id}`.execute(ctx.db)).rejects.toThrow(/append-only/);

    // Done once; the plan and invitations cannot bring it back.
    expect((await admin.post(`/admin/organizations/${demo.id}/erase`, { confirmName: demo.name })).statusCode).toBe(409);
    expect((await admin.put(`/admin/organizations/${demo.id}/plan`, { state: "active", startsOn: "2026-03-01", endsOn: null, pricePerContractCentsOverride: null, monthlyMinimumCentsOverride: null })).statusCode).toBe(409);
    expect((await admin.post(`/admin/organizations/${demo.id}/invitations`, { email: "new@example.com" })).statusCode).toBe(409);
    // The other organization still works.
    expect((await other.api.get("/customers")).statusCode).toBe(200);
  });
});
