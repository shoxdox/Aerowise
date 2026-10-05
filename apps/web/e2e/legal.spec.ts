import { expect, test } from "@playwright/test";

test("a new owner reads and accepts the terms and privacy policy before using the office", async ({ page, browser }) => {
  // The terms and privacy pages are public and show the version an owner accepts.
  await page.goto("/");
  await page.getByRole("link", { name: "Terms of service" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Terms of service" })).toBeVisible();
  await expect(page.getByText(/^Version /)).toBeVisible();
  await expect(page.getByText(/^Placeholder text\./)).toBeVisible();
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();

  // The seeded owner has accepted already and invites a second owner.
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Invite someone" }).click();
  await page.getByLabel("Email").fill("oscar.owner@example.com");
  await page.getByLabel("Name").fill("Oscar Owner");
  await page.getByLabel("Role").selectOption("owner");
  await page.getByRole("button", { name: "Send invitation" }).click();
  const link = await page.getByLabel("Invitation link").inputValue();

  const other = await browser.newContext({ ...test.info().project.use });
  const owner = await other.newPage();
  await owner.goto(link.replace(/^https?:\/\/[^/]+/, "http://localhost:3000"));
  await owner.getByLabel("Choose a password").fill("oscar-secret-1");
  await owner.getByLabel("Password again").fill("oscar-secret-1");
  await owner.getByRole("button", { name: /^Join / }).click();
  await owner.waitForURL("**/inbox");

  // Asked first, and nothing else shows until they accept.
  await expect(owner.getByRole("heading", { name: "Before you start" })).toBeVisible();
  await expect(owner.getByRole("link", { name: "Terms of service" })).toHaveAttribute("href", "/terms");
  const accept = owner.getByRole("button", { name: "Accept and continue" });
  await expect(accept).toBeDisabled();
  await owner.getByLabel("I have read and accept them").check();
  await accept.click();
  await expect(owner.getByRole("heading", { name: "Before you start" })).toHaveCount(0);
  await expect(owner.getByRole("heading", { level: 1 })).toBeVisible();
  await owner.reload();
  await expect(owner.getByRole("heading", { name: "Before you start" })).toHaveCount(0);
  await other.close();
});
