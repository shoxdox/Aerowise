import { expect, test } from "@playwright/test";

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"], serviceWorkers: "allow" });

/**
 * One bar of signal: requests neither fail nor answer. The app must not sit on "Loading your
 * route…" for as long as the phone keeps the socket open; after its own timeouts it opens
 * the copy saved on the phone, as it does with no signal at all.
 */
test("a connection that answers nothing opens the saved route after a short wait", async ({ page, context }) => {
  // Morning, with signal: sign in and open the route so the phone saves it and the app shell.
  await page.goto("/login");
  await page.getByLabel("Email").fill("tech@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/tech");
  await expect(page.locator(".stop-card").first()).toBeVisible();
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(async () => (await (await caches.open("aerowise-shell-v1")).keys()).length > 5);

  // Now every request hangs forever.
  await context.route("**/*", () => new Promise<void>(() => {}));
  const started = Date.now();
  await page.reload({ waitUntil: "commit" }).catch(() => {});
  await expect(page.locator(".stop-card").first()).toBeVisible({ timeout: 60_000 });
  const waited = Date.now() - started;
  expect(waited, "the saved route opened within the app's own timeouts").toBeLessThan(45_000);
  await expect(page.getByTestId("sync-status")).not.toHaveText(/Sending/);
});
