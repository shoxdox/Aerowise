import { expect, test, type Page } from "@playwright/test";

// The end-to-end API runs with DEMO_MODE=true, like the hosted demo. Sign-ins are rate
// limited per person and most people sign in in other tests, so this one signs in as the
// office only; the offline test checks the banner in the technician app.
const banner = (page: Page) => page.getByRole("note").filter({ hasText: "Fictional demo company. Nothing is emailed, texted, filed or charged" });

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("the demo banner shows on the sign-in page and the office screens, with no shared password", async ({ page }) => {
  await page.goto("/login");
  await expect(banner(page)).toBeVisible();
  await expect(page.getByTestId("demo-start").getByRole("link", { name: "Try the demo" })).toBeVisible();
  await expect(page.getByText("aerowise-dev")).toHaveCount(0);

  await signIn(page, "office@example.com");
  await page.waitForURL("**/inbox");
  await expect(banner(page)).toBeVisible();
  await page.goto("/schedule");
  await expect(banner(page)).toBeVisible();
});
