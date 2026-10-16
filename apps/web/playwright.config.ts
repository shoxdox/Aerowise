import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run the real API and web app against a throwaway database that is
// reset and seeded on every run. Build the web app first (`pnpm build`).
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const db = "pnpm --filter @aerowise/db exec tsx src/cli.ts";
// Other ports let two checkouts run their browser tests side by side. The web app proxies /api to
// the API address it was built with, so build with API_URL=http://localhost:$E2E_API_PORT first.
const apiPort = process.env.E2E_API_PORT ?? "4000";
const webPort = process.env.E2E_WEB_PORT ?? "3000";
const origin = `http://localhost:${webPort}`;
const fileDir = process.env.E2E_FILE_DIR ?? "/tmp/aerowise-e2e-files";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    ...devices["Pixel 7"],
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: [
    {
      command: `${db} reset && ${db} seed && pnpm --filter @aerowise/api demo-story && pnpm --filter @aerowise/api start`,
      cwd: "../..",
      url: `http://localhost:${apiPort}/health`,
      // Demo mode, as on the hosted demo: every outside service is a test stand-in and the banner shows.
      // Work orders, service items, field work on the phone, estimates, deposits, plan versions, pumping and service cycles on, as staging will run them (SW-1, SW-2, SW-3, SW-5, SW-8, SW-6, SW-9); the flag-off
      // paths are covered by the API tests.
      env: { DATABASE_URL: databaseUrl, API_PORT: apiPort, PUBLIC_APP_URL: origin, FILE_STORAGE_DIR: fileDir, DEMO_MODE: "true", LOGIN_RATE_LIMIT: "100", PUBLIC_LINK_ACTIONS_PER_MINUTE: "1000", SIGNED_FILES_PER_MINUTE: "10000", AEROWISE_FEATURES: "work_orders,service_items,field_work,estimates,deposits,plan_builder,pumping,service_cycles" },
      timeout: 120_000,
      stdout: "pipe",
    },
    // The street map's tiles: the small synthetic fixture (scripts/map/make-fixture.py), not real streets.
    { command: `pnpm exec next start --port ${webPort}`, url: `${origin}/login`, timeout: 120_000, env: { MAP_TILES_FILE: "e2e/fixtures/map-fixture.pmtiles" } },
  ],
});
