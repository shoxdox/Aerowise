import { expect, test } from "@playwright/test";

test("a new company owner reads and accepts the terms and privacy policy before using the office", async ({ page, browser }) => {
  // The terms and privacy pages are public and show the version an owner accepts.
  await page.goto("/");
  await page.getByRole("link", { name: "Terms of service" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Terms of service" })).toBeVisible();
  await expect(page.getByText(/^Version /)).toBeVisible();
  await expect(page.getByText(/^Early-access draft prepared for owner and counsel review/)).toBeVisible();
  await expect(page.getByText("2026-10-05-placeholder")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Exports, operational deletion and retained copies" })).toBeVisible();
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Prospect requests and public use" })).toBeVisible();

  // The founder creates a company and invites its first owner, the usual way a design
  // partner starts. (Signing in through /admin keeps the office sign-in limit free for
  // the other tests that use the seeded owner.)
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin$/);
  await page.getByRole("button", { name: "New organization" }).click();
  await page.getByLabel("Company name").fill("Pecos Aerobic Co");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("status")).toHaveText("Created Pecos Aerobic Co.");
  await page.getByRole("row", { name: /Pecos Aerobic Co/ }).getByRole("button", { name: "Invite owner" }).click();
  await page.getByLabel("Owner email").fill("oscar.owner@example.com");
  await page.getByLabel("Owner name").fill("Oscar Owner");
  await page.getByRole("button", { name: "Send owner invitation" }).click();
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
