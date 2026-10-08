import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import pg from "pg";

// SW-9 homeowner side (plan §4.4): a pumping-only plan is offered, signed and shown to the
// homeowner as pumping, never as aerobic inspections or county reports. A 36-month plan with a
// monthly pumping visit counts all 36 visits; a booked pumping visit the office completes shows
// as progress on the portal, with the next pumping visit; on a site with both, the inspections
// keep their own count and label. Fictional plans, customers and signers; the built-in test
// payment provider only; nothing is sent. Pixel 7 emulation.
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://aerowise:aerowise@localhost:5432/aerowise_e2e";
// Words that belong to aerobic inspections and authority filing, never to a pumping-only plan.
const AEROBIC = /aerobic|county|inspection|inspected|filed with|permitting authority/i;

/** A page's text without the company's own name, which may itself say "Aerobic" (the demo company's does). */
async function textOf(page: Page, company: string) {
  return (await page.locator("main").innerText()).replaceAll(company, "the company");
}

async function office(browser: Browser): Promise<APIRequestContext> {
  const request = (await browser.newContext()).request;
  expect((await request.post("/api/auth/login", { data: { email: "owner@example.com", password: "aerowise-dev" } })).ok()).toBe(true);
  return request;
}

type Obligation = { id: string; serviceType: string; cycleKey: string; sequence: number; windowStart: string; windowEnd: string; dueOn: string; status: string };
type Contract = { id: string; serviceType: string; obligations: Obligation[] };

async function pumpingType(api: APIRequestContext) {
  return ((await (await api.get("/api/work-types")).json()).items as { id: string; key: string }[]).find((t) => t.key === "pumping")!.id;
}

/** A plan with the given cycles; `aerobic` false makes it pumping only. */
async function cyclePlan(api: APIRequestContext, name: string, termMonths: number, cycles: object[], aerobic: boolean) {
  const plan = await (await api.post("/api/plans", { data: { name, termMonths, visitsPerTerm: 2, priceCents: 36000 } })).json();
  const version = await api.post(`/api/plans/${plan.id}/versions`, { data: { termsText: null, options: [], coverage: [], serviceCycles: cycles, aerobic } });
  expect(version.status(), await version.text()).toBe(201);
  return plan.id as string;
}

/** A fictional customer with a synthetic billing contact, one site and a contract starting today. */
async function homeownerOn(api: APIRequestContext, name: string, planId: string) {
  const customer = await (await api.post("/api/customers", { data: { displayName: name } })).json();
  expect((await api.post(`/api/customers/${customer.id}/contacts`, { data: { name: "Billing", email: `billing.${customer.id.slice(0, 8)}@example.com`, type: "billing" } })).ok()).toBe(true);
  const site = await (await api.post(`/api/customers/${customer.id}/sites`, { data: { addressLine1: `${name} Fictional Rd`, city: "Austin" } })).json();
  const { today } = await (await api.get("/api/obligations/due?limit=1")).json();
  const made = await api.post(`/api/sites/${site.id}/contracts`, { data: { planId, startOn: today, autoRenew: true } });
  expect(made.status(), await made.text()).toBe(201);
  return { customerId: customer.id as string, contract: (await made.json()) as Contract };
}

/** Books a cycle visit as a work order and has the office complete it; returns the order. */
async function bookAndComplete(api: APIRequestContext, visit: Obligation) {
  const booked = await api.post(`/api/obligations/${visit.id}/work-order`, { data: {} });
  expect(booked.ok(), await booked.text()).toBe(true);
  const wo = await booked.json();
  const done = await api.post(`/api/work-orders/${wo.id}/complete`, { data: { reason: "Pumped; recorded on paper (test)" } });
  expect(done.status(), await done.text()).toBe(200);
  return wo as { id: string; title: string };
}

/** The customer's portal, opened from a link the office makes (not emailed). */
async function openPortal(api: APIRequestContext, page: Page, customerId: string) {
  const link = await api.post(`/api/customers/${customerId}/portal-link`, { data: { send: false } });
  expect(link.status(), await link.text()).toBe(201);
  const path = new URL((await link.json()).url).pathname;
  await page.goto(path);
  return (await (await api.get(`/api${path}`)).json()) as { sites: { contract: { visitsPerTerm: number; visitsDone: number; visitProgress: { label: string; done: number; total: number }[] } | null; nextVisit: { label: string | null; dueOn: string; windowStart: string; windowEnd: string; scheduledDate: string | null } | null; inspections: boolean }[] };
}

