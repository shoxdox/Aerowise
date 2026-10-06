import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./db-url.ts";

const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const cli = fileURLToPath(new URL("../../../packages/db/src/cli.ts", import.meta.url));
const run = (env: Record<string, string>) => promisify(execFile)(tsx, [cli, "check-config"], { env: { PATH: process.env.PATH ?? "", DATABASE_URL: testDatabaseUrl(), ...env } });

describe("check-config, run by a deploy before it replaces anything", () => {
  it("fails and names what is missing in production", async () => {
    await expect(run({ NODE_ENV: "production", DEPLOY_ENV: "production" })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/Refusing to start[\s\S]*RESEND_API_KEY/),
    });
  });

  it("passes for a complete staging configuration", async () => {
    const { stdout } = await run({
      NODE_ENV: "production",
      DEPLOY_ENV: "staging",
      FILE_SIGNING_SECRET: "x".repeat(64),
      PUBLIC_APP_URL: "https://staging.203-0-113-7.sslip.io",
      DEMO_MODE: "true",
    });
    expect(stdout).toContain("configuration complete");
  });
});

describe("the self-hosted server's settings", () => {
  // Tuning knobs and development-only settings that keep their defaults on the server.
  const notOnTheServer = new Set([
    "API_PORT", "API_URL", "HEALTH_INCLUDES_WORKER", "PLATFORM_ADMIN_PASSWORD", "R2_ENDPOINT", "SMS_WEBHOOK_BASE_URL", "TEST_DATABASE_URL",
    "BILLING_RUN_INTERVAL_MS", "LOGIN_RATE_LIMIT", "QUEUE_CHECK_INTERVAL_MS", "QUICKBOOKS_SYNC_INTERVAL_MS", "SMS_SWEEP_INTERVAL_MS", "WORKER_HEARTBEAT_FILE", "WORKER_HEARTBEAT_MAX_AGE_MS",
  ]);
  const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");
  const keys = (text: string, pattern: RegExp) => new Set([...text.matchAll(pattern)].map((m) => m[1]!));

  it("health checks use 127.0.0.1: inside a container localhost can mean ::1, where the API (0.0.0.0) does not listen", () => {
    expect(read("deploy/vps/app.compose.yaml")).not.toMatch(/http:\/\/localhost/);
  });

  it("passes every setting in .env.example to the API and worker, unless it is listed as staying at its default", () => {
    const documented = keys(read(".env.example"), /^#? ?([A-Z][A-Z0-9_]+)=/gm);
    const passed = keys(read("deploy/vps/app.compose.yaml"), /^ {4}([A-Z][A-Z0-9_]+):/gm);
    expect([...documented].filter((k) => !passed.has(k) && !notOnTheServer.has(k))).toEqual([]);
  });
});
