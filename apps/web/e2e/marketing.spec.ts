import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// The real authorities in the bundled rulesets: everything but the fictional example.
const RULESETS = fileURLToPath(new URL("../../../packages/compliance/rulesets", import.meta.url));
const authorities = readdirSync(RULESETS)
  .flatMap((key) => readdirSync(join(RULESETS, key)).map((file) => JSON.parse(readFileSync(join(RULESETS, key, file), "utf8"))))
  .filter((r) => r.profile && r.profile.status !== "fictional")
  .map((r) => r.jurisdiction.authorityName as string);

test("the marketing page shows signed out, with coverage from the rulesets and configured pricing", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();

  const coverage = page.getByRole("list", { name: "Authorities covered" });
  await expect(coverage.getByRole("listitem")).toHaveCount(new Set(authorities).size);
  for (const name of authorities) await expect(coverage.getByText(name, { exact: true })).toBeVisible();
  await expect(coverage.getByText(/fictional/)).toHaveCount(0);

  // The defaults from the subscription config (the e2e API sets none).
  await expect(page.getByText("Free for 90 days")).toBeVisible();
  await expect(page.getByText("$1.50 per active contract per month, with a $99.00 monthly minimum.")).toBeVisible();

  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
