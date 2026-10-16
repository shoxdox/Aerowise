import { expect, test, type Page } from "@playwright/test";

// The office shell and sign-in (review #40, #28, #35): one header row on a laptop that folds
// behind Menu where it doesn't fit, an account menu, tab titles, a skip link, where sign-in sends
// people afterwards, and technicians kept on their route.

async function signIn(page: Page, email: string, from = "/login") {
  await page.goto(from);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test("a sign-in link can't send someone to another site afterwards, only to a page of this one", async ({ page }) => {
  const elsewhere: string[] = [];
  await page.route((url) => url.hostname.endsWith("example.org"), (route) => {
    elsewhere.push(route.request().url());
    return route.abort();
  });
  // Browsers read "/\example.org" as another site.
  await signIn(page, "office@example.com", "/login?next=%2F%5Cexample.org%2Fsign-in-again");
  await expect(page).toHaveURL(/\/inbox$/);
  expect(elsewhere).toEqual([]);

  await page.context().clearCookies();
  await signIn(page, "office@example.com", "/login?next=%2Fsettings%3Ffrom%3Demail");
  await expect(page).toHaveURL(/\/settings\?from=email$/);
});

test("a technician who follows an office link lands on their route, not in office screens", async ({ page }) => {
  // A texted link to an office page: signing in ignores it for a technician.
  await signIn(page, "tech@example.com", "/login?next=%2Finvoices");
  await expect(page).toHaveURL(/\/tech$/);
  // Opened directly once signed in, an office page sends them to their route too.
  await page.goto("/schedule");
  await page.waitForURL(/\/tech$/);
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
});

test("the sign-in page says what went wrong and can show the password", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // 16px fields, so a phone doesn't zoom in on them.
  expect(await page.getByLabel("Email").evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
  await page.getByLabel("Email").fill("office@example.com");
  const password = page.getByLabel("Password");
  await password.fill("not-the-password");
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("That email and password don't match. Check both, or reset your password below.");
});

test("on a phone, the menu folds again when the page changes, by a link or by Back", async ({ page }) => {
  await signIn(page, "owner@example.com");
  const nav = page.getByRole("navigation", { name: "Main" });
  await page.getByRole("button", { name: "Menu" }).click();
  await nav.getByRole("link", { name: "Schedule" }).click();
  await page.waitForURL("**/schedule");
  await expect(nav).toBeHidden();
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(nav).toBeVisible();
  await page.goBack();
  await page.waitForURL("**/inbox");
  await expect(nav).toBeHidden();
  await expect(page.getByRole("button", { name: "Menu" })).toBeVisible();
});

test.describe("on a 1280px laptop", () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test("an owner's longer menu still fits on one row, beside the logo alone", async ({ page }) => {
    await signIn(page, "owner@example.com");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Menu" })).toBeHidden();
    expect((await page.locator("header.topbar").boundingBox())!.height).toBeLessThanOrEqual(58);
    // The logo link keeps its name for screen readers.
    await expect(page.locator("header.topbar").getByRole("link", { name: "Aerowise" })).toHaveAttribute("href", "/inbox");
  });
});

test.describe("on a laptop", () => {
  test.use({ viewport: { width: 1366, height: 800 }, isMobile: false, hasTouch: false });

  test("the menu is one row, the tab is named after the page, and the account menu holds Sign out", async ({ page }) => {
    await signIn(page, "owner@example.com");
    const header = page.locator("header.topbar");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeVisible();
    await expect(page.getByRole("button", { name: "Menu" })).toBeHidden();
    // One row: the header is no taller than its 56px bar (plus its border).
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(58);
    await expect(page).toHaveTitle("Inbox · Aerowise");
    // The logo goes to the inbox; an owner who inspects has their route in the menu.
    await expect(header.getByRole("link", { name: "Aerowise" })).toHaveAttribute("href", "/inbox");
    await expect(nav.getByRole("link", { name: "My route" })).toHaveAttribute("href", "/tech");

    await nav.getByRole("link", { name: "Schedule" }).click();
    await expect(page).toHaveTitle("Schedule · Aerowise");

    // From the top of a page, the first Tab stop skips the menu.
    await page.reload();
    await expect(nav).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();

    await page.getByRole("button", { name: "Account" }).click();
    const account = page.locator("#account-menu");
    await expect(account).toContainText("Olivia Owner");
    await expect(account).toContainText("Owner · Hill Country Aerobic Services");
    await page.keyboard.press("Escape");
    await expect(account).toBeHidden();

    // Signing out leaves for the sign-in page even when the request doesn't get through.
    await page.route("**/api/auth/logout", (route) => route.abort());
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/login");
  });

  test("an office person's menu has no route link, and Settings lists every setting", async ({ page }) => {
    await signIn(page, "office@example.com");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Inbox" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "My route" })).toHaveCount(0);
    await nav.getByRole("link", { name: "Settings" }).click();
    const list = page.getByTestId("settings-list");
    for (const href of ["/settings/company", "/settings/users", "/renewals", "/sms", "/quickbooks"]) await expect(list.locator(`a[href="${href}"]`)).toHaveCount(1);
    // Billing and the subscription are the owner's.
    await expect(list.locator('a[href="/settings/billing"]')).toHaveCount(0);
  });
});

test.describe("on a tablet", () => {
  test.use({ viewport: { width: 1024, height: 768 }, isMobile: false, hasTouch: false });

  test("the links fold behind Menu and the header stays one row", async ({ page }) => {
    await signIn(page, "owner@example.com");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeHidden();
    expect((await page.locator("header.topbar").boundingBox())!.height).toBeLessThanOrEqual(58);
    await page.getByRole("button", { name: "Menu" }).click();
    await nav.getByRole("link", { name: "Invoices" }).click();
    await page.waitForURL("**/invoices");
    await expect(nav).toBeHidden();
    await expect(page.locator(".topbar .current-page")).toHaveText("Invoices");
    await expect(page).toHaveTitle("Invoices · Aerowise");
  });
});
