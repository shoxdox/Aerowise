import { expect, test } from "@playwright/test";

// "Try the demo" (W10.2): from the sign-in page to a demo company of the visitor's own,
// signed in as its owner with no password, then looking around as the technician.
test("a visitor starts their own demo company and lands in the owner's inbox", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("demo-start").getByRole("link", { name: "Try the demo" }).click();
  await page.waitForURL("**/demo");
  await page.getByRole("button", { name: "Start my demo" }).click();
  await page.waitForURL("**/inbox", { timeout: 60_000 });

  const me = await (await page.request.get("/api/auth/me")).json();
  expect(me.role).toBe("owner");
  expect(me.organization.name).toBe("Hill Country Aerobic Services (your demo)");
  expect(me.user.email).toMatch(/@demo\.example\.com$/);

  await page.getByRole("note").getByRole("button", { name: "Technician" }).click();
  await page.waitForURL("**/tech**");
  expect((await (await page.request.get("/api/auth/me")).json()).role).toBe("technician");
});

// The known public staging entry stays available; a confirmed demo deployment uses its own entry.
test("the marketing page links to its local demo on the demo deployment", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("try-demo")).toHaveAttribute("href", "/demo");
  await page.getByTestId("try-demo").click();
  await page.waitForURL("**/demo");
  await expect(page.getByRole("button", { name: "Start my demo" })).toBeVisible();
});

test("the marketing page labels the known staging demo off the demo deployment", async ({ page }) => {
  await page.route("**/api/app-info", (route) => route.fulfill({ json: { demo: false, demoCompany: false, demoVisitor: false } }));
  const answered = page.waitForResponse("**/api/app-info");
  await page.goto("/");
  await answered;
  await expect(page.getByTestId("try-demo")).toHaveAttribute("href", "https://staging.deshain.com/demo");
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/login");
  await expect(page.getByText(/The public demo is on staging.deshain.com/)).toBeVisible();
});
