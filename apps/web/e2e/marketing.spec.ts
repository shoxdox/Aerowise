import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const RULESETS = fileURLToPath(new URL("../../../packages/compliance/rulesets", import.meta.url));
const authorities = readdirSync(RULESETS).flatMap((key) => readdirSync(join(RULESETS, key)).map((file) => JSON.parse(readFileSync(join(RULESETS, key, file), "utf8")))).filter((r) => r.profile && r.profile.status !== "fictional").map((r) => r.jurisdiction.authorityName as string);

test("public offer, optional authority detail and actual inspection preview stay truthful", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/login");
  await expect(page.locator(".price")).toContainText("$0.50");
  await expect(page.getByText("$50.00 monthly minimum.", { exact: true })).toBeVisible();
  await expect(page.getByText(/90-day free period/)).toBeVisible();
  await expect(page.getByText(/ordinary trial is 30 days/)).toBeVisible();
  await expect(page.getByText(/first 5 eligible companies can receive \$0\.25/)).toBeVisible();
  const examples = page.getByRole("list", { name: "Example monthly prices" });
  await expect(examples.getByRole("listitem").first()).toContainText("List: $50.00/month");
  await expect(examples.getByRole("listitem").nth(1)).toContainText("List: $150.00/month");
  await expect(examples.getByRole("listitem").nth(1)).toContainText("Founder: $75.00/month");
  await page.getByText(/^All \d+ public authority profiles$/).click();
  const coverage = page.locator("#coverage-groups");
  await expect(coverage.getByRole("listitem")).toHaveCount(new Set(authorities).size);
  for (const name of authorities) await expect(coverage.getByText(name, { exact: true })).toBeVisible();
  await expect(coverage.getByText(/fictional/)).toHaveCount(0);
  await page.getByText("Open the optional inspection preview", { exact: true }).click();
  const status = page.getByTestId("try-status");
  await page.getByLabel("Reporting authority", { exact: true }).selectOption("tx-williamson-county");
  await expect(status).toContainText("example answers still needed");
  await expect(status).toContainText("Sludge in pump tank");
  await expect(status).not.toContainText("Aerator");
  await page.getByTestId("try-form").getByRole("group", { name: "Air filter" }).getByRole("button", { name: "Pass", exact: true }).click();
  await expect(status).not.toContainText("Air filter");
  await page.getByRole("button", { name: "Start over" }).click();
  await expect(status).toContainText("Air filter");
  await page.getByLabel("Reporting authority", { exact: true }).selectOption("tx-hays-county");
  await expect(status).not.toContainText("Sludge in pump tank");
  await expect(page.getByText("counted from the contract's start date", { exact: false })).toBeVisible();
  const form = page.getByTestId("try-form");
  for (const group of await form.getByRole("group").all()) {
    if (await group.locator('[aria-pressed="true"]').count() === 0) await group.getByRole("button").first().click();
  }
  for (const number of await form.locator('input[type="number"]').all()) await number.fill("2");
  await expect(status).toContainText("Example answers complete");
  await expect(status).toContainText("required photos, site and system details, provider credentials, office review and signature");
  await expect(status).not.toContainText("Ready:");
  const options = await page.getByLabel("Reporting authority", { exact: true }).locator("option").allTextContents();
  expect(new Set(options).size).toBe(options.length);
  expect(options.filter((s) => /Denton/i.test(s)).length).toBeGreaterThanOrEqual(2);
  expect(options.some((s) => /City of Denton/i.test(s))).toBe(true);
  expect(options.some((s) => /SJRA|San Jacinto/i.test(s))).toBe(true);
  for (const img of await page.locator(".marketing .shot img").all()) expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  await page.getByRole("link", { name: "How we handle your data" }).click();
  await expect(page.getByRole("heading", { name: "Deleting your data" })).toBeVisible();
  await expect(page.getByText(/tombstone/)).toBeVisible();
});

