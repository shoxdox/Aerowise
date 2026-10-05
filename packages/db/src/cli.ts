import { sql } from "kysely";
import { createDb, requireDatabaseUrl } from "./client.ts";
import { ConfigError, checkConfig } from "./config-check.ts";
import { migrate } from "./migrate.ts";
import { createPlatformAdmin } from "./platform-admin.ts";
import { reseedDemo } from "./reseed.ts";
import { seed } from "./seed.ts";

const command = process.argv[2];
const url = requireDatabaseUrl();

if (command === "check-config") {
  // The same check the API and worker run when they start, so a deploy can stop before it
  // replaces anything when a secret is missing.
  try {
    checkConfig();
    console.log("configuration complete");
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
} else if (command === "migrate") {
  await migrate(url, console.log);
  console.log("migrations up to date");
} else if (command === "seed" || command === "reseed-demo") {
  // Demo data never goes into a real production database: in production only the hosted
  // demo (DEMO_MODE=true) may be seeded or reset.
  if (process.env.NODE_ENV === "production" && process.env.DEMO_MODE !== "true") {
    console.error(`refusing to ${command}: NODE_ENV is production and DEMO_MODE is not true`);
    process.exit(1);
  }
  await migrate(url, console.log);
  const db = createDb(url);
  try {
    if (command === "seed") await seed(db, console.log);
    else await reseedDemo(db, { filesDir: process.env.FILE_STORAGE_DIR, log: console.log });
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
} else if (command === "create-platform-admin") {
  // cli.ts create-platform-admin <email> <name...>, with the password on stdin (or in
  // PLATFORM_ADMIN_PASSWORD), so it never lands in shell history or the process list.
  const [email, ...nameParts] = process.argv.slice(3);
  if (!email || nameParts.length === 0) {
    console.error('usage: cli.ts create-platform-admin <email> <name>   (password on stdin)');
    process.exit(1);
  }
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? (await readStdinLine());
  await migrate(url, console.log);
  const db = createDb(url);
  try {
    const admin = await createPlatformAdmin(db, { email, name: nameParts.join(" "), password });
    console.log(`created platform admin ${admin.email} (${admin.id})`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
} else {
  console.error("usage: cli.ts check-config|migrate|seed|reseed-demo|reset|create-platform-admin");
  process.exit(1);
}

async function readStdinLine(): Promise<string> {
  if (process.stdin.isTTY) process.stdout.write("Password: ");
  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
    if (data.includes("\n")) break;
  }
  return data.split("\n")[0]?.replace(/\r$/, "") ?? "";
}
