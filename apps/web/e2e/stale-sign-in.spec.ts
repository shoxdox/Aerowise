import { expect, test, type Page } from "@playwright/test";

// Phone test of October 12, finding 1: on an Android phone, signing in as another person, signing
// out, signing back in and swiping back to the sign-in page and forward again left the technician
// app saying "Sign in again to send your changes" under a valid session, and "Try now" did nothing.

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"], serviceWorkers: "allow" });

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login?next=/tech");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/tech");
}

async function signOut(page: Page) {
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login**");
}

test("a valid session after signing out, in and swiping back and forward never asks to sign in again", async ({ page, browser }) => {
  // A second technician, the phone test's "Andy" (here the one without stops).
  const office = (await browser.newContext()).request;
  expect((await office.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  const email = `stale.${Date.now()}@example.com`;
  const sent = await office.post("/api/invitations", { data: { email, name: "Sam Second", role: "technician" } });
  expect(sent.status()).toBe(201);
  const token = new URL(((await sent.json()) as { url: string }).url).pathname.split("/").pop()!;
  const joiner = (await browser.newContext()).request;
  expect((await joiner.post(`/api/invitations/accept/${token}`, { data: { name: "Sam Second", password: "sam-secret-12" } })).ok()).toBe(true);

  // Tess starts a stop; the change reaches the office.
  await signIn(page, "tech@example.com", "aerowise-dev");
  const card = page.locator(".stop-card", { hasText: "To do" }).first();
  await card.click();
  await page.getByRole("button", { name: "Arrive and start inspection" }).click();
  await expect(page.getByRole("group", { name: "Aerator" })).toBeVisible();
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");

  // The phone is signed in as someone else (as the demo link did), then signed out of that.
  await signIn(page, email, "sam-secret-12");
  await signOut(page);
  // Back in as Tess, then swipe back to the sign-in page and forward to the app.
  await signIn(page, "tech@example.com", "aerowise-dev");
  await expect(page.locator(".tech-bar")).toContainText("Tess Tech");
  await page.goBack();
  await page.waitForURL("**/login**");
  await page.goForward();
  await page.waitForURL("**/tech");
  await expect(page.locator(".tech-bar")).toContainText("Tess Tech");
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
  await expect(page.getByText("Sign in again to send your changes")).toHaveCount(0);

  // A change made now sends.
  await page.locator(".stop-card", { hasText: "In progress" }).first().click();
  await page.getByRole("button", { name: /Continue inspection/ }).click();
  await page.getByRole("group", { name: "Aerator" }).getByRole("button", { name: "Fail", exact: true }).click();
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
  await expect(page.getByText("Sign in again to send your changes")).toHaveCount(0);
});

test("a sign-in banner left by a refused send clears when the page is shown again with a valid session, and Try now sends", async ({ page, context }) => {
  await signIn(page, "tech@example.com", "aerowise-dev");
  const card = page.locator(".stop-card", { hasText: "To do" }).first();
  await card.click();
  await page.getByRole("button", { name: "Arrive and start inspection" }).click();
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");

  // The session is refused once (as from the previous sign-in) while a change is saved.
  let refuse = true;
  await context.route("**/api/inspections/sync", (route) => (refuse ? route.fulfill({ status: 401, body: "{}" }) : route.continue()));
  await page.getByRole("group", { name: "Aerator" }).getByRole("button", { name: "Fail", exact: true }).click();
  await expect(page.getByText("Sign in again to send your changes")).toBeVisible();
  await expect(page.getByTestId("sync-status")).toContainText("1 change waiting to send");
  refuse = false;

  // Try now checks the sign-in again and sends.
  await page.getByRole("button", { name: "Try now" }).click();
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
  await expect(page.getByText("Sign in again to send your changes")).toHaveCount(0);

  // Same refusal, then the page is hidden and shown again (a swipe away and back): it clears by itself.
  refuse = true;
  await page.getByRole("group", { name: "Aerator" }).getByRole("button", { name: "Pass", exact: true }).click();
  await expect(page.getByText("Sign in again to send your changes")).toBeVisible();
  refuse = false;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByTestId("sync-status")).toHaveText("All changes sent");
  await expect(page.getByText("Sign in again to send your changes")).toHaveCount(0);
});