test("a pumping-only homeowner is offered, signs and sees pumping, never aerobic inspections, with every visit of a 36-month plan counted", async ({ browser }) => {
  const api = await office(browser);
  const stamp = Date.now().toString(36);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const orders: string[] = [];
  try {
    const monthly = { cycleKey: "pumping", label: "Tank pumping", serviceType: "pumping", workTypeId: await pumpingType(api), schedule: { kind: "every_months", everyMonths: 1, windowDays: 30 }, allowNoVisit: false };
    const planId = await cyclePlan(api, `Pump Monthly TEST ${stamp}`, 36, [monthly], false);
    const { customerId, contract } = await homeownerOn(api, `Pumping Homeowner TEST ${stamp}`, planId);
    expect(contract.serviceType).toBe("pumping");
    expect(contract.obligations.map((o) => o.serviceType)).toEqual(Array(36).fill("pumping"));

    // The renewal offer: all 36 pumping visits, and no inspection or county wording anywhere.
    const offered = await api.post(`/api/contracts/${contract.id}/renewal`, { data: { send: false } });
    expect(offered.status(), await offered.text()).toBe(201);
    const renewal = (await offered.json()) as { id: string; link: string };
    const token = renewal.link.split("/renew/")[1]!;
    const view = await (await api.get(`/api/renew/${token}`)).json();
    // terms.visitsPerTerm is a capped compatibility number; the cycle line carries the real count.
    expect(view.terms).toMatchObject({ serviceType: "pumping", termMonths: 36 });
    expect(view.cycles).toEqual(["Tank pumping: Every 1 month, within 30 days of the due date (36 visits this term)"]);
    expect(view.agreementText).toContain(
      "1. Service. The provider will perform the pumping or maintenance visits listed above on the system at the service address. These visits are not inspections for a permitting authority, and the provider files no report with an authority for them.",
    );
    expect(view.agreementText).not.toContain("aerobic treatment system");
    expect(view.agreementText).not.toContain("file each inspection report");

    const home = await (await browser.newContext()).newPage();
    await home.goto(new URL(renewal.link).pathname);
    await expect(home.getByRole("heading", { name: "Renew your maintenance plan" })).toBeVisible();
    await expect(home.getByText("Renewing keeps your pumping visits on schedule.")).toBeVisible();
    await expect(home.getByTestId("renewal-visits")).toHaveText(/Tank pumping.*\(36 visits this term\)/);
    await expect(home.getByTestId("renewal-visits")).not.toContainText("24");
    await expect(home.getByTestId("renewal-cycles")).toContainText("Tank pumping");
    // Nothing on the page speaks of aerobic systems, the county or filing; the agreement says these are not inspections.
    expect((await textOf(home, view.provider.name)).replace("are not inspections for a permitting authority", "")).not.toMatch(AEROBIC);

    // The homeowner signs the fictional agreement; what they signed is pumping, 36 visits.
    await home.getByLabel("Your full name").fill("Pat Pumping (test)");
    await home.getByRole("checkbox", { name: /I have read this agreement/ }).check();
    await home.getByRole("button", { name: /^Sign/ }).click();
    await expect(home.getByRole("heading", { name: "One last step" })).toBeVisible();
    const signed = (await db.query("select content from signed_documents where renewal_id = $1", [renewal.id])).rows;
    expect(signed).toHaveLength(1);
    const content = signed[0].content as { term: { serviceType: string }; terms: string; cycles: { cycleKey: string; label: string; summary: string }[] };
    expect(content.term.serviceType).toBe("pumping");
    expect(content.cycles).toEqual([expect.objectContaining({ cycleKey: "pumping", label: "Tank pumping", summary: expect.stringContaining("(36 visits this term)") })]);
    expect(content.terms).toContain("are not inspections for a permitting authority");
    expect(content.terms).not.toMatch(/aerobic|file each inspection report/i);

    // The office completes the first pumping visit: the portal counts it out of 36 and shows the next one.
    const first = contract.obligations.find((o) => o.sequence === 1)!;
    const second = contract.obligations.find((o) => o.sequence === 2)!;
    orders.push((await bookAndComplete(api, first)).id);
    const portal = await openPortal(api, home, customerId);
    expect(portal.sites[0]!.contract!.visitProgress).toEqual([{ label: "Tank pumping", done: 1, total: 36 }]);
    // The next service is the next pumping visit, named as such; there is no inspection row at all.
    expect(portal.sites[0]!).toMatchObject({ inspections: false, nextVisit: { label: "Tank pumping", dueOn: second.dueOn, windowStart: second.windowStart, windowEnd: second.windowEnd, scheduledDate: null } });
    await expect(home.getByText(/^Tank pumping: due between /)).toBeVisible();
    await expect(home.getByText("Last inspection")).toHaveCount(0);
    await expect(home.getByText("None planned")).toHaveCount(0);
    const progress = home.getByTestId("portal-visit-progress");
    await expect(progress).toHaveText("Tank pumping: 1 of 36 done");
    await expect(home.getByText(/\d+ of \d+ visits done/)).toHaveCount(0);
    expect(await textOf(home, view.provider.name)).not.toMatch(AEROBIC);
  } finally {
    // Nothing here is on a route today; any visit booked moves to yesterday all the same.
    for (const id of orders) await db.query("update jobs set scheduled_date = scheduled_date - 1 where work_order_id = $1", [id]);
    await db.end();
  }
});

