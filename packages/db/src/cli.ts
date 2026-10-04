import { sql } from "kysely";
import { createDb, requireDatabaseUrl } from "./client.ts";
import { migrate } from "./migrate.ts";
import { seed } from "./seed.ts";

const command = process.argv[2];
const url = requireDatabaseUrl();

if (command === "migrate") {
  await migrate(url, console.log);
  console.log("migrations up to date");
} else if (command === "seed") {
  await migrate(url, console.log);
  const db = createDb(url);
  try {
    await seed(db, console.log);
  } finally {
    await db.destroy();
  }
} else if (command === "reset") {
  // Drops and recreates a throwaway database (end-to-end tests). Refuses anything else.
  const target = new URL(url);
  const name = target.pathname.slice(1);
  if (!/(test|e2e)/.test(name)) {
    console.error(`refusing to reset ${name}: only databases named *test* or *e2e* can be reset`);
    process.exit(1);
  }
  target.pathname = "/postgres";
  const admin = createDb(target.toString());
  try {
    await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin);
    await sql`create database ${sql.id(name)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
  console.log(`reset ${name}`);
} else {
  console.error("usage: cli.ts migrate|seed|reset");
  process.exit(1);
}
