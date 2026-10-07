import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sql, type Transaction } from "kysely";
import type { Database } from "./client.ts";
import type { DB } from "./schema.ts";
import { seed } from "./seed.ts";

const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ReseedResult {
  /** The public demo companies emptied and removed: the shared one and visitors' own. */
  removed: string[];
  /** Companies left exactly as they were: prospect demos and every real company or trial. */
  kept: number;
}

/**
 * The nightly reset of the hosted demo, and only of its public part: the shared demo company
 * and every visitor's own demo company (W10.2) are removed with their people and stored files,
 * then the shared one is seeded again. Prospect demos (W10.6) and real companies (trials
 * included) are left alone, along with their people, sign-ins, files, queued work and outbox;
 * a prospect demo still ends on its own day (apps/api/src/lib/demo-lifecycle.ts). Platform
 * records (rules, authority evidence, platform admins, demo requests) are kept too. Only for
 * demo mode or development, never production.
 */
export async function reseedDemo(db: Database, opts: { filesDir?: string; log?: (msg: string) => void } = {}): Promise<ReseedResult> {
  const log = opts.log ?? (() => {});
  const result = await db.transaction().execute(async (trx) => {
    // Locked first, so nothing new can be written under these companies while they go.
    const removed = (
      await trx.selectFrom("organizations").select("id").where("demo", "=", true).where("demoProspect", "is", null).orderBy("id").forUpdate().execute()
    ).map((o) => o.id);
    const all = await trx.selectFrom("organizations").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
    const kept = Number(all.n) - removed.length;
    if (removed.length) await removeCompanies(trx, removed, log);
    // Who started a visitor demo, for the hourly limit: never tied to a company, so all of it goes.
    await trx.deleteFrom("demoVisits").execute();
    return { removed, kept };
  });
  log(`removed ${result.removed.length} public demo companies; kept ${result.kept} others`);
  if (opts.filesDir) {
    // Each company's files live under a folder named by its id (packages/storage), so only the
    // removed companies' folders go.
    for (const id of result.removed) {
      if (!ORG_ID.test(id)) throw new Error(`Invalid organization id ${id}`);
      await rm(join(opts.filesDir, id), { recursive: true, force: true });
    }
    log(`removed the stored files of ${result.removed.length} companies from ${opts.filesDir}`);
  }
  await seed(db, log);
  return result;
}

/**
 * Deletes these companies' rows from every table with an organization_id (read from the
 * database, so a table added later is covered), then the companies, then the people who
 * belonged to nothing else. Append-only tables refuse deletes through triggers; those are
 * switched off for this transaction only.
 */
async function removeCompanies(trx: Transaction<DB>, ids: string[], log: (msg: string) => void) {
  const tables = (
    await sql<{ name: string }>`
      select c.table_name as name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = current_schema() and c.column_name = 'organization_id' and c.table_name <> 'organizations'
      order by 1`.execute(trx)
  ).rows.map((r) => r.name);

  // Their people: anyone who belongs to one of them and to no company that stays.
  const people = (
    await trx
      .selectFrom("memberships as m")
      .select("m.userId")
      .distinct()
      .where("m.organizationId", "in", ids)
      .where((eb) => eb.not(eb.exists(eb.selectFrom("memberships as o").select("o.userId").whereRef("o.userId", "=", "m.userId").where("o.organizationId", "not in", ids))))
      .execute()
  ).map((m) => m.userId);
  // Their QuickBooks stand-in companies: the realms they connected, and the one each always gets.
  const realms = new Set((await trx.selectFrom("quickbooksConnections").select("realmId").where("organizationId", "in", ids).execute()).map((c) => c.realmId));
  for (const id of ids) realms.add(`test-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`);

  const guarded = (
    await sql<{ name: string }>`
      select distinct c.relname as name from pg_trigger g join pg_class c on c.oid = g.tgrelid
      where not g.tgisinternal and c.relname = any(${tables}::text[]) order by 1`.execute(trx)
  ).rows.map((r) => r.name);
  for (const t of guarded) await sql`alter table ${sql.table(t)} disable trigger user`.execute(trx);

  // The company row points at its responsible credential; that link goes first.
  await trx.updateTable("organizations").set({ responsibleCredentialId: null }).where("id", "in", ids).execute();

  // Children before parents: delete what nothing else still points at, and repeat.
  let deleted = 0;
  let remaining = tables;
  let nulled = false;
  while (remaining.length) {
    const left: string[] = [];
    for (const t of remaining) {
      await sql`savepoint reseed_table`.execute(trx);
      try {
        const r = await sql`delete from ${sql.table(t)} where organization_id = any(${ids}::uuid[])`.execute(trx);
        await sql`release savepoint reseed_table`.execute(trx);
        deleted += Number(r.numAffectedRows ?? 0);
      } catch (err) {
        await sql`rollback to savepoint reseed_table`.execute(trx);
        if ((err as { code?: string }).code !== "23503") throw err;
        left.push(t);
      }
    }
    if (left.length === remaining.length) {
      // Tables that point at each other: clear the optional links between them once.
      if (nulled) throw new Error(`Could not delete the rows of: ${left.join(", ")}`);
      await clearLinks(trx, ids, left);
      nulled = true;
    }
    remaining = left;
  }
  for (const t of guarded) await sql`alter table ${sql.table(t)} enable trigger user`.execute(trx);
  await trx.deleteFrom("organizations").where("id", "in", ids).execute();
  await trx.deleteFrom("quickbooksTestCompanies").where("realmId", "in", [...realms]).execute();

  // A person still named by a record that stays is kept, emptied of who they were.
  let users = 0;
  for (const userId of people) {
    await trx.deleteFrom("passwordResetTokens").where("userId", "=", userId).execute();
    await sql`savepoint reseed_user`.execute(trx);
    try {
      await trx.deleteFrom("users").where("id", "=", userId).execute();
      await sql`release savepoint reseed_user`.execute(trx);
      users++;
    } catch (err) {
      await sql`rollback to savepoint reseed_user`.execute(trx);
      if ((err as { code?: string }).code !== "23503") throw err;
      await trx
        .updateTable("users")
        .set({ name: "Deleted user", email: `deleted-${userId}@invalid`, phone: null, passwordHash: "", active: false })
        .where("id", "=", userId)
        .execute();
    }
  }
  log(`deleted ${deleted} rows from ${tables.length} tables and ${users} people`);
}

/** Sets to null every optional foreign key column among these tables that points at another of them. */
async function clearLinks(trx: Transaction<DB>, ids: string[], tables: string[]) {
  const links = await sql<{ table: string; column: string }>`
    select distinct c.conrelid::regclass::text as "table", a.attname as "column"
    from pg_constraint c
    cross join lateral unnest(c.conkey) as k(attnum)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.contype = 'f' and not a.attnotnull and a.attname <> 'organization_id'
      and c.conrelid::regclass::text = any(${tables}::text[])
      and c.confrelid::regclass::text = any(${tables}::text[])`.execute(trx);
  for (const { table, column } of links.rows) {
    await sql`update ${sql.table(table)} set ${sql.ref(column)} = null where organization_id = any(${ids}::uuid[]) and ${sql.ref(column)} is not null`.execute(trx);
  }
}
