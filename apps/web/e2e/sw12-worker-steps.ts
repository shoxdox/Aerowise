import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";

// Shared by the SW-12 rows 9, 10 and 16 specs: the built-in test QuickBooks company, connected and
// syncing as the owner would set it up, and single worker steps run on demand (the e2e harness runs
// no worker): one QuickBooks sync, or one inspection's reports and filing made ready.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
// The same files the e2e API keeps (playwright.config.ts): a report the MP signed through the API is stored there.
const fileDir = process.env.E2E_FILE_DIR ?? "/tmp/aerowise-e2e-files";

/** Connects the test company and starts syncing unless it already is; true when this call connected it. */
export async function connectQuickBooks(page: Page): Promise<boolean> {
  const { connection } = await (await page.request.get("/api/quickbooks")).json();
  if (connection?.status === "connected" && connection.setupState === "active") return false;
  await page.goto("/quickbooks");
  if (connection?.status !== "connected") {
    await page.getByRole("button", { name: "Connect QuickBooks" }).click();
    await page.waitForURL(/\/quickbooks\?connected=1/);
    // A company connected before goes straight back to syncing, with no review.
    const after = (await (await page.request.get("/api/quickbooks")).json()).connection;
    if (after?.setupState === "active") return true;
  }
  await page.locator('select[name="defaultItem"]').selectOption({ label: "Services" });
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.getByRole("link", { name: "Review customer matches" }).click();
  await page.waitForURL("**/quickbooks/review");
  await expect(page.getByText(/compared your customers with the \d+ active customers/)).toBeVisible();
  await page.getByRole("button", { name: "Start syncing" }).click();
  // With customers still undecided, it asks first, right there.
  const confirmSync = page.getByRole("group", { name: "Confirm" }).getByRole("button", { name: "Start syncing" });
  await expect(confirmSync.or(page.getByRole("heading", { name: "Sync health" }))).toBeVisible();
  if (await confirmSync.isVisible()) await confirmSync.click();
  await page.waitForURL(/\/quickbooks$/);
  await expect(page.getByRole("heading", { name: "Sync health" })).toBeVisible();
  return true;
}

/** Gives the connection back, when the spec made it. */
export async function disconnectQuickBooks(page: Page) {
  expect((await page.request.post("/api/quickbooks/disconnect", { data: {} })).status()).toBe(200);
}

/** One sync of the company, as the worker's task runs it. */
export const syncQuickBooksOnce = (organizationId: string) => runOnce("quickbooks", organizationId);

/** The inspection's reports and its filing checked and made ready, as the report task does; sending stays queued. */
export const prepareFilingOnce = (organizationId: string, inspectionId: string) => runOnce("prepare-filing", organizationId, inspectionId);

/** The queued email send of a filing, run once while the mail provider is down: the filing fails (forced, test-only). */
export const failFilingSendOnce = (organizationId: string, filingId: string) => runOnce("submit-filing-failing", organizationId, filingId);

function runOnce(...args: string[]) {
  const out = execFileSync("pnpm", ["--filter", "@aerowise/api", "exec", "tsx", "test/sw12-run-once.ts", ...args], {
    cwd: resolve(process.cwd(), "../.."),
    env: { ...process.env, DATABASE_URL: databaseUrl, DEMO_MODE: "true", DEMO_LIVE_SERVICES: "", FILE_STORAGE_DIR: fileDir },
    encoding: "utf8",
    timeout: 60_000,
  });
  return out.trim().split("\n").pop() ?? "";
}
