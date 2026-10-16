import { expect, test, type Page } from "@playwright/test";

// SW-3: the e2e API runs with AEROWISE_FEATURES=work_orders,service_items (playwright.config.ts).

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");
}

test("the office adds a service item, bills a work order by the hour from it, and gets one invoice", async ({ page }) => {
  await signIn(page);
  // The settings index lists the catalog once the deployment says service items are on.
  await page.goto("/settings");
  await expect(page.getByTestId("settings-list").locator('a[href="/settings/service-items"]')).toHaveCount(1);
  // Earlier specs may have reset the demo company, so this does not rely on the story's catalog.
  await page.goto("/settings/service-items");
  await page.getByLabel("Name").fill("Diagnostic hour");
  await page.getByLabel("Price ($)").fill("110");
  await page.getByLabel("Charged").selectOption({ label: "per hour" });
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByTestId("service-items")).toContainText("Diagnostic hour");
  await expect(page.getByTestId("service-items")).toContainText("$110.00 per hour");

  const sites = await (await page.request.get("/api/sites?limit=1")).json();
  await page.goto(`/work/new?siteId=${sites.items[0].id}`);
  await page.getByRole("combobox", { name: "Kind of work" }).selectOption({ label: "Repair" });
  await page.getByRole("textbox", { name: /^Title/ }).fill("Find the alarm fault");
  await page.getByRole("combobox", { name: "Service item" }).selectOption({ label: "Diagnostic hour ($110.00 per hour)" });
  await page.getByLabel("Quantity").fill("1.25");
  await page.getByRole("button", { name: "Create work order" }).click();
  await page.waitForURL(/\/work\/[0-9a-f-]{36}$/);
  const workOrderId = page.url().split("/").pop()!;
  // 1.25 hours at $110.00.
  await expect(page.getByText("$137.50").first()).toBeVisible();

  const { today } = await (await page.request.get("/api/obligations/due?limit=1")).json();
  await page.getByLabel("Visit date").fill(today);
  await page.getByRole("button", { name: "Schedule visit" }).click();
  await expect(page.getByTestId("work-status")).toHaveText("Scheduled");
  await page.getByRole("button", { name: "Complete without a field record" }).click();
  await page.getByLabel(/How was it done/).fill("TEST paper ticket");
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(page.getByTestId("work-status")).toHaveText("Completed");

  await page.getByRole("button", { name: "Create invoice" }).click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
  const invoiceId = page.url().split("/").pop()!;
  await expect(page.getByText("$137.50").first()).toBeVisible();
  const invoice = await (await page.request.get(`/api/invoices/${invoiceId}`)).json();
  expect(invoice.lines).toEqual([expect.objectContaining({ description: "Diagnostic hour", quantity: 1.25, quantityMilli: 1250, amountCents: 13750 })]);

  // The order is invoiced; asking again finds the same draft.
  await page.goto(`/work/${workOrderId}`);
  await expect(page.getByRole("button", { name: "Create invoice" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Draft invoice · \$137\.50/ })).toBeVisible();
  const again = await page.request.post(`/api/work-orders/${workOrderId}/invoice`, { data: {} });
  expect(again.status()).toBe(200);
  expect((await again.json()).invoiceId).toBe(invoiceId);
});

test("with service items switched off, the office still saves a draft that has a fraction, and a new line takes whole units only", async ({ page }) => {
  await signIn(page);
  const customers = await (await page.request.get("/api/customers?limit=1")).json();
  const draft = await (
    await page.request.post("/api/invoices", { data: { customerId: customers.items[0].id, lines: [{ description: "Labor (TEST)", quantity: 1.5, unitPriceCents: 9500 }] } })
  ).json();
  // The browser sees a deployment with service items off (the office reads its features from the session).
  for (const path of ["**/api/app-info", "**/api/auth/me"]) {
    await page.route(path, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, features: (body.features as string[]).filter((f) => f !== "service_items") } });
    });
  }
  const sent: { lines: { id?: string; quantity: number; unitPriceCents: number }[] }[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().endsWith(`/api/invoices/${draft.id}`)) sent.push(r.postDataJSON());
  });

  await page.goto(`/invoices/${draft.id}`);
  await expect(page.getByLabel("Quantity").first()).toHaveValue("1.5");
  await page.getByLabel("Price").first().fill("100.00");
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByLabel("Description").nth(1).fill("Filter (TEST)");
  await page.getByLabel("Price").nth(1).fill("12.50");
  // A new line takes whole units only: the form will not send a fraction for it.
  await page.getByLabel("Quantity").nth(1).fill("2.5");
  await page.getByRole("button", { name: "Save draft" }).click();
  expect(await page.getByLabel("Quantity").nth(1).evaluate((el: HTMLInputElement) => el.validity.stepMismatch)).toBe(true);
  expect(sent).toHaveLength(0);
  await page.getByLabel("Quantity").nth(1).fill("2");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect.poll(() => sent.length).toBe(1);
  // The fraction goes back unchanged with its line's id, which the API accepts with the flag off.
  expect(sent[0]!.lines).toEqual([
    expect.objectContaining({ id: draft.lines[0].id, quantity: 1.5, unitPriceCents: 10000 }),
    expect.objectContaining({ quantity: 2, unitPriceCents: 1250 }),
  ]);
  await expect(page.getByText("$175.00").first()).toBeVisible();
});
