import { expect, test, type Page } from "@playwright/test";

async function office(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("office@example.com");
  await page.getByLabel("Password").fill("aerowise-dev");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/inbox");
}

test("failed and delayed invoice filters never relabel the old rows; retry and history recover", async ({ page }) => {
  await office(page);
  await page.goto("/invoices");
  await expect(page.getByRole("navigation", { name: "Result pages" })).toBeVisible();
  const unpaid = await (await page.request.get("/api/invoices?view=unpaid&limit=50")).json();
  let fail = true;
  await page.route("**/api/invoices?view=paid&**", async (route) => {
    if (fail) await route.fulfill({ status: 503, json: { error: "controlled_failure", message: "Temporary test outage" } });
    else { await new Promise((resolve) => setTimeout(resolve, 500)); await route.continue(); }
  });
  await page.getByRole("button", { name: "Paid", exact: true }).click();
  await expect(page).toHaveURL(/view=paid/);
  await expect(page.locator("main").getByRole("alert")).toContainText("Temporary test outage");
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByText("No paid invoices yet")).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Retry invoices" }).click();
  await expect(page.getByRole("status")).toContainText("Loading invoices");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Result pages" })).toBeVisible();
  await expect(page).toHaveURL(/view=all/);
  // An older Paid response arrives after All. It must not overwrite the selected result.
  await page.waitForTimeout(700);
  for (const row of unpaid.items) await expect(page.locator(`a[href="/invoices/${row.id}"]`)).toHaveCount(1);
  await page.goBack();
  await expect(page).toHaveURL(/view=paid/);
  await expect(page.getByRole("navigation", { name: "Result pages" })).toBeVisible();
});

test("Due counts preserve range and overdue URLs, service-type failures stay visible, Schedule retains exact target", async ({ page }) => {
  await office(page);
  await page.getByRole("link", { name: /Due this week/ }).click();
  await expect(page).toHaveURL(/range=7/);
  await expect(page.getByRole("button", { name: "Next 7 days" })).not.toHaveClass(/secondary/);
  await expect(page.getByLabel("Upcoming only (excludes overdue)")).toBeChecked();
  await page.goto("/inbox");
  await page.getByRole("link", { name: /Overdue/ }).click();
  await expect(page).toHaveURL(/overdueOnly=true/);
  await expect(page.getByLabel("Overdue only")).toBeChecked();
  await page.route("**/api/obligations/due?**serviceType=pumping**", (route) => route.fulfill({ status: 503, json: { message: "Controlled pumping read failure" } }));
  await page.getByLabel("Type of visit").selectOption("pumping");
  await expect(page.locator("main").getByRole("alert")).toContainText("Controlled pumping read failure");
  await expect(page.getByRole("row")).toHaveCount(1); // headings, no inspection rows relabeled as pumping
  await expect(page.getByText("Nothing due in this range")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("office-due-load-failure.png"), fullPage: true });
  await page.unroute("**/api/obligations/due?**serviceType=pumping**");
  const due = await (await page.request.get("/api/obligations/due?unscheduledOnly=true&limit=1&through=2030-01-01")).json();
  const target = due.items[0];
  expect(target).toBeTruthy();
  await page.goto(`/schedule?obligationId=${target.id}&siteId=${target.site.id}`);
  await expect(page.locator(`#obligation-${target.id}`)).toBeVisible();
  await expect(page.locator(`#obligation-${target.id}`)).toHaveClass(/selected-obligation/);
  const unchanged = await (await page.request.get(`/api/obligations/due?obligationId=${target.id}`)).json();
  expect(unchanged.items[0].job).toBeNull();
});

test("failed Schedule today probe offers Retry and resolves; partial route failure keeps the visits", async ({ page }) => {
  await office(page);
  await page.route("**/api/obligations/due?limit=1", (route) => route.fulfill({ status: 503, json: { message: "Controlled date probe failure" } }));
  await page.goto("/schedule");
  await expect(page.locator("main").getByRole("alert")).toContainText("Controlled date probe failure");
  await page.unroute("**/api/obligations/due?limit=1");
  await page.route("**/api/routing/day?**", (route) => route.fulfill({ status: 503, json: { message: "Controlled map failure" } }));
  await page.getByRole("button", { name: "Retry company date" }).click();
  await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible();
  await expect(page.locator("main").getByRole("alert")).toContainText("Controlled map failure");
  await expect(page.getByRole("heading", { name: "Unscheduled", exact: true })).toBeVisible();
});

