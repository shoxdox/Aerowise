import { expect, test } from "@playwright/test";

test("a platform admin creates an organization in /admin, and the office sign-in cannot get there", async ({ page }) => {
  // Office staff are sent to the console's own sign-in, and their password does not work there.
  await page.goto("/admin");
  await page.waitForURL("**/admin/login?next=%2Fadmin");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Email or password is incorrect")).toBeVisible();

  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Organizations" })).toBeVisible();
  // The seeded demo company, with its contracts and three users.
  const demo = page.getByRole("row", { name: /Hill Country Aerobic Services/ });
  await expect(demo).toBeVisible();
  await expect(demo.getByRole("cell").nth(2)).toHaveText("3");

  await page.getByRole("button", { name: "New organization" }).click();
  await page.getByLabel("Company name").fill("Brazos Aerobic Co");
  await page.getByLabel("Office phone").fill("(979) 555-0100");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("status")).toHaveText("Created Brazos Aerobic Co.");
  const row = page.getByRole("row", { name: /Brazos Aerobic Co/ });
  await expect(row.getByRole("cell").nth(1)).toHaveText("0");
  await expect(row.getByRole("cell").nth(3)).toHaveText("Never");
  // New companies start on the configured free trial.
  await expect(row.getByRole("cell").nth(6)).toHaveText(/^Trial until .* \(30 days left\)$/);

  // The founder gives them a founder price, then their plan lapses to read-only.
  await page.getByRole("button", { name: "Edit plan for Brazos Aerobic Co" }).click();
  const editor = page.getByRole("form", { name: "Plan for Brazos Aerobic Co" });
  await editor.getByLabel("Founder price per active contract ($/month)").fill("1.00");
  await editor.getByLabel("State").selectOption("read_only");
  await editor.getByLabel("Ends on").fill("");
  // And Aerowise takes 2.5% of the payments their homeowners make online.
  await editor.getByLabel("Platform fee on homeowner payments (%)").fill("2.5");
  await editor.getByRole("button", { name: "Save plan" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved the plan for Brazos Aerobic Co.");
  await expect(row.getByRole("cell").nth(6)).toHaveText("Read-only");
  await expect(row.getByRole("cell").nth(7)).toHaveText("$1.00/contract, $99.00 min (founder); 2.5% fee on payments");

  // The company asks for its data to be deleted: the name has to be typed to confirm.
  await page.getByRole("button", { name: "Delete the data of Brazos Aerobic Co" }).click();
  const erase = page.getByRole("form", { name: "Delete the data of Brazos Aerobic Co" });
  await expect(erase.getByText("It cannot be undone")).toBeVisible();
  await erase.getByLabel(/to confirm/).fill("Brazos");
  await expect(erase.getByRole("button", { name: "Delete all data" })).toBeDisabled();
  await erase.getByLabel(/to confirm/).fill("Brazos Aerobic Co");
  await erase.getByRole("button", { name: "Delete all data" }).click();
  await expect(page.getByRole("status")).toHaveText(/^Deleted the data of Brazos Aerobic Co: \d+ records, 0 users and 0 files\.$/);
  await expect(row.getByText(/^Data deleted /)).toBeVisible();
  await expect(row.getByRole("button", { name: "Edit plan for Brazos Aerobic Co" })).toHaveCount(0);

  // Coverage: every authority, its status and open questions, and the sites using it.
  await page.getByRole("link", { name: "Rulesets" }).click();
  await expect(page.getByRole("heading", { name: "Ruleset coverage" })).toBeVisible();
  const lcra = page.getByRole("row").filter({ hasText: "tx-lcra-ossf" });
  await expect(lcra.getByText("Draft", { exact: true })).toBeVisible();
  await expect(lcra.getByText(/^\d+ open$/)).toBeVisible();
  await expect(lcra.getByText("Nothing recorded with the authority yet")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "tx-example-county" }).getByText("Example rules")).toBeVisible();

  // Evidence: a provider's accepted report answers an open question, which stays open.
  await lcra.getByRole("link", { name: /Lower Colorado River Authority/ }).click();
  const acceptance = page.getByRole("region", { name: "Acceptance questions" });
  await expect(acceptance.getByRole("row", { name: /Signature/ }).getByText("Open")).toBeVisible();
  const record = page.getByRole("form", { name: "Record evidence" });
  await record.getByRole("combobox", { name: "Kind", exact: true }).selectOption("accepted_report");
  await record.getByRole("textbox", { name: "Date", exact: true }).fill("2026-01-15");
  await record.getByLabel("Authority or company they speak for").fill("Example Aerobic Services (fictional)");
  await record.getByLabel(/Where it is kept/).fill("lcra-report-2026-01.pdf and LCRA's reply");
  await record.getByLabel("Question, exactly as asked or read").fill("Was the emailed cover sheet accepted?");
  const firstOpen = record.getByRole("combobox", { name: "Open question it answers" }).locator("option").nth(1);
  await record.getByRole("combobox", { name: "Open question it answers" }).selectOption({ index: 1 });
  expect(await firstOpen.textContent()).toMatch(/cover sheet/);
  await record.getByRole("combobox", { name: "Topic", exact: true }).selectOption("receipt_acceptance");
  await record.getByRole("combobox", { name: "Outcome", exact: true }).selectOption("confirms");
  await record.getByLabel("Answer", { exact: true }).fill("LCRA replied 'received' to the provider.");
  await record.getByRole("button", { name: "Save evidence" }).click();
  const open = page.getByRole("region", { name: "Open questions" }).getByRole("article").first();
  await expect(open.getByText("Provider evidence only")).toBeVisible();
  await expect(acceptance.getByRole("row", { name: /Receipt and acceptance/ }).getByText("Provider evidence only")).toBeVisible();

  // Using it in the next version keeps the question open and the profile a draft.
  await open.getByLabel("Use in the next version").check();
  await page.getByRole("button", { name: "Prepare v2" }).click();
  const proposal = page.getByRole("region", { name: "Proposed version" });
  await expect(proposal.getByText("Stays a draft")).toBeVisible();
  await expect(proposal.getByText(/does not close a question/)).toBeVisible();

  // Coverage now shows how far each filing question is confirmed: still nothing by the authority.
  await page.getByRole("link", { name: "Rulesets" }).click();
  await expect(lcra.getByText(/^Receipt and acceptance provider evidence only; where reports go, .* open$/)).toBeVisible();
});
