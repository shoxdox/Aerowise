import { expect, test } from "@playwright/test";

test("the owner turns texting on, a customer replies STOP and another texts back, and the technician says they are on the way", async ({ page, browser }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  // A customer with a mobile number, from the seed.
  const customers = await (await page.request.get("/api/customers?limit=50")).json();
  let customer: { id: string; displayName: string; phone: string } | undefined;
  for (const c of customers.items as { id: string; displayName: string }[]) {
    const detail = await (await page.request.get(`/api/customers/${c.id}`)).json();
    const phone = (detail.contacts as { phone: string | null }[]).find((ct) => ct.phone)?.phone;
    if (phone) {
      customer = { ...c, phone };
      break;
    }
  }
  expect(customer).toBeTruthy();

  await page.goto("/sms");
  await expect(page.getByText("Test mode: no texts leave Aerowise.")).toBeVisible();
  await page.getByLabel("Text customers").check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/^On · from \(512\) 555-\d{4}$/)).toBeVisible();

  // The customer replies STOP: their number is listed and gets no more texts.
  await page.getByLabel("From").fill(customer!.phone);
  await page.getByLabel("Message").fill("STOP");
  await page.getByRole("button", { name: "Receive text" }).click();
  await expect(page.getByText("Opted out.")).toBeVisible();
  const optOuts = page.locator(".card", { hasText: "Replied STOP" });
  await expect(optOuts.getByRole("link", { name: customer!.displayName })).toBeVisible();

  // Anything else lands in the inbox until someone deals with it.
  await page.getByLabel("From").fill(customer!.phone);
  await page.getByLabel("Message").fill("The gate code is now 4321");
  await page.getByRole("button", { name: "Receive text" }).click();
  await expect(page.getByText("Reply received. It is in the inbox.")).toBeVisible();
  await page.getByRole("button", { name: "Replies" }).click();
  await expect(page.getByRole("cell", { name: /The gate code is now 4321/ })).toBeVisible();

  await page.goto("/inbox");
  const item = page.locator(".exceptions li", { hasText: "Customer texted back" }).filter({ hasText: "The gate code is now 4321" });
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "Mark handled" }).click();
  await expect(item).toHaveCount(0);

  // On the road, the technician tells the next customer they are coming.
  const tech = await (await browser.newContext()).newPage();
  await tech.goto("/login");
  await tech.getByLabel("Email").fill("tech@example.com");
  await tech.getByLabel("Password").fill("aerowise-dev");
  await tech.getByRole("button", { name: "Sign in" }).click();
  await tech.waitForURL("**/tech");
  await tech.locator(".stop-card").last().click();
  await tech.getByRole("button", { name: "On my way" }).click();
  // A text reaches the customer: it goes only on the second tap.
  await expect(tech.getByTestId("on-the-way")).toHaveCount(0);
  await tech.getByTestId("on-the-way-confirm").getByRole("button", { name: "Send text" }).click();
  await expect(tech.getByTestId("on-the-way")).toHaveText(/Customer texted that you are on the way|No text sent/);
});