test("a fresh visitor follows actual case records to the report, selected visit, technician and homeowner", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start my demo" }).click();
  await page.waitForURL("**/inbox", { timeout: 120_000 });
  await expect(page.getByRole("heading", { name: "Aerowise in five minutes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Start operating" })).toHaveCount(0);
  const j = await (await page.request.get("/api/demo/journey")).json();
  expect(j.case.customerName).toBeTruthy(); expect(j.job).toBeTruthy(); expect(j.invoice.paymentStatus).toBe("unpaid");
  await page.getByRole("button", { name: "Open completed report and evidence" }).click();
  await expect(page).toHaveURL(`/filings/${j.case.filingId}`);
  await expect(page.getByRole("heading", { name: "Packages", exact: true })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("Active role: office");
  const rejected = page.locator("form").filter({ has: page.getByRole("button", { name: "Record rejection", exact: true }) });
  await rejected.getByLabel("Why", { exact: true }).fill("Fictional walkthrough: reading needs correction");
  await rejected.getByRole("button", { name: "Record rejection", exact: true }).click();
  await page.getByLabel("Answer to correct").selectOption({ label: "Aeration · Air pressure" });
  await page.getByRole("spinbutton", { name: "Air pressure", exact: true }).fill("5.5");
  await page.getByLabel("Reason for the correction").fill("Fictional reading corrected from technician notes");
  await expect(page.getByRole("heading", { name: "Review changes", exact: true })).toBeVisible();
  const original = await (await page.request.get(`/api/filings/${j.case.filingId}`)).json();
  await page.getByRole("button", { name: "Make corrected version", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Report versions", exact: true })).toBeVisible();
  const corrected = await (await page.request.get(`/api/filings/${j.case.filingId}`)).json();
  expect(corrected.reports[0].version).toBe(original.reports[0].version + 1);
  await expect(page.getByRole("heading", { name: "Maintenance provider signature", exact: true }).locator("..")).toContainText(`Report version ${corrected.reports[0].version}`);
  expect(corrected.reports[1].sha256).toBe(original.reports[0].sha256);
  expect(corrected.packages.find((p: { id: string }) => p.id === original.packages[0].id).manifestSha256).toBe(original.packages[0].manifestSha256);

  await page.getByText("Five-minute walkthrough", { exact: true }).click();
  await page.getByRole("button", { name: "2. Schedule", exact: true }).click();
  await page.getByRole("button", { name: "Open this visit in Schedule" }).click();
  await expect(page).toHaveURL(new RegExp(`obligationId=${j.obligation.id}`));
  await page.getByText("Five-minute walkthrough", { exact: true }).click();
  await page.getByRole("button", { name: "3. Technician", exact: true }).click();
  await page.getByRole("button", { name: "Open technician stop" }).click();
  await expect(page).toHaveURL(new RegExp(`/tech\\?jobId=${j.job.id}`));
  await expect(page.getByRole("note")).toContainText("Active role: technician");
  await page.getByText("Five-minute walkthrough", { exact: true }).click();
  await page.getByRole("button", { name: "5. Homeowner", exact: true }).click();
  await page.getByRole("button", { name: `Open ${j.case.customerName}'s homeowner view` }).click();
  await expect(page).toHaveURL(/\/portal\//);
  await expect(page.locator("main").getByRole("heading", { name: j.case.addressLine1, exact: false })).toBeVisible();
});


test("a pumping Due action opens and focuses the exact contract visit without booking work", async ({ page }) => {
  await office(page);
  const probe = await (await page.request.get("/api/obligations/due?limit=1")).json();
  const through = new Date(`${probe.today}T00:00:00Z`); through.setUTCDate(through.getUTCDate() + 90);
  const due = await (await page.request.get(`/api/obligations/due?serviceType=pumping&through=${through.toISOString().slice(0, 10)}&limit=50`)).json();
  const target = due.items.find((o: { workOrder: unknown }) => !o.workOrder);
  expect(target).toBeTruthy();
  await page.goto("/due?range=90&serviceType=pumping");
  const action = page.locator(`a[href="/sites/${target.site.id}?obligationId=${target.id}#obligation-${target.id}"]`);
  await expect(action).toBeVisible();
  await action.click();
  const row = page.locator(`#obligation-${target.id}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/selected-obligation/);
  await expect(row).toBeFocused();
  await expect(row.getByRole("button", { name: "Book work", exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/obligations/due?serviceType=pumping&obligationId=${target.id}`)).json()).items[0].workOrder).toBeNull();
});

test("failed contract paperwork and work detail reads expose recovery without removing the record", async ({ page }) => {
  await office(page);
  const due = await (await page.request.get("/api/obligations/due?limit=1")).json();
  const siteId = due.items[0].site.id;
  await page.route("**/api/contracts/*/filing-status", r => r.fulfill({ status: 503, json: { message: "Controlled paperwork failure" } }));
  await page.goto(`/sites/${siteId}`);
  await expect(page.getByRole("button", { name: "Retry contract paperwork and filing status" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current record and next action" })).toBeVisible();
  await page.unroute("**/api/contracts/*/filing-status");
  await page.getByRole("button", { name: "Retry contract paperwork and filing status" }).first().click();
  await expect(page.getByRole("button", { name: "Retry contract paperwork and filing status" })).toHaveCount(0);
  const orders = await (await page.request.get("/api/work-orders?limit=50")).json();
  let order: { id: string } | undefined;
  for (const candidate of orders.items) {
    const detail = await (await page.request.get(`/api/work-orders/${candidate.id}`)).json();
    if (detail.visits.length > 0 && detail.status !== "cancelled") { order = candidate; break; }
  }
  expect(order).toBeTruthy();
  await page.route("**/api/work-orders/*/coverage", r => r.fulfill({ status: 503, json: { message: "Controlled coverage failure" } }));
  await page.route("**/api/work/conflicts?**", r => r.fulfill({ status: 503, json: { message: "Controlled held record failure" } }));
  await page.route("**/api/jobs/*/work-record", r => r.fulfill({ status: 503, json: { message: "Controlled field record failure" } }));
  await page.goto(`/work/${order!.id}`);
  await expect(page.getByRole("button", { name: "Retry plan coverage" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry held field records" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry visit field record" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Visits", exact: true })).toBeVisible();
});
