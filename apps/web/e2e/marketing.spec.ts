import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const RULESETS = fileURLToPath(new URL("../../../packages/compliance/rulesets", import.meta.url));
const authorities = readdirSync(RULESETS).flatMap((key) => readdirSync(join(RULESETS, key)).map((file) => JSON.parse(readFileSync(join(RULESETS, key, file), "utf8")))).filter((r) => r.profile && r.profile.status !== "fictional").map((r) => r.jurisdiction.authorityName as string);

test("the public price, every public authority and the product screenshots", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/login");
  await expect(page.locator(".price")).toContainText("$0.50");
  await expect(page.getByText("$50.00 monthly minimum", { exact: true })).toBeVisible();
  await expect(page.getByText("First 90 days free")).toBeVisible();
  await expect(page.getByText(/founder/i)).toHaveCount(0);
  const contracts = page.getByLabel("Your active contracts");
  await expect(contracts).toHaveValue("300");
  await expect(page.locator(".home-price-total")).toContainText("$150.00");
  await contracts.fill("1000");
  await expect(page.locator(".home-price-total")).toContainText("$500.00");
  await contracts.fill("40");
  await expect(page.locator(".home-price-total")).toContainText("$50.00");
  const chips = page.getByRole("list", { name: "Authorities" });
  await expect(chips.getByRole("listitem")).toHaveCount(new Set(authorities).size);
  for (const name of authorities) await expect(chips.locator(`li[title="${name}"]`)).toHaveCount(1);
  await expect(chips.getByText(/fictional/i)).toHaveCount(0);
  for (const label of ["LCRA", "SJRA", "City of Denton", "Denton County", "Williamson County"]) await expect(chips.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByText(`built in for ${new Set(authorities).size} Texas authorities`, { exact: false })).toBeVisible();
  for (const img of await page.locator(".home img").all()) {
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  }
  await page.getByRole("link", { name: "How we handle your data" }).click();
  await expect(page.getByRole("heading", { name: "Deleting your data" })).toBeVisible();
  await expect(page.getByText(/tombstone/)).toBeVisible();
});

test("a walkthrough request is confirmed to the visitor and actionable in admin", async ({ page }) => {
  await page.goto("/");
  const form = page.getByRole("form", { name: "Request a walkthrough" });
  await form.getByLabel("Your name").fill("Pat Rivera");
  await form.getByLabel("Email", { exact: true }).fill("pat@example.com");
  await form.getByLabel("Company", { exact: true }).fill("Rivera Aerobic Service");
  await form.getByLabel("Counties you work in (optional)").fill("Travis, Williamson");
  await form.getByRole("button", { name: "Request a walkthrough" }).click();
  const saved = page.getByRole("status").filter({ hasText: "Thanks, we have your request." });
  await expect(saved).toContainText("We'll reply to pat@example.com");
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

test("a slow then failed overview keeps the demo and contact usable and retries", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/public/overview", async (route) => { await delayed; await route.fulfill({ status: 503, json: { message: "Controlled unavailable" } }); });
  await page.goto("/");
  await expect(page.getByTestId("try-demo")).toBeVisible();
  await expect(page.getByRole("link", { name: "justin@deshain.com" })).toHaveAttribute("href", "mailto:justin@deshain.com");
  await expect(page.getByRole("form", { name: "Request a walkthrough" })).toBeVisible();
  release();
  await expect(page.getByText("Couldn't load pricing.")).toBeVisible();
  await expect(page.getByText("Couldn't load the list of authorities.")).toBeVisible();
  await expect(page.locator(".price")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("homepage-load-failure.png"), fullPage: true });
  await page.unroute("**/api/public/overview");
  await page.locator("#pricing").getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".price")).toContainText("$0.50");
  await expect(page.getByRole("list", { name: "Authorities" })).toBeVisible();
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
  const form = page.getByRole("form", { name: "Request a walkthrough" });
  await form.getByLabel("Your name").fill("Synthetic Retry");
  await form.getByLabel("Email", { exact: true }).fill("retry@example.com");
  await form.getByLabel("Company", { exact: true }).fill("Synthetic Retry Provider");
  await form.evaluate((el: HTMLFormElement) => { el.requestSubmit(); el.requestSubmit(); });
  await expect(form.getByRole("alert")).toContainText("We couldn't send your request");
  expect(posts).toBe(1);
  const retained = await page.evaluate(() => sessionStorage.getItem("aerowise.pilotRequestAttempt.v1"));
  expect(Object.keys(JSON.parse(retained!)).sort()).toEqual(["fingerprint", "key"]);
  expect(retained).not.toContain("retry@example.com");
  expect(retained).not.toContain("Synthetic Retry");
  await page.reload(); // Ordinary recovery after the saved request's confirmation was lost.
  await form.getByLabel("Your name").fill("Synthetic Retry");
  await form.getByLabel("Email", { exact: true }).fill("retry@example.com");
  await form.getByLabel("Company", { exact: true }).fill("Synthetic Retry Provider");
  await form.getByRole("button", { name: "Request a walkthrough" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Thanks, we have your request." })).toContainText("We already had this one");
  expect(posts).toBe(2);
  expect(keys[0]).toBe(keys[1]);
  const signedIn = await page.request.post("/api/admin/auth/login", { data: { email: "admin@example.com", password: "aerowise-dev" } });
  expect(signedIn.ok()).toBe(true);
  const leads = await (await page.request.get("/api/admin/demo-requests")).json();
  expect(leads.items.filter((r: { company: string }) => r.company === "Synthetic Retry Provider")).toHaveLength(1);
  await page.getByRole("button", { name: "Send another request" }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("aerowise.pilotRequestAttempt.v1"))).toBeNull();
});

test("a stalled overview and failed demo check still give a known demo entry and a retry", async ({ page }) => {
  await page.route("**/api/public/overview", () => {});
  await page.route("**/api/app-info", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByTestId("try-demo")).toHaveAttribute("href", "https://staging.deshain.com/demo");
  await expect(page.getByText("Couldn't load pricing.")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#pricing").getByRole("button", { name: "Try again" })).toBeVisible();
});

test("share metadata is public, truthful and private routes remain noindex", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://staging.deshain.com");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", "https://staging.deshain.com/marketing/due-list.jpg");
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", /Try the demo, no sign-up/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await page.goto("/login");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
});