test("saving a request reports simulated notification and remains actionable in admin", async ({ page }) => {
  await page.goto("/");
  const form = page.getByRole("form", { name: "Save a pilot request" });
  await form.getByLabel("Your name").fill("Pat Rivera");
  await form.getByLabel("Email", { exact: true }).fill("pat@example.com");
  await form.getByLabel("Company", { exact: true }).fill("Rivera Aerobic Service");
  await form.getByLabel("Counties you work in (optional)").fill("Travis, Williamson");
  await form.getByRole("button", { name: "Save pilot request" }).click();
  const saved = page.getByRole("status").filter({ hasText: "Your request is saved" });
  await expect(saved).toContainText("simulated test outbox");
  await expect(saved.getByRole("link", { name: /Email Justin directly/ })).toHaveAttribute("href", "mailto:justin@deshain.com");
  await page.goto("/admin/demo-requests");
  await page.waitForURL("**/admin/login?next=*");
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin\/demo-requests$/);
  const request = page.getByRole("article", { name: "Demo request from Rivera Aerobic Service" });
  await expect(request).toBeVisible();
  await expect(request.getByText("Recorded in test outbox")).toBeVisible();
  await request.getByRole("button", { name: "Mark handled" }).click();
  await expect(request.getByText("Handled", { exact: true })).toBeVisible();
});

test("slow and failed overview reads retain useful actions and retry every hollow area", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/public/overview", async (route) => { await delayed; await route.fulfill({ status: 503, json: { message: "Controlled unavailable" } }); });
  await page.goto("/");
  await expect(page.getByText(/^Loading pricing/)).toBeVisible();
  await expect(page.getByTestId("try-demo")).toBeVisible();
  await expect(page.getByRole("link", { name: "Email Justin: justin@deshain.com" })).toBeVisible();
  release();
  await expect(page.getByText(/^Pricing is temporarily unavailable/)).toBeVisible();
  await expect(page.getByText(/^Authority profiles is temporarily unavailable/)).toBeVisible();
  await expect(page.getByText(/^Inspection preview is temporarily unavailable/)).toBeVisible();
  await expect(page.locator(".price")).toHaveCount(0);
  await page.unroute("**/api/public/overview");
  await page.getByRole("button", { name: "Retry pricing", exact: true }).click();
  await expect(page.locator(".price")).toContainText("$0.50");
  await expect(page.getByLabel("Authority fit lookup")).toBeVisible();
});

test("an uncertain save and repeated submit reuse the request rather than create a second lead", async ({ page }) => {
  let posts = 0;
  const keys: string[] = [];
  await page.route("**/api/public/demo-requests", async (route) => {
    posts++;
    keys.push(route.request().postDataJSON().submissionKey);
    const response = await route.fetch();
    // The server saved it, but the visitor did not receive confirmation on the first attempt.
    if (posts === 1) await route.fulfill({ status: 503, json: { message: "Controlled lost confirmation" } });
    else await route.fulfill({ response });
  });
  await page.goto("/");
  const form = page.getByRole("form", { name: "Save a pilot request" });
  await form.getByLabel("Your name").fill("Synthetic Retry");
  await form.getByLabel("Email", { exact: true }).fill("retry@example.com");
  await form.getByLabel("Company", { exact: true }).fill("Synthetic Retry Provider");
  await form.evaluate((el: HTMLFormElement) => { el.requestSubmit(); el.requestSubmit(); });
  await expect(form.getByRole("alert")).toContainText("could not confirm whether your request saved");
  expect(posts).toBe(1);
  await form.getByRole("button", { name: "Save pilot request" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your request is saved" })).toContainText("no duplicate request was created");
  expect(posts).toBe(2);
  expect(keys[0]).toBe(keys[1]);
  const signedIn = await page.request.post("/api/admin/auth/login", { data: { email: "admin@example.com", password: "aerowise-dev" } });
  expect(signedIn.ok()).toBe(true);
  const leads = await (await page.request.get("/api/admin/demo-requests")).json();
  expect(leads.items.filter((r: { company: string }) => r.company === "Synthetic Retry Provider")).toHaveLength(1);
});

test("stalled overview and failed demo checks provide bounded recovery and a known entry", async ({ page }) => {
  await page.route("**/api/public/overview", () => {});
  await page.route("**/api/app-info", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByText(/Demo availability could not be checked/)).toBeVisible();
  await expect(page.getByTestId("try-demo")).toHaveAttribute("href", "https://staging.deshain.com/demo");
  await expect(page.getByText(/^Pricing is temporarily unavailable/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Retry pricing", exact: true })).toBeVisible();
});

test("share metadata is public, truthful and private routes remain noindex", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://staging.deshain.com/");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", "https://staging.deshain.com/marketing/office-due.png");
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", /Early-access.*fictional demo/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await page.goto("/login");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
});
