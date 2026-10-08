import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";

// Shared by the SW-12 rows 9 and 10 specs: the built-in test QuickBooks company, connected and
// syncing as the owner would set it up, and one sync run on demand (the e2e harness has no worker).
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";

/** Connects the test company and starts syncing unless it already is; true when this call connected it. */
export async function connectQuickBooks(page: Page): Promise<boolean> {
  const { connection } = await (await page.request.get("/api/quickbooks")).json();
  if (connection?.status === "connected" && connection.setupState === "active") return false;
  await page.goto("/quickbooks");
  if (connection?.status !== "connected") {
    await page.getByRole("button", { name: "Connect QuickBooks" }).click();
    await page.waitForURL(/\/quickbooks\?connected=1/);
  }
  await page.locator('select[name="defaultItem"]').selectOption({ label: "Services" });
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.getByRole("link", { name: "Review customer matches" }).click();
  await page.waitForURL("**/quickbooks/review");
  await expect(page.getByText(/compared your customers with the \d+ active customers/)).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Start syncing" }).click();
  await page.waitForURL(/\/quickbooks$/);
  await expect(page.getByRole("heading", { name: "Sync health" })).toBeVisible();
  return true;
}

/** Gives the connection back, when the spec made it. */
export async function disconnectQuickBooks(page: Page) {
  expect((await page.request.post("/api/quickbooks/disconnect", { data: {} })).status()).toBe(200);
}

/** One sync of the company, as the worker's task runs it. */
export function syncQuickBooksOnce(organizationId: string) {
  const out = execFileSync("pnpm", ["--filter", "@aerowise/api", "exec", "tsx", "test/sw12-quickbooks-sync-once.ts", organizationId], {
    cwd: resolve(process.cwd(), "../.."),
    env: { ...process.env, DATABASE_URL: databaseUrl, DEMO_MODE: "true", FILE_STORAGE_DIR: "/tmp/aerowise-e2e-files" },
    encoding: "utf8",
    timeout: 60_000,
  });
  return out.trim().split("\n").pop() ?? "";
}
