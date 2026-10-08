import { expect, test, type Page } from "@playwright/test";

// SW-8 follow-up: the office builds an intake form and a plan option, takes the option on a
// contract it makes, and the homeowner answers the questions before signing the renewal.
// The e2e API runs with the plan builder on (playwright.config.ts). Fictional data only.

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");
}

test("the office adds an intake form and an option to a plan, and the homeowner answers before signing", async ({ page, browser }) => {
  await signIn(page);
  const stamp = Date.now().toString(36);
  const planName = `Intake TEST ${stamp}`;
  const plan = await (await page.request.post("/api/plans", { data: { name: planName, termMonths: 12, visitsPerTerm: 2, priceCents: 40000 } })).json();

  // The builder: an option, and a new intake form with one required yes-or-no question.
  await page.goto(`/plans/${plan.id}`);
  await page.getByRole("tab", { name: "Options" }).click();
  await page.getByRole("button", { name: "Add option" }).click();
  const option = page.getByTestId("plan-option");
  await option.getByLabel("Name").fill("Alarm battery TEST");
  await option.getByLabel("Price ($)").fill("40");
  await page.getByRole("tab", { name: "Intake questions" }).click();
  await page.getByRole("button", { name: "New intake form" }).click();
  const editor = page.getByTestId("intake-form-editor");
  await editor.getByLabel("Form name").fill(`Before you renew TEST ${stamp}`);
  await editor.getByRole("textbox", { name: "Question" }).fill("Anything changed at the property?");
  await editor.getByRole("combobox", { name: /^Answer/ }).selectOption({ label: "Yes or no" });
  await editor.getByRole("checkbox", { name: "Required" }).check();
  await editor.getByRole("button", { name: "Save form" }).click();
  await expect(page.getByRole("combobox", { name: /^Intake form/ })).toHaveValue(/[0-9a-f-]{36}/);
  await page.getByRole("button", { name: "Save as version 2" }).click();
  await expect(page.getByText("Saved as version 2.")).toBeVisible();
  await page.getByRole("tab", { name: "Preview agreement" }).click();
  await expect(page.getByTestId("agreement-preview")).toContainText("Anything changed at the property?");

  // A fictional customer; the office starts a contract eleven months ago and ticks the option.
  const customer = await (await page.request.post("/api/customers", { data: { displayName: `Intake TEST ${stamp}` } })).json();
  const site = await (await page.request.post(`/api/customers/${customer.id}/sites`, { data: { addressLine1: "7 Fictional Ct", city: "Austin" } })).json();
  await page.request.post(`/api/customers/${customer.id}/contacts`, { data: { name: "Pat Fictional", email: `pat-${stamp}@example.test`, type: "billing" } });
  const start = new Date(Date.now() - 335 * 86_400_000).toISOString().slice(0, 10);
  await page.goto(`/sites/${site.id}`);
  await page.getByRole("button", { name: "New contract" }).click();
  await page.locator("select[name=planId]").selectOption(plan.id);
  const options = page.getByTestId("contract-options");
  await expect(options).toContainText("Alarm battery TEST · $40.00");
  await options.getByRole("checkbox", { name: /Alarm battery TEST/ }).check();
  await page.locator("input[name=startOn]").fill(start);
  await page.getByRole("button", { name: "Start contract" }).click();
  const withVisits = page.getByRole("button", { name: /^Start contract (with|anyway)/ });
  const taken = page.getByTestId("contract-options-taken");
  await expect(taken.or(withVisits).first()).toBeVisible();
  if (await withVisits.isVisible()) await withVisits.click();
  await expect(taken).toContainText("Alarm battery TEST ($40.00)");

  // The renewal asks the question before it can be signed.
  const contracts = await (await page.request.get(`/api/sites/${site.id}/contracts`)).json();
  const renewal = await (await page.request.post(`/api/contracts/${contracts.items[0].id}/renewal`, { data: {} })).json();
  const homeowner = await (await browser.newContext()).newPage();
  await homeowner.goto(new URL(renewal.link).pathname);
  const intake = homeowner.getByTestId("renewal-intake");
  await expect(intake).toContainText(`Before you renew TEST ${stamp}`);
  await homeowner.getByLabel("Your full name").fill("Pat Fictional");
  await homeowner.getByRole("checkbox", { name: /I have read this agreement/ }).check();
  await homeowner.getByRole("button", { name: /^Sign/ }).click();
  await expect(homeowner.getByText("Answer the questions above before signing.")).toBeVisible();
  await intake.getByRole("group", { name: "Anything changed at the property?" }).getByRole("button", { name: "No" }).click();
  await homeowner.getByRole("button", { name: /^Sign/ }).click();
  await expect(homeowner.getByTestId("renewal-intake")).toHaveCount(0);

  // The office sees the answer with the signature.
  await page.goto(`/renewals/${renewal.id}`);
  await expect(page.getByTestId("renewal-intake-answers")).toContainText("Anything changed at the property?");
  await expect(page.getByTestId("renewal-intake-answers")).toContainText("No");
});
