import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/**
 * Applies plain SQL files from packages/db/migrations in filename order. Each file runs
 * in its own transaction and is recorded in schema_migrations. Applied files are never
 * edited; changes go in a new file.
 */
export async function migrate(connectionString: string, log: (msg: string) => void = () => {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Serialize concurrent migrators (e.g. several containers starting at once).
    await client.query("select pg_advisory_lock(727274)");
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const applied = new Set(
      (await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(MIGRATIONS_DIR + file, "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        log(`applied ${file}`);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => {});
    await client.end();
  }
}