test("on a plan with inspections and pumping, each kind of visit keeps its own count and label for the homeowner", async ({ browser }) => {
  const api = await office(browser);
  const stamp = Date.now().toString(36);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const orders: string[] = [];
  try {
    const pumping = { cycleKey: "pumping", label: "Tank pumping", serviceType: "pumping", workTypeId: await pumpingType(api), schedule: { kind: "every_months", everyMonths: 6, windowDays: 30 }, allowNoVisit: false };
    const planId = await cyclePlan(api, `Aerobic plus pumping TEST ${stamp}`, 12, [pumping], true);
    const { customerId, contract } = await homeownerOn(api, `Mixed Homeowner TEST ${stamp}`, planId);
    const kinds = contract.obligations.map((o) => o.serviceType);
    const inspections = kinds.filter((k) => k === "aerobic_inspection").length;
    expect(inspections).toBeGreaterThan(0);
    expect(kinds.filter((k) => k === "pumping")).toHaveLength(2);

    // The renewal names both kinds, inspections first, each with its own count.
    const offered = await api.post(`/api/contracts/${contract.id}/renewal`, { data: { send: false } });
    expect(offered.status(), await offered.text()).toBe(201);
    const view = await (await api.get(`/api/renew/${(await offered.json()).link.split("/renew/")[1]}`)).json();
    expect(view.cycles).toEqual([expect.stringMatching(/^Aerobic inspections: \d+ visits? per term$/), "Tank pumping: Every 6 months, within 30 days of the due date (2 visits this term)"]);
    // The agreement keeps its inspection clause and says the pumping visits are not inspections.
    expect(view.agreementText).toContain("The provider will also perform the pumping or maintenance visits listed above; those visits are not inspections, and no report is filed with an authority for them.");

    // Completing a pumping visit counts as pumping only; the inspections stay at none done.
    orders.push((await bookAndComplete(api, contract.obligations.find((o) => o.serviceType === "pumping" && o.sequence === 1)!)).id);
    const home = await (await browser.newContext()).newPage();
    const portal = await openPortal(api, home, customerId);
    expect(portal.sites[0]!.contract!.visitProgress).toEqual([
      { label: "Aerobic inspections", done: 0, total: inspections },
      { label: "Tank pumping", done: 1, total: 2 },
    ]);
    const progress = home.getByTestId("portal-visit-progress");
    await expect(progress.locator("li")).toHaveText([`Aerobic inspections: 0 of ${inspections} done`, "Tank pumping: 1 of 2 done"]);
    // The inspection is still the next visit, and the inspection row stays.
    expect(portal.sites[0]!).toMatchObject({ inspections: true, nextVisit: { label: null } });
    await expect(home.getByText("Last inspection")).toBeVisible();
    await expect(home.getByText(/\d+ of \d+ visits done/)).toHaveCount(0);
  } finally {
    for (const id of orders) await db.query("update jobs set scheduled_date = scheduled_date - 1 where work_order_id = $1", [id]);
    await db.end();
  }
});
