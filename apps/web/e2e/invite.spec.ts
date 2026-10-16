import { expect, test } from "@playwright/test";
import { local } from "./origin.ts";

test("the owner invites a technician, who sets a password from the link and lands in the tech app", async ({ page, browser }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Invite someone" }).click();
  await page.getByLabel("Email").fill("terry.tech@example.com");
  await page.getByLabel("Name").fill("Terry Tech");
  await page.getByLabel("Role").selectOption("technician");
  await page.getByRole("button", { name: "Send invitation" }).click();
  // The e2e API has no mail provider: the invitation stays in the local outbox (STG-08).
  await expect(page.getByRole("status")).toContainText("Invitation for terry.tech@example.com recorded in the test outbox; no email was delivered.");
  const link = await page.getByLabel("Invitation link").inputValue();
  await expect(page.getByRole("row", { name: /terry\.tech@example\.com/ })).toContainText("pending");

  // The technician opens the link on their own phone.
  const phone = await browser.newContext({ ...test.info().project.use });
  const tech = await phone.newPage();
  await tech.goto(local(link));
  await expect(tech.getByRole("heading", { name: "Join Hill Country Aerobic Services (demo)" })).toBeVisible();
  await expect(tech.getByLabel("Your name")).toHaveValue("Terry Tech");
  await tech.getByLabel("Choose a password").fill("terry-secret-1");
  await tech.getByLabel("Password again").fill("terry-secret-1");
  await tech.getByRole("button", { name: /^Join / }).click();
  await tech.waitForURL("**/tech");

  // The link worked once.
  await tech.goto(local(link));
  await expect(tech.getByText("This invitation was already used. Sign in instead.")).toBeVisible();
  await phone.close();

  await page.reload();
  await expect(page.getByRole("row", { name: /Terry Tech/ })).toContainText("Technician");
});
