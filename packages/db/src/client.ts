import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "./schema.ts";

// Return DATE columns as plain YYYY-MM-DD strings instead of shifting them into JS Dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export type Database = Kysely<DB>;

export function createDb(connectionString: string): Database {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) }),
    plugins: [new CamelCasePlugin()],
  });
}

export function requireDatabaseUrl(name = "DATABASE_URL"): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} is not set. See .env.example.`);
  return url;
}
