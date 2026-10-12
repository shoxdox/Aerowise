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
  await expect(page.getByText("Free for 90 days", { exact: true })).toBeVisible();
  await expect(page.getByText("$0.50 per active contract per month, with a $50.00 monthly minimum.")).toBeVisible();
  await expect(page.getByText(/first five companies pay \$0\.25/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Who's behind this" })).toBeVisible();
  await expect(page.getByRole("link", { name: "justin@deshain.com" })).toBeVisible();

  await page.getByRole("link", { name: "How we handle your data" }).click();
  await expect(page).toHaveURL(/\/data-handling$/);
  await expect(page.getByRole("heading", { name: "Deleting your data" })).toBeVisible();

  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("a visitor asks for a demo and it shows up in the admin console", async ({ page }) => {
  await page.goto("/");
  const form = page.getByRole("form", { name: "Ask for a demo" });
  await form.getByLabel("Your name").fill("Pat Rivera");
  await form.getByLabel("Email").fill("pat@example.com");
  await form.getByLabel("Company").fill("Rivera Aerobic Service");
  await form.getByLabel("Counties you work in (optional)").fill("Travis, Williamson");
  await form.getByRole("button", { name: "Ask for a demo" }).click();
  await expect(page.getByRole("status")).toHaveText(/We got your request/);

  await page.goto("/admin/demo-requests");
  await page.waitForURL("**/admin/login?next=*");
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin\/demo-requests$/);
  const request = page.getByRole("article", { name: "Demo request from Rivera Aerobic Service" });
  await expect(request).toBeVisible();
  // The e2e API has no mail provider, so the alert went to the outbox and is not called emailed (STG-08).
  await expect(request.getByText("Recorded in test outbox")).toBeVisible();
  await expect(request.getByText("Emailed", { exact: true })).toHaveCount(0);
  await request.getByRole("button", { name: "Mark handled" }).click();
  await expect(request.getByText("Handled")).toBeVisible();
});
