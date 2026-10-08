import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run the real API and web app against a throwaway database that is
// reset and seeded on every run. Build the web app first (`pnpm build`).
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
const db = "pnpm --filter @aerowise/db exec tsx src/cli.ts";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    ...devices["Pixel 7"],
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: [
    {
      command: `${db} reset && ${db} seed && pnpm --filter @aerowise/api demo-story && pnpm --filter @aerowise/api start`,
      cwd: "../..",
      url: "http://localhost:4000/health",
      // Demo mode, as on the hosted demo: every outside service is a test stand-in and the banner shows.
      // Work orders on, as staging will run them (SW-1); the flag-off paths are covered by the API tests.
      env: { DATABASE_URL: databaseUrl, API_PORT: "4000", FILE_STORAGE_DIR: "/tmp/aerowise-e2e-files", DEMO_MODE: "true", LOGIN_RATE_LIMIT: "100", AEROWISE_FEATURES: "work_orders,service_items,estimates,deposits" },
      timeout: 120_000,
      stdout: "pipe",
    },
    // The street map's tiles: the small synthetic fixture (scripts/map/make-fixture.py), not real streets.
    { command: "pnpm start", url: "http://localhost:3000/login", timeout: 120_000, env: { MAP_TILES_FILE: "e2e/fixtures/map-fixture.pmtiles" } },
  ],
});
