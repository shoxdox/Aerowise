import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** A migrator waiting this long for a lock gives up (and the process restarts) rather than holding every replica's start-up. */
const LOCK_TIMEOUT = "2min";

export interface MigrationFile {
  name: string;
  sha256: string;
}
export interface AppliedMigration {
  name: string;
  checksum: string | null;
}

/**
 * Which files to apply, after checking the record: an applied file whose contents changed
 * is refused (applied files are never edited; changes go in a new file), an applied file
 * that is missing from disk is refused, and a new file that shares its number with another
 * is refused before anything runs. Files applied before checksums were recorded get theirs
 * recorded now (`backfill`).
 */
export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): { apply: string[]; backfill: MigrationFile[] } {
  const onDisk = new Map(files.map((f) => [f.name, f]));
  const record = new Map(applied.map((a) => [a.name, a]));
  for (const a of applied) {
    const f = onDisk.get(a.name);
    if (!f) throw new Error(`migration ${a.name} was applied but its file is missing; applied files are never removed or renamed`);
    if (a.checksum && a.checksum !== f.sha256) throw new Error(`migration ${a.name} changed after it was applied; put the change in a new file`);
  }
  const byNumber = new Map<string, string[]>();
  for (const f of files) {
    const n = f.name.match(/^(\d+)_/)?.[1];
    if (n) byNumber.set(n, [...(byNumber.get(n) ?? []), f.name]);
  }
  for (const [n, names] of byNumber) {
    if (names.length > 1 && !LEGACY_SHARED_NUMBERS.has(n)) {
      throw new Error(`migrations ${names.join(" and ")} share the number ${n}; give the new one the next free number`);
    }
  }
  return {
    apply: files.filter((f) => !record.has(f.name)).map((f) => f.name).sort(),
    backfill: applied.filter((a) => !a.checksum).map((a) => onDisk.get(a.name)!),
  };
}

/** Numbers two or three files shared before this check existed; applied everywhere, so they stay. */
const LEGACY_SHARED_NUMBERS = new Set(["0028", "0030"]);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Applies plain SQL files from packages/db/migrations in filename order. Each file runs
 * in its own transaction and is recorded in schema_migrations with its checksum, so a
 * later edit to an applied file is caught at the next start. Applied files are never
 * edited; changes go in a new file.
 */
export async function migrate(connectionString: string, log: (msg: string) => void = () => {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`set lock_timeout = '${LOCK_TIMEOUT}'`);
    // Serialize concurrent migrators (e.g. several containers starting at once).
    await client.query("select pg_advisory_lock(727274)");
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    await client.query("alter table schema_migrations add column if not exists checksum text");
    const applied = (await client.query<AppliedMigration>("select name, checksum from schema_migrations")).rows;
    const names = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const contents = new Map<string, string>();
    for (const name of names) contents.set(name, await readFile(MIGRATIONS_DIR + name, "utf8"));
    const plan = planMigrations(
      names.map((name) => ({ name, sha256: sha256(contents.get(name)!) })),
      applied,
    );
    for (const f of plan.backfill) await client.query("update schema_migrations set checksum = $2 where name = $1", [f.name, f.sha256]);
    for (const file of plan.apply) {
      const text = contents.get(file)!;
      const started = Date.now();
      await client.query("begin");
      try {
        await client.query(text);
        await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [file, sha256(text)]);
        await client.query("commit");
        log(`applied ${file} (${Date.now() - started} ms)`);
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
