import { migrate } from "@aerowise/db";
import pg from "pg";
import { testDatabaseUrl } from "./db-url.ts";

/** Creates the test database if needed and brings it to the latest migration. */
export default async function setup() {
  const url = new URL(testDatabaseUrl());
  const dbName = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query("select 1 from pg_database where datname = $1", [dbName]);
  if (exists.rowCount === 0) await client.query(`create database "${dbName.replace(/"/g, '""')}"`);
  await client.end();
  await migrate(url.toString());
}
