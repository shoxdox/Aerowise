import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";

// Plan §12 row 11 and §4.3: the technician's phone says whether the customer's plan covers a
// visit's work, and never shows a price or a percentage. The e2e API runs with plan_builder on
// (playwright.config.ts). Pixel 7 emulation; not a physical-phone check.

async function office(browser: Browser): Promise<APIRequestContext> {
  const request = (await browser.newContext()).request;
  expect((await request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return request;
}

test("a covered visit says which plan covers it, an uncovered one says a quote is needed, and neither shows a price", async ({ page, browser }) => {
  const api = await office(browser);
  const stamp = Date.now();
  const planName = `Gold phone ${stamp}`;
  const plan = await (await api.post("/api/plans", { data: { name: planName, termMonths: 12, visitsPerTerm: 2, priceCents: 40000 } })).json();
  const version = await api.post(`/api/plans/${plan.id}/versions`, {
    data: {
      termsText: "1. Gold service. The provider services the system and covers the repairs this plan lists. (Fictional test terms.)",
      options: [],
      coverage: [{ ruleKey: "repairs", label: "Repairs", match: { category: "repair" }, effect: "percent_off", percentOff: 25 }],
    },
  });
  expect(version.status()).toBe(201);
  // A site of its own, so the plan's contract is the only one there.
  const customer = (await (await api.get("/api/customers?limit=1")).json()).items[0] as { id: string };
  const site = await (await api.post(`/api/customers/${customer.id}/sites`, { data: { addressLine1: `${stamp} Coverage Rd`, city: "Austin" } })).json();
  const { today } = await (await api.get("/api/obligations/due?limit=1")).json();
  expect((await api.post(`/api/sites/${site.id}/contracts`, { data: { planId: plan.id, startOn: today } })).status()).toBe(201);
  const types = (await (await api.get("/api/work-types")).json()).items as { id: string; key: string }[];
  const techs = (await (await api.get("/api/technicians")).json()).items as { id: string; name: string }[];
  const visit = async (title: string) => {
    const wo = await (await api.post("/api/work-orders", { data: { siteId: site.id, workTypeId: types.find((t) => t.key === "repair")!.id, title } })).json();
    const scheduled = await api.post(`/api/work-orders/${wo.id}/schedule`, { data: { technicianId: techs.find((t) => t.name === "Tess Tech")!.id, scheduledDate: today } });
    expect(scheduled.status()).toBe(201);
    return wo.id as string;
  };
  const covered = await visit(`Covered repair ${stamp}`);
  const quoted = await visit(`Quoted repair ${stamp}`);
  try {
    expect((await api.post(`/api/work-orders/${covered}/coverage/apply`, { data: {} })).ok()).toBe(true);

    await page.goto("/login");
    await page.getByLabel("Email").fill("tech@example.com");
    await page.getByLabel("Password").fill("aerowise-dev");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/tech");

    await page.locator(".work-card", { hasText: `Covered repair ${stamp}` }).click();
    const note = page.getByTestId("work-coverage");
    await expect(note).toHaveText(`Partly covered by ${planName}: Repairs`);
    await expect(note).not.toContainText("%");
    await expect(note).not.toContainText("$");
    await page.getByRole("button", { name: "‹ Back" }).click();

    await page.locator(".work-card", { hasText: `Quoted repair ${stamp}` }).click();
    await expect(page.getByTestId("work-coverage")).toHaveText("Not covered, quote needed");
  } finally {
    for (const id of [covered, quoted]) await api.post(`/api/work-orders/${id}/cancel`, { data: { reason: "e2e cleanup" } });
  }
});
