import { expect, test } from "@playwright/test";

// Personalized prospect demos (W10.6): made in /admin, opened by the prospect from the link.
test("a platform admin makes a prospect demo and the prospect opens it from the link", async ({ page, browser }) => {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin$/);

  await page.getByRole("link", { name: "Prospect demos" }).click();
  await page.getByLabel("Prospect's company").fill("Lone Star Aerobic");
  await page.getByLabel(/Counties they work in/).fill("Travis County, Hays County");
  await page.getByRole("button", { name: "Make the demo" }).click();
  const url = await page.getByTestId("prospect-demo-link").textContent({ timeout: 60_000 });
  await expect(page.getByRole("article", { name: "Demo for Lone Star Aerobic" })).toContainText("Travis County, Hays County");

  // The prospect, in their own browser, with nobody signed in.
  const prospect = await (await browser.newContext()).newPage();
  await prospect.goto(new URL(url!).pathname + new URL(url!).hash);
  await prospect.waitForURL("**/inbox");
  await expect(prospect.getByRole("note").filter({ hasText: "Fictional demo company" })).toBeVisible();
  const me = await (await prospect.request.get("/api/auth/me")).json();
  expect(me.organization.name).toBe("Lone Star Aerobic (demo)");
  expect(me.role).toBe("owner");
});
