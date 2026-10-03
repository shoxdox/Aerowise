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
} else {
  console.error("usage: cli.ts migrate|seed");
  process.exit(1);
}
