import { expect, test, type Page } from "@playwright/test";

// Sending or issuing a draft acts on what is on screen: edits typed since the last save go out
// with it, never the older saved draft.

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");
}

/** A customer with an email on file, and one of their sites. */
async function emailedCustomer(page: Page) {
  const due = await (await page.request.get("/api/obligations/due?limit=50")).json();
  for (const item of due.items) {
    const customer = await (await page.request.get(`/api/customers/${item.customer.id}`)).json();
    if (customer.contacts.some((c: { email: string | null }) => c.email)) return { customerId: item.customer.id as string, siteId: item.site.id as string };
  }
  throw new Error("no customer with an email");
}

test("an estimate edited after its last save is sent at the edited price, and acceptance records the edit", async ({ page }) => {
  await signIn(page);
  const { siteId } = await emailedCustomer(page);
  await page.goto(`/estimates/new?siteId=${siteId}`);
  await page.getByRole("textbox", { name: /^Title/ }).fill("Riser lid");
  await page.getByLabel("Line 1 description").fill("Labor");
  await page.getByLabel("Line 1 unit price").fill("95");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.waitForURL(/\/estimates\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("estimate-status")).toHaveText("Draft");

  // Recording acceptance on an edited draft records the edit, not the saved draft.
  await page.getByLabel("Line 1 unit price").fill("110");
  await expect(page.getByTestId("draft-unsaved")).toBeVisible();
  await page.getByRole("button", { name: "Record acceptance" }).click();
  await expect(page.getByTestId("record-total")).toHaveText("$110.00");
  await expect(page.getByTestId("draft-unsaved")).toHaveCount(0);

  // Editing again closes that form: it would record a draft that is no longer what is on screen.
  await page.getByLabel("Line 1 unit price").fill("120");
  await expect(page.getByTestId("record-total")).toHaveCount(0);
  await page.getByRole("button", { name: /Mark sent/ }).click();
  await expect(page.getByTestId("estimate-status")).toHaveText("Sent");
  await expect(page.getByTestId("estimate-total")).toHaveText("$120.00");
  const id = page.url().split("/").pop()!;
  const sent = await (await page.request.get(`/api/estimates/${id}`)).json();
  expect(sent.versions.at(-1).lines[0].unitPriceCents).toBe(12000);
});

test("a double click on Save draft makes one estimate, and a half-typed draft can still be withdrawn", async ({ page }) => {
  await signIn(page);
  const { siteId } = await emailedCustomer(page);
  const title = `Double click TEST ${Date.now()}`;
  await page.goto(`/estimates/new?siteId=${siteId}`);
  await page.getByRole("textbox", { name: /^Title/ }).fill(title);
  await page.getByLabel("Line 1 description").fill("Labor");
  await page.getByLabel("Line 1 unit price").fill("95");
  // The button stays busy until the new estimate's page opens, so the second click sends nothing.
  await page.getByRole("button", { name: "Save draft" }).dblclick();
  await page.waitForURL(/\/estimates\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("estimate-status")).toHaveText("Draft");
  const list = (await (await page.request.get(`/api/estimates?limit=100`)).json()).items as { title: string }[];
  expect(list.filter((x) => x.title === title)).toHaveLength(1);

  // Withdrawing needs none of the draft's edits, so a line left without a description does not block it.
  await page.getByLabel("Line 1 description").fill("");
  await page.getByRole("button", { name: "Withdraw" }).click();
  await page.getByLabel("Why withdraw it?").fill("Customer went with a neighbour's quote");
  await page.getByRole("button", { name: "Withdraw the estimate" }).click();
  await expect(page.getByTestId("estimate-status")).toHaveText("Void");
});

test("an invoice draft edited after its last save is issued at the edited amount", async ({ page }) => {
  await signIn(page);
  const { customerId } = await emailedCustomer(page);
  const draft = await (await page.request.post("/api/invoices", { data: { customerId, lines: [{ description: "Annual maintenance plan", quantity: 1, unitPriceCents: 27500 }] } })).json();
  await page.goto(`/invoices/${draft.id}`);
  await expect(page.getByTestId("draft-total")).toHaveText("$275.00");
  await page.getByLabel("Description").first().fill("Annual maintenance plan, discounted");
  await page.getByLabel("Price").first().fill("250.00");
  await expect(page.getByTestId("draft-total")).toHaveText("$250.00");
  await page.getByRole("button", { name: "Issue without emailing" }).click();
  await expect(page.getByRole("heading", { name: /^INV-\d+$/ })).toBeVisible();
  const issued = await (await page.request.get(`/api/invoices/${draft.id}`)).json();
  expect(issued).toMatchObject({ status: "open", totalCents: 25000 });
  expect(issued.lines[0]).toMatchObject({ description: "Annual maintenance plan, discounted", unitPriceCents: 25000 });
});

test("a paid invoice offers no pay link or email to pay it again", async ({ page }) => {
  await signIn(page);
  const { customerId } = await emailedCustomer(page);
  const draft = await (await page.request.post("/api/invoices", { data: { customerId, lines: [{ description: "Riser lid", quantity: 1, unitPriceCents: 8000 }] } })).json();
  expect((await page.request.post(`/api/invoices/${draft.id}/issue`, { data: { send: false } })).ok()).toBeTruthy();

  await page.goto(`/invoices/${draft.id}`);
  await expect(page.getByRole("button", { name: "Email again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy pay link" })).toBeVisible();

  const paid = await page.request.post(`/api/invoices/${draft.id}/payments`, { data: { amountCents: 8000, method: "check", receivedOn: "2026-10-01", reference: "1042" } });
  expect(paid.ok(), await paid.text()).toBeTruthy();
  await page.reload();
  await expect(page.locator(".badge", { hasText: "Paid" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Email again" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy pay link" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Record a payment" })).toHaveCount(0);
});
