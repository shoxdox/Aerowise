import { expect, test, type Page } from "@playwright/test";

// First-run intros (W10.4): shown once, closed and reopened, kept on the person's account.
async function signIn(page: Page, email: string, lands: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`**${lands}`);
}

test("the office intro shows until the owner closes it, and opens again from the same place", async ({ page, browser }) => {
  await signIn(page, "owner@example.com", "/inbox");
  const intro = page.getByTestId("intro-office");
  await expect(intro.getByRole("heading", { name: "How Aerowise runs the work" })).toBeVisible();
  await intro.getByRole("button", { name: "Got it" }).click();
  await expect(intro).toBeHidden();

  // Closed for this person on another device too.
  await page.reload();
  await expect(page.getByRole("button", { name: "Show the introduction" })).toBeVisible();
  await expect(intro).toBeHidden();

  // The office manager has their own.
  const office = await (await browser.newContext()).newPage();
  await signIn(office, "office@example.com", "/inbox");
  await expect(office.getByTestId("intro-office")).toBeVisible();

  await page.getByRole("button", { name: "Show the introduction" }).click();
  await expect(intro).toBeVisible();
  await page.reload();
  await expect(intro).toBeVisible();
});

test("the technician intro shows on the route until closed", async ({ page }) => {
  await signIn(page, "tech@example.com", "/tech");
  const intro = page.getByTestId("intro-technician");
  await expect(intro.getByRole("heading", { name: "Your day in Aerowise" })).toBeVisible();
  await intro.getByRole("button", { name: "Got it" }).click();
  await expect(intro).toBeHidden();
  await expect.poll(async () => (await (await page.request.get("/api/auth/me")).json()).introsDismissed).toEqual(["technician"]);
  await page.reload();
  await expect(page.locator(".stop-card").first()).toBeVisible();
  await expect(intro).toBeHidden();
});
