import { expect, test } from "@playwright/test";

test("pages and the API send security headers, and pages still work under them", async ({ page, request }) => {
  const pageRes = await request.get("/login");
  expect(pageRes.headers()).toMatchObject({
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  });
  expect(pageRes.headers()["x-powered-by"]).toBeUndefined();

  const apiRes = await request.get("/api/health");
  expect(apiRes.headers()).toMatchObject({ "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });

  // Signing in still works with the policy in place.
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
});
