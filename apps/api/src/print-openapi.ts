import { createDb } from "@aerowise/db";
import { buildApp } from "./app.ts";

// Prints the OpenAPI document without connecting to a database.
const db = createDb("postgres://unused@localhost/unused");
const app = await buildApp({ db });
await app.ready();
console.log(JSON.stringify(app.swagger(), null, 2));
await app.close();
await db.destroy();
