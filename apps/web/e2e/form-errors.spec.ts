import { expect, test, type Page } from "@playwright/test";

// What the office sees when something goes wrong: the field a save was refused for, a record
// that is not there, an address that is not Aerowise's, an API that cannot be reached, and a
// double click that must not make two of anything.

async function signIn(page: Page, email = "office@example.com") {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/inbox");
}

test("a refused save names the field, and a missing record or address says so with a way back", async ({ page }) => {
  await signIn(page);
  await page.goto("/customers");
  await page.getByRole("button", { name: "New customer" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Form errors TEST");
  await page.getByLabel("Service address").fill("1 Fictional Ln");
  await page.getByLabel("City").fill("Austin");
  await page.getByLabel("ZIP").fill("786");
  await page.getByRole("button", { name: "Create customer" }).click();
  const alert = page.locator("main").getByRole("alert");
  await expect(alert).toContainText("ZIP");
  await expect(alert).not.toContainText("Request failed validation");
  // A refused form saved nothing, so there is nothing to go and check.
  await expect(page.getByRole("link", { name: /check whether it was saved/ })).toHaveCount(0);

  await page.goto("/customers/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { name: "Customer not found" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  await page.getByRole("link", { name: "← Back to Customers" }).click();
  await page.waitForURL(/\/customers$/);

  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to the office" })).toBeVisible();
});

test("when the sign-in check cannot be answered, the office says so and recovers on Try again", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/auth/me", (route) => route.fulfill({ status: 503, json: { error: "unavailable", message: "Deploying" } }));
  await page.goto("/customers");
  await expect(page.getByRole("heading", { name: "Could not reach Aerowise" })).toBeVisible();
  await page.unroute("**/api/auth/me");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
});

test("a double click on Create work order makes one work order", async ({ page }) => {
  await signIn(page);
  const site = (await (await page.request.get("/api/sites?limit=1")).json()).items[0] as { id: string };
  const title = `Double click TEST ${Date.now()}`;
  await page.goto(`/work/new?siteId=${site.id}`);
  await page.getByRole("textbox", { name: /^Title/ }).fill(title);
  await page.getByRole("button", { name: "Create work order" }).dblclick();
  await page.waitForURL(/\/work\/[0-9a-f-]{36}$/);
  const orders = (await (await page.request.get(`/api/work-orders?siteId=${site.id}&limit=50`)).json()).items as { title: string }[];
  expect(orders.filter((o) => o.title === title)).toHaveLength(1);
});
