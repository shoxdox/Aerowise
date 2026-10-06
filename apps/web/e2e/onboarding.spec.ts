import { expect, test, type Browser, type Page } from "@playwright/test";

const local = (link: string) => link.replace(/^https?:\/\/[^/]+/, "http://localhost:3000");

/** Opens an invitation on its own device (a fresh browser) and joins with a new password. */
async function accept(browser: Browser, link: string, password: string): Promise<Page> {
  const device = await browser.newContext({ ...test.info().project.use });
  const page = await device.newPage();
  await page.goto(local(link));
  await expect(page.getByRole("heading", { name: "Join Pecos Septic Co" })).toBeVisible();
  await page.getByLabel("Choose a password").fill(password);
  await page.getByLabel("Password again").fill(password);
  await page.getByRole("button", { name: "Join Pecos Septic Co" }).click();
  return page;
}

test("a new company is created in /admin, its owner joins and invites a technician, and support can look but not change anything", async ({ page, browser }) => {
  // Aerowise creates the company and invites its owner.
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin$/);
  await page.getByRole("button", { name: "New organization" }).click();
  await page.getByLabel("Company name").fill("Pecos Septic Co");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("status")).toHaveText("Created Pecos Septic Co.");
  const row = page.getByRole("row", { name: /Pecos Septic Co/ });
  await row.getByRole("button", { name: "Invite owner" }).click();
  await page.getByLabel("Owner email").fill("paula@pecos.example");
  await page.getByLabel("Owner name").fill("Paula Pecos");
  await page.getByRole("button", { name: "Send owner invitation" }).click();
  const ownerLink = await page.getByLabel("Invitation link").inputValue();

  // The owner joins and lands on the office home, with the first-run checklist.
  const owner = await accept(browser, ownerLink, "paula-secret-1");
  await owner.waitForURL("**/inbox");
  await expect(owner.getByRole("heading", { name: "Get set up" })).toBeVisible();
  await expect(owner.getByTestId("onboarding-technicians")).toContainText("Invite a technician");

  // The owner invites a technician, who joins on their phone and lands in the tech app.
  await owner.goto("/settings/users");
  await owner.getByRole("button", { name: "Invite someone" }).click();
  await owner.getByLabel("Email").fill("tomas@pecos.example");
  await owner.getByLabel("Name").fill("Tomas Tech");
  await owner.getByLabel("Role").selectOption("technician");
  await owner.getByRole("button", { name: "Send invitation" }).click();
  const techLink = await owner.getByLabel("Invitation link").inputValue();
  const tech = await accept(browser, techLink, "tomas-secret-1");
  await tech.waitForURL("**/tech");

  // Support opens the company read-only: it sees what the owner sees and can change nothing.
  await page.reload();
  await expect(row.getByRole("cell").nth(2)).toHaveText("2");
  await row.getByRole("button", { name: "View Pecos Septic Co read-only" }).click();
  await page.getByLabel("Reason").fill("Owner asked for a walkthrough");
  await page.getByRole("button", { name: "Open read-only" }).click();
  await page.waitForURL("**/inbox");
  await expect(page.getByTestId("support-banner")).toContainText("Aerowise support view of Pecos Septic Co");
  await page.goto("/settings/users");
  await expect(page.getByRole("row", { name: /Tomas Tech/ })).toContainText("Technician");
  await expect(page.getByRole("button", { name: "Invite someone" })).toHaveCount(0);
  const write = await page.request.post("/api/customers", { data: { displayName: "Should not exist" } });
  expect(write.status()).toBe(403);
  expect((await write.json()).error).toBe("support_read_only");

  await page.getByRole("button", { name: "End support view" }).click();
  await page.waitForURL(/\/admin$/);
  await page.goto("/inbox");
  await page.waitForURL("**/login**");
});
