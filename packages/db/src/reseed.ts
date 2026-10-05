import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "kysely";
import type { Database } from "./client.ts";
import { seed } from "./seed.ts";

/**
 * Tables a demo reseed leaves alone: the migration record, the authority rules (the running
 * API and worker loaded them at start) and the platform admins who run Aerowise.
 */
export const KEPT_ON_RESEED = ["schema_migrations", "jurisdictions", "jurisdiction_rulesets", "platform_admins", "platform_admin_sessions"];

/**
 * Empties every other table, removes stored files, and loads the demo data again: the
 * nightly reset of the hosted demo. Only for demo mode or development, never production.
 */
export async function reseedDemo(db: Database, opts: { filesDir?: string; log?: (msg: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const tables = await sql<{ tablename: string }>`select tablename from pg_tables where schemaname = 'public' order by tablename`.execute(db);
  const emptied = tables.rows.map((r) => r.tablename).filter((t) => !KEPT_ON_RESEED.includes(t));
  // TRUNCATE is not a row-level change, so the append-only audit triggers allow it.
  await sql`truncate ${sql.join(emptied.map((t) => sql.id(t)))} restart identity cascade`.execute(db);
  log(`emptied ${emptied.length} tables`);
  if (opts.filesDir) {
    const entries = await readdir(opts.filesDir).catch(() => [] as string[]);
    await Promise.all(entries.map((e) => rm(join(opts.filesDir!, e), { recursive: true, force: true })));
    log(`removed ${entries.length} entries from ${opts.filesDir}`);
  }
  await seed(db, log);
}
