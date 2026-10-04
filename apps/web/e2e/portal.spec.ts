import { expect, test } from "@playwright/test";

test("the office shares a portal link and the homeowner sees their account and asks for service", async ({ page, browser }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  // A customer with a plan and an email on file.
  const due = await (await page.request.get("/api/obligations/due?limit=50")).json();
  let customer: { id: string; displayName: string } | undefined;
  for (const o of due.items as { customer: { id: string; displayName: string } }[]) {
    const access = await (await page.request.get(`/api/customers/${o.customer.id}/portal`)).json();
    if (access.email) {
      customer = o.customer;
      break;
    }
  }
  expect(customer).toBeTruthy();

  await page.goto(`/customers/${customer!.id}`);
  await page.getByRole("button", { name: "Copy portal link" }).click();
  const url = (await page.locator(".portal-url").textContent())!;
  expect(url).toMatch(/\/portal\/[\w-]{43}$/);

  // The homeowner opens it without signing in.
  const homeowner = await (await browser.newContext()).newPage();
  await homeowner.goto(new URL(url).pathname);
  await expect(homeowner.getByRole("heading", { name: `Hello, ${customer!.displayName}` })).toBeVisible();
  await expect(homeowner.getByText("Residential annual").first()).toBeVisible();
  await expect(homeowner.getByText("Next visit").first()).toBeVisible();

  await homeowner.getByRole("button", { name: "Request service" }).first().click();
  await homeowner.getByLabel("What do you need?").selectOption("alarm");
  await homeowner.getByLabel("Tell us more").fill("The red light is on and it beeps at night.");
  await homeowner.getByRole("button", { name: "Send request" }).click();
  await expect(homeowner.getByText("Thanks, we have your request")).toBeVisible();
  await expect(homeowner.getByText("Received")).toBeVisible();

  // The office sees it in the inbox and closes it there.
  await page.goto("/inbox");
  const item = page.locator(".exceptions li", { hasText: "Customer asked for service: alarm is going off" }).filter({ hasText: customer!.displayName });
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "Resolve" }).click();
  await item.getByLabel("Resolution").fill("Reset the alarm over the phone");
  await item.getByRole("button", { name: "Save" }).click();
  await expect(item).toHaveCount(0);

  await homeowner.reload();
  await expect(homeowner.getByText("Reset the alarm over the phone")).toBeVisible();

  // Anyone can ask for a link by email; the answer never says whether the address is known.
  await homeowner.goto("/portal");
  await homeowner.getByLabel("Email").fill("someone@example.com");
  await homeowner.getByRole("button", { name: "Email me a link" }).click();
  await expect(homeowner.getByText(/If someone@example.com is on file/)).toBeVisible();
});
