import type { Feature } from "@aerowise/domain";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { client, createTenant, createUser, login, setupTestApp } from "./helpers.ts";

// Plan §12 row 11 and §4.3: the technician sees whether the customer's plan covers a visit's
// work ("Covered" or "Not covered, quote needed") and never a price or a percentage. The pinned
// clock is 2026-03-01.

const ON: Feature[] = ["work_orders", "field_work", "service_items", "plan_builder"];
const ctx = setupTestApp({ features: ON });
const DAY = "2026-03-02";

const GOLD_COVERAGE = [
  { ruleKey: "repairs", label: "Repairs", match: { category: "repair" }, effect: "included", limit: { count: 1, per: "term" } },
  { ruleKey: "pumping", label: "Pumping", match: { category: "pumping" }, effect: "percent_off", percentOff: 20 },
];

async function setup() {
  const t = await createTenant(ctx, "Org A");
  const tech = await createUser(ctx.db, t.org.id, "technician");
  const techApi = client(ctx.app, await login(ctx.app, tech.email));
  const plan = (await t.api.post("/plans", { name: "Gold", termMonths: 12, visitsPerTerm: 2, priceCents: 40000 })).json();
  const version = await t.api.post(`/plans/${plan.id}/versions`, { termsText: "1. Gold service. The provider services the system and covers the repairs this plan lists. (Fictional test terms.)", options: [], coverage: GOLD_COVERAGE });
  expect(version.statusCode, version.body).toBe(201);
  expect((await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2026-01-01" })).statusCode).toBe(201);
  const types = (await t.api.get("/work-types")).json().items as { id: string; key: string }[];
  const visit = async (key: string, title: string) => {
    const wo = (await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: types.find((x) => x.key === key)!.id, title, requestedOn: "2026-03-01" })).json();
    const scheduled = await t.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: tech.id, scheduledDate: DAY });
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    return { id: wo.id as string, jobId: scheduled.json().nextVisit.jobId as string };
  };
  return { ...t, tech, techApi, visit };
}

type Item = { jobId: string; coverage?: unknown };
const items = async (api: ReturnType<typeof client>) => (await api.get(`/work/route?date=${DAY}`)).json().items as Item[];

describe("coverage on the technician's work visits", () => {
  it("says what the plan covers for each visit, with no prices or percentages", async () => {
    const d = await setup();
    const repair = await d.visit("repair", "Alarm repair");
    const pump = await d.visit("pumping", "Pump the tank");
    const other = await d.visit("repair", "Second repair");
    expect((await d.api.post(`/work-orders/${repair.id}/coverage/apply`, {})).statusCode).toBe(200);
    expect((await d.api.post(`/work-orders/${pump.id}/coverage/apply`, {})).statusCode).toBe(200);

    const route = new Map((await items(d.techApi)).map((i) => [i.jobId, i.coverage]));
    expect(route.get(repair.jobId)).toEqual({ planName: "Gold", rules: [{ label: "Repairs", effect: "included" }] });
    expect(route.get(pump.jobId)).toEqual({ planName: "Gold", rules: [{ label: "Pumping", effect: "percent_off" }] });
    // No coverage applied to it: not covered.
    expect(route.get(other.jobId)).toBeNull();
    // The technician's answer carries nothing priced: no percentages, amounts or contract ids.
    const raw = (await d.techApi.get(`/work/route?date=${DAY}`)).body;
    expect(raw).not.toMatch(/percentOff|Cents|contractId|"state"/);

    // Coverage given back by the office: the phone says not covered on its next download.
    expect((await d.api.post(`/work-orders/${pump.id}/coverage/decline`, { reason: "TEST customer declined" })).statusCode).toBe(200);
    expect((await items(d.techApi)).find((i) => i.jobId === pump.jobId)!.coverage).toBeNull();
  });

  it("leaves coverage out where the company does not use plan coverage", async () => {
    const d = await setup();
    const repair = await d.visit("repair", "Alarm repair");
    expect((await d.api.post(`/work-orders/${repair.id}/coverage/apply`, {})).statusCode).toBe(200);
    const app = await buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store, loginRateLimit: 1000, features: new Set<Feature>(["work_orders", "field_work", "service_items"]) });
    try {
      const api = client(app, await login(app, d.tech.email));
      const [item] = await items(api);
      expect(item!.jobId).toBe(repair.jobId);
      expect("coverage" in item!).toBe(false);
    } finally {
      await app.close();
    }
  });
});
