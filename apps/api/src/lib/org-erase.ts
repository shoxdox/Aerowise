import type { DB } from "@aerowise/db";
import { sql, type Transaction } from "kysely";

/** Platform-wide tables that carry an organization_id but are not the organization's data. */
const KEPT = new Set(["organizations", "platform_audit_events"]);

export interface ErasureResult {
  /** Rows deleted per table, for the audit record. */
  tables: Record<string, number>;
  /** People who belonged to no other organization: deleted, or anonymized when another record still names them. */
  users: { deleted: number; anonymized: number };
}

/**
 * Deletes every row of one organization from every tenant table, in the caller's
 * transaction. The tables are read from the database (every table with an
 * organization_id column), so a table added later is covered without anyone listing it.
 *
 * Append-only and immutable tables (audit events, reports, signed documents) refuse
 * deletes through triggers; those triggers are switched off for this transaction only.
 * That takes a brief exclusive lock on those tables, which is acceptable for a rare,
 * deliberate admin action.
 */
export async function eraseOrganization(trx: Transaction<DB>, organizationId: string): Promise<ErasureResult> {
  const tables = (
    await sql<{ name: string }>`
      select c.table_name as name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = current_schema() and c.column_name = 'organization_id'
      order by 1`.execute(trx)
  ).rows
    .map((r) => r.name)
    .filter((t) => !KEPT.has(t));

  const guarded = (
    await sql<{ name: string }>`
      select distinct c.relname as name from pg_trigger g join pg_class c on c.oid = g.tgrelid
      where not g.tgisinternal and c.relname = any(${tables}::text[]) order by 1`.execute(trx)
  ).rows.map((r) => r.name);
  for (const t of guarded) await sql`alter table ${sql.table(t)} disable trigger user`.execute(trx);

  // The organization row stays, as the tombstone the platform audit log points at, but
  // keeps only its name and plan: its contact details, payment accounts and settings go,
  // along with its link to a credential about to be deleted.
  await trx
    .updateTable("organizations")
    .set({
      phone: null,
      email: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: null,
      postalCode: null,
      logoUrl: null,
      logoStorageKey: null,
      logoContentType: null,
      serviceCounties: [],
      stripeAccountId: null,
      stripeChargesEnabled: false,
      stripeDetailsSubmitted: false,
      renewalAutoSend: false,
      renewalTerms: null,
      smsEnabled: false,
      smsFromNumber: null,
      routeStartAddress: null,
      routeStartLat: null,
      routeStartLng: null,
      responsibleCredentialId: null,
    })
    .where("id", "=", organizationId)
    .execute();

  const members = (await trx.selectFrom("memberships").select("userId").where("organizationId", "=", organizationId).execute()).map((m) => m.userId);

  // Children before parents: delete what nothing else still points at, and repeat. A table
  // that is still referenced is retried on the next pass.
  const counts: Record<string, number> = {};
  let remaining = [...tables];
  let nulled = false;
  while (remaining.length) {
    const left: string[] = [];
    for (const t of remaining) {
      await sql`savepoint erase_table`.execute(trx);
      try {
        const r = await sql`delete from ${sql.table(t)} where organization_id = ${organizationId}`.execute(trx);
        await sql`release savepoint erase_table`.execute(trx);
        counts[t] = Number(r.numAffectedRows ?? 0);
      } catch (err) {
        await sql`rollback to savepoint erase_table`.execute(trx);
        if ((err as { code?: string }).code !== "23503") throw err;
        left.push(t);
      }
    }
    if (left.length === remaining.length) {
      // Tables that point at each other (a site and its current authority assignment):
      // clear the optional links between them once, then carry on.
      if (nulled) throw new Error(`Could not delete the rows of: ${left.join(", ")}`);
      await clearLinks(trx, organizationId, left);
      nulled = true;
    }
    remaining = left;
  }

  for (const t of guarded) await sql`alter table ${sql.table(t)} enable trigger user`.execute(trx);

  // People who now belong nowhere. A row elsewhere that names them (an admin action, a
  // record in another organization) keeps them, emptied of who they were.
  const users = { deleted: 0, anonymized: 0 };
  for (const userId of members) {
    const still = await trx.selectFrom("memberships").select("userId").where("userId", "=", userId).executeTakeFirst();
    if (still) continue;
    await sql`savepoint erase_user`.execute(trx);
    try {
      await trx.deleteFrom("users").where("id", "=", userId).execute();
      await sql`release savepoint erase_user`.execute(trx);
      users.deleted++;
    } catch (err) {
      await sql`rollback to savepoint erase_user`.execute(trx);
      if ((err as { code?: string }).code !== "23503") throw err;
      await trx
        .updateTable("users")
        .set({ name: "Deleted user", email: `deleted-${userId}@invalid`, phone: null, passwordHash: "", active: false })
        .where("id", "=", userId)
        .execute();
      users.anonymized++;
    }
  }
  return { tables: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)), users };
}

/** Sets to null every optional foreign key column among these tables that points at another of them. */
async function clearLinks(trx: Transaction<DB>, organizationId: string, tables: string[]) {
  const links = await sql<{ table: string; column: string }>`
    select distinct c.conrelid::regclass::text as "table", a.attname as "column"
    from pg_constraint c
    cross join lateral unnest(c.conkey) as k(attnum)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.contype = 'f' and not a.attnotnull and a.attname <> 'organization_id'
      and c.conrelid::regclass::text = any(${tables}::text[])
      and c.confrelid::regclass::text = any(${tables}::text[])`.execute(trx);
  for (const { table, column } of links.rows) {
    await sql`update ${sql.table(table)} set ${sql.ref(column)} = null where organization_id = ${organizationId} and ${sql.ref(column)} is not null`.execute(trx);
  }
}
