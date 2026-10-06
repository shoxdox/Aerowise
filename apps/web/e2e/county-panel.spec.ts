import { expect, test } from "@playwright/test";

// W10.5: a site's panel says what its authority asks, and where that comes from.
test("the site panel shows the authority's interval, deadline, channel, contracts and acknowledgment", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("office@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  const sites = await (await page.request.get("/api/sites?limit=1")).json();
  await page.goto(`/sites/${sites.items[0].id}`);
  const panel = page.locator("dl").filter({ hasText: "Reports to" });
  await expect(panel.getByText("Example rules for the demo; no real authority.")).toBeVisible();
  await expect(panel.getByText("At least every 4 months.")).toBeVisible();
  await expect(panel.getByText("Within 14 days of the inspection.")).toBeVisible();
  await expect(panel.getByText(/^By email to filings@tx-example-county\.example\./)).toBeVisible();
  await expect(panel.getByText("Not filed with this authority.")).toBeVisible();
  await expect(panel.getByText(/record its reference to finish a filing/)).toBeVisible();
  await panel.screenshot({ path: "test-results/county-panel.png" });
});

// W10.5 with W12.V4: a real county's draft rules show how far the authority itself confirmed each line.
test("a draft authority's lines show their confirmation state, never confirmed without the authority", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("office@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/inbox");

  const customer = await (await page.request.post("/api/customers", { data: { displayName: "Bexar panel check" } })).json();
  const site = await (await page.request.post(`/api/customers/${customer.id}/sites`, { data: { addressLine1: "100 Example Ln", city: "San Antonio", county: "Bexar County" } })).json();
  // Bexar County's sites are assigned by a person, with what they checked.
  const { candidates } = await (await page.request.get(`/api/sites/${site.id}/jurisdiction`)).json();
  const assigned = await page.request.put(`/api/sites/${site.id}/jurisdiction`, {
    data: { jurisdictionId: candidates[0].id, evidenceKind: "permit_record", evidenceReference: "Fictional: demo check of the permit map" },
  });
  expect(assigned.ok()).toBe(true);
  await page.goto(`/sites/${site.id}`);
  const panel = page.locator("dl").filter({ hasText: "Reports to" });
  await expect(panel.getByTestId("requirements-source")).toHaveText("Read from the authority's public sources and not confirmed with it.");
  await expect(panel.getByTestId("confirmation-summary")).toHaveText("Nothing recorded with the authority yet.");
  await expect(panel.getByTestId("confirmation-report_channel")).toContainText(/^Not published\..*Open$/);
  for (const topic of ["contract_destination", "receipt_acceptance", "report_format", "signature"]) {
    await expect(panel.getByTestId(`confirmation-${topic}`)).toContainText("Open");
  }
  await expect(panel.getByText("Confirmed by the authority")).toHaveCount(0);
  await panel.screenshot({ path: "test-results/county-panel-draft.png" });
});
