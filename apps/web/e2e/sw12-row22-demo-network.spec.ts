import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// SW-12 plan §12 row 22, browser half: every request the browser makes during a demo walk, from
// the office, the technician's phone and the homeowner's pages, stays on the app's own origin.
// No page reaches a real email, SMS, payment, QuickBooks, geocoding or map service; checkout,
// QuickBooks and the street map are the app's own test stand-ins. (The server side, where the API
// would call those services, is demo-isolation.test's: its providers are stand-ins in demo mode.)
// Requests the browser makes for itself, outside any page (Chromium's own update or safe-browsing
// checks), are not the app's and are not seen here.
const APP = "http://localhost:3000";

test.use({ geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });

function watch(context: BrowserContext, seen: string[], outside: string[]) {
  context.on("request", (r) => {
    const url = r.url();
    seen.push(url);
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (new URL(url).origin !== APP) outside.push(`${r.method()} ${url}`);
  });
}

async function signIn(page: Page, email: string, landing: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`**${landing}`);
}

test("a demo walk by the office, the technician and a homeowner makes no request outside the app", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const seen: string[] = [];
  const outside: string[] = [];
  watch(page.context(), seen, outside);

  // The office: the main screens, a QuickBooks and payment connection (test stand-ins), and an
  // estimate and invoice to share.
  await signIn(page, "owner@example.com", "/inbox");
  await expect(page.getByText(/Fictional demo company/).first()).toBeVisible();
  // The capture sees a request that leaves the origin (a probe nothing answers), then starts clean.
  await page.evaluate(() => fetch("https://capture-check.invalid/probe").catch(() => null));
  await expect.poll(() => outside.some((u) => u.includes("capture-check.invalid"))).toBe(true);
  outside.length = 0;
  for (const path of ["/inbox", "/due", "/schedule", "/customers", "/sites", "/work", "/estimates", "/invoices", "/filings", "/renewals", "/plans", "/disposal", "/quickbooks", "/settings/billing", "/settings/trucks"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBeLessThan(400);
    await page.waitForLoadState("networkidle");
  }
  const connectStripe = page.getByRole("button", { name: "Connect Stripe" });
  await page.goto("/settings/billing");
  await page.waitForLoadState("networkidle");
  if (await connectStripe.isVisible()) await connectStripe.click();
  await page.goto("/quickbooks");
  await page.waitForLoadState("networkidle");
  const connectQb = page.getByRole("button", { name: "Connect QuickBooks" });
  if (await connectQb.isVisible()) {
    await connectQb.click();
    await page.waitForURL(/\/quickbooks\?connected=1/);
  }

  // An estimate with a deposit, accepted and paid by a homeowner on the test checkout.
  const site = (await (await page.request.get("/api/sites?limit=1")).json()).items[0] as { id: string };
  await page.goto(`/estimates/new?siteId=${site.id}`);
  await page.getByRole("textbox", { name: /^Title/ }).fill("Row 22 walk");
  await page.getByLabel("Line 1 description").fill("Pump, installed");
  await page.getByLabel("Line 1 unit price").fill("600");
  await page.getByRole("spinbutton", { name: /^Deposit/ }).fill("150");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.waitForURL(/\/estimates\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: /Mark sent/ }).click();
  await page.getByRole("button", { name: "Copy a link" }).click();
  const estimatePath = new URL(await page.getByTestId("estimate-link").innerText()).pathname;

  const home = await browser.newContext();
  watch(home, seen, outside);
  const homeowner = await home.newPage();
  await homeowner.goto(estimatePath);
  await homeowner.getByLabel("Your full name").fill("Pat Homeowner");
  await homeowner.getByRole("checkbox", { name: /I have read this estimate/ }).check();
  await homeowner.getByRole("button", { name: /Accept for \$600\.00/ }).click();
  await expect(homeowner.getByRole("heading", { name: "Estimate accepted" })).toBeVisible();
  await homeowner.getByRole("link", { name: "Pay the deposit" }).click();
  await homeowner.waitForURL(/\/pay\//);
  await homeowner.getByRole("button", { name: "Pay $150.00 by card or bank" }).click();
  await homeowner.waitForURL(/test-checkout/);
  await homeowner.getByRole("button", { name: "Pay by card" }).click();
  await expect(homeowner.getByText("This invoice is paid in full")).toBeVisible();

  // The homeowner's portal, and a service request from it.
  const due = await (await page.request.get("/api/obligations/due?limit=50")).json();
  let portalPath: string | undefined;
  for (const o of due.items as { customer: { id: string } }[]) {
    if ((await (await page.request.get(`/api/customers/${o.customer.id}/portal`)).json()).email) {
      await page.goto(`/customers/${o.customer.id}`);
      await page.getByRole("button", { name: "Copy portal link" }).click();
      portalPath = new URL((await page.locator(".portal-url").textContent())!).pathname;
      break;
    }
  }
  await homeowner.goto(portalPath!);
  await homeowner.getByRole("button", { name: "Request service" }).first().click();
  await homeowner.getByLabel("What do you need?").selectOption("alarm");
  await homeowner.getByLabel("Tell us more").fill("Row 22: the alarm light is on.");
  await homeowner.getByRole("button", { name: "Send request" }).click();
  await expect(homeowner.getByText("Thanks, we have your request")).toBeVisible();
  await homeowner.waitForLoadState("networkidle");
  await home.close();

  // The technician's phone: the route, the street map (the app's own tile file) and a stop.
  const phoneContext = await browser.newContext({ ...test.info().project.use, geolocation: { latitude: 30.27, longitude: -97.74 }, permissions: ["geolocation"] });
  watch(phoneContext, seen, outside);
  const phone = await phoneContext.newPage();
  await signIn(phone, "tech@example.com", "/tech");
  await expect(phone.locator(".stop-card").first()).toBeVisible();
  await phone.waitForLoadState("networkidle");
  await phone.getByRole("button", { name: "Map" }).click();
  await expect(phone.locator(".street-map")).toHaveAttribute("data-status", "ready");
  await phone.waitForLoadState("networkidle");
  await phone.getByRole("button", { name: "List" }).click();
  await phone.locator(".stop-card", { hasText: "To do" }).first().click();
  await expect(phone.getByRole("button", { name: "Arrive and start inspection" })).toBeVisible();
  await phone.waitForLoadState("networkidle");
  await phoneContext.close();

  expect(seen.length, "the walk was captured").toBeGreaterThan(100);
  expect(outside, "requests that left the app's origin").toEqual([]);
});
