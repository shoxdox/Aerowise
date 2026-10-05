import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDb } from "@aerowise/db";
import { checkHeartbeat, writeHeartbeat } from "@aerowise/tasks";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { testDatabaseUrl } from "./db-url.ts";

const db = createDb(testDatabaseUrl());
afterAll(() => db.destroy());

const dir = mkdtempSync(join(tmpdir(), "aerowise-heartbeat-"));
const maxAgeMs = 60_000;
const at = (iso: string) => new Date(iso);

describe("worker heartbeat", () => {
  it("is healthy while recent and unhealthy once missing or old", async () => {
    const file = join(dir, "check");
    expect(await checkHeartbeat({ file, maxAgeMs }, at("2026-03-01T18:00:00Z"))).toMatchObject({ ok: false, ageMs: null });
    await writeHeartbeat(file, at("2026-03-01T18:00:00Z"));
    expect(await checkHeartbeat({ file, maxAgeMs }, at("2026-03-01T18:00:59Z"))).toEqual({ ok: true, ageMs: 59_000 });
    expect(await checkHeartbeat({ file, maxAgeMs }, at("2026-03-01T18:01:01Z"))).toMatchObject({ ok: false, ageMs: 61_000 });
    // Each pass moves it forward again.
    await writeHeartbeat(file, at("2026-03-01T18:01:00Z"));
    expect(await checkHeartbeat({ file, maxAgeMs }, at("2026-03-01T18:01:01Z"))).toEqual({ ok: true, ageMs: 1_000 });
  });

  it("is checked by the worker's health command", async () => {
    const file = join(dir, "command");
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const health = fileURLToPath(new URL("../../worker/src/health.ts", import.meta.url));
    const run = () => promisify(execFile)(tsx, [health], { env: { ...process.env, WORKER_HEARTBEAT_FILE: file, WORKER_HEARTBEAT_MAX_AGE_MS: "60000" } });
    await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("has not reported in") });
    await writeHeartbeat(file);
    await expect(run()).resolves.toMatchObject({ stdout: expect.stringContaining("worker ok") });
  });
});

describe("/health", () => {
  it("checks only the API and database by default", async () => {
    const app = await buildApp({ db });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it("also requires a recent worker heartbeat when the worker shares the machine", async () => {
    const file = join(dir, "api");
    let now = at("2026-03-01T18:00:00Z");
    const app = await buildApp({ db, now: () => now, workerHeartbeat: { file, maxAgeMs } });
    const health = () => app.inject({ method: "GET", url: "/health" });

    let res = await health();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, worker: "the worker has not reported in" });

    await writeHeartbeat(file, now);
    res = await health();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, worker: "ok" });

    now = at("2026-03-01T18:05:00Z");
    res = await health();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, worker: "the worker last reported 300s ago" });
    await app.close();
  });
});
