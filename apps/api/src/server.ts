import { createDb, migrate, requireDatabaseUrl } from "@aerowise/db";
import { buildApp } from "./app.ts";

const url = requireDatabaseUrl();
await migrate(url, (msg) => console.log(msg));

const db = createDb(url);
const app = await buildApp({ db, production: process.env.NODE_ENV === "production", logger: true });

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: "0.0.0.0", port: Number(process.env.API_PORT ?? 4000) });
