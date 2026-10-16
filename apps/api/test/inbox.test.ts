import type { EmailTransport } from "@aerowise/compliance";
import { drainTasks } from "@aerowise/tasks";
import { describe, expect, it } from "vitest";
import { client, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, JPEG, payload, photoUrl, setup, signAsProvider, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

const ctx = setupTestApp();

let mailFails = false;
const mail: EmailTransport = {
  name: "fake",
  send: async (m) => {
    if (mailFails) throw new Error("SMTP 451 temporary failure");
    return { messageId: `<${m.idempotencyKey}@fake>`, acceptedAt: new Date().toISOString(), response: {} };
  },
};
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });

type Item = { key: string; kind: string; severity: string; title: string; detail: string | null; dueOn: string | null; target: { type: string; id: string }; canOverride?: boolean; booking?: object | null };
const inboxOf = async (s: Setup) => {
  const res = await s.api.get("/inbox");
  expect(res.statusCode).toBe(200);
  return res.json() as { today: string; counts: Record<string, number>; items: Item[]; routes: { name: string; stops: number; done: number }[] };
};
const kinds = async (s: Setup) => (await inboxOf(s)).items.map((i) => i.kind);

/** A visit today at a site in the fake county, with a licensed technician. Contract runs 2025-12-01 to 2026-11-30. */
async function countySetup(c: TestContext, name = "Org A") {
  const s = await setup(c, name);
  await s.api.patch(`/sites/${s.site.id}`, { county: "Example County" });
  await c.db.updateTable("memberships").set({ technicianLicense: "MP-0001" }).where("userId", "=", s.tech.id).execute();
  return s;
}

async function complete(s: Setup, opts: { photos?: boolean; issues?: object[] } = {}) {
  const p = payload(s);
  await s.techApi.put("/inspections/sync", p);
  if (opts.photos !== false) await uploadRequiredPhotos(s, p.clientId);
  const res = await s.techApi.put(
    "/inspections/sync",
    payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: { ...completeValues(), air_pressure: 4 }, issues: opts.issues ?? [] }),
  );
  return res.json() as { id: string; status: string };
}

describe("exception inbox", () => {
  it("shows an overdue visit until it is done", async () => {
    const s = await countySetup(ctx);
    expect(await kinds(s)).not.toContain("inspection_overdue");
    // The first visit's window ends 2026-03-31.
    ctx.now = new Date("2026-04-02T18:00:00Z");
    const inbox = await inboxOf(s);
    expect(inbox.counts.overdue).toBe(1);
    expect(inbox.items.find((i) => i.kind === "inspection_overdue")).toMatchObject({
      severity: "high",
      dueOn: "2026-03-31",
      detail: "Scheduled for 2026-03-01 with technician user",
      target: { type: "obligation", id: s.visit.id },
      // Booked for a day already gone: missed, not handled.
      booking: null,
    });
    // Booked again for a day to come: handled, and the item says when and with whom.
    expect((await s.api.patch(`/jobs/${s.job.jobId}`, { scheduledDate: "2026-04-03" })).statusCode).toBe(200);
    expect((await inboxOf(s)).items.find((i) => i.kind === "inspection_overdue")).toMatchObject({
      severity: "medium",
      booking: { jobId: s.job.jobId, scheduledDate: "2026-04-03", technicianId: s.tech.id, technicianName: "technician user" },
    });
    await complete(s);
    expect(await kinds(s)).not.toContain("inspection_overdue");
  });

  it("shows an inspection the technician could not finish, and whether the person looking may accept it anyway", async () => {
    const s = await countySetup(ctx);
    const insp = await complete(s, { photos: false });
    expect(insp.status).toBe("draft");
    const item = async (api = s.api) => ((await api.get("/inbox")).json().items as Item[]).find((i) => i.kind === "inspection_incomplete")!;
    expect(await item()).toMatchObject({ title: "Missing required readings", target: { type: "inspection", id: insp.id }, canOverride: false });
    expect((await item()).detail).toContain("Overview of the unit: 1 more photo needed");
    // The county requires the overview photo, so it is never waived.
    expect((await s.api.post(`/inspections/${insp.id}/override`, { reason: "Camera broke; photos by text" })).statusCode).toBe(422);

    // Once it arrives, only the chlorinator photo the company's own form asks for is missing: the owner may accept that.
    expect((await s.techApi.putImage(photoUrl(payload(s).clientId, 1), JPEG, { "x-photo-key": "overview" })).statusCode).toBe(201);
    expect(await item()).toMatchObject({ canOverride: true });
    const office = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, s.org.id, "office")).email));
    expect(await item(office)).toMatchObject({ canOverride: false });

    expect((await s.api.post(`/inspections/${insp.id}/override`, { reason: "Camera broke; photos by text" })).statusCode).toBe(200);
    expect(await kinds(s)).not.toContain("inspection_incomplete");
  });

  it("shows failed filings and the authority's next due date being missed by the next visit", async () => {
    mailFails = true;
    const s = await countySetup(ctx);
    const insp = await complete(s);
    await runWorker(ctx);
    // Held for the MP's signature: the inspection happened, so the authority's next date already counts.
    expect((await inboxOf(s)).items.find((i) => i.kind === "report_unsigned")).toMatchObject({ severity: "high" });
    expect(await kinds(s)).not.toContain("next_visit_late");
    await signAsProvider(s, insp.id);
    await runWorker(ctx);
    let inbox = await inboxOf(s);
    expect(inbox.items.find((i) => i.kind === "filing_failed")).toMatchObject({ severity: "high", detail: "SMTP 451 temporary failure", dueOn: "2026-03-15" });
    expect(inbox.counts.filingsAtRisk).toBe(1);

    mailFails = false;
    ctx.now = new Date(ctx.now.getTime() + 3600_000);
    await runWorker(ctx);
    inbox = await inboxOf(s);
    expect(inbox.items.map((i) => i.kind)).not.toContain("filing_failed");
    // The county wants the next inspection by 2026-07-01. The next visit's window opens in
    // April, so nothing is wrong until the date is close and the visit is not on a route.
    expect(inbox.items.map((i) => i.kind)).not.toContain("next_visit_late");

    // Two weeks on with no confirmation, the filing needs chasing.
    ctx.now = new Date("2026-03-20T18:00:00Z");
    expect(await kinds(s)).toContain("filing_unconfirmed");
    const filing = (await s.api.get("/filings?view=sent")).json().items[0];
    // An authority that publishes no acknowledgment (LCRA, say) is never chased for one: sent is
    // as far as that filing goes. The filing's recorded ruleset stands in for LCRA's here.
    const lcra = await ctx.db.selectFrom("jurisdictionRulesets as rs").innerJoin("jurisdictions as j", "j.id", "rs.jurisdictionId").select("rs.id").where("j.key", "=", "tx-lcra-ossf").orderBy("rs.version", "desc").executeTakeFirstOrThrow();
    const example = await ctx.db.selectFrom("filings").select("rulesetId").where("id", "=", filing.id).executeTakeFirstOrThrow();
    await ctx.db.updateTable("filings").set({ rulesetId: lcra.id }).where("id", "=", filing.id).execute();
    expect(await kinds(s)).not.toContain("filing_unconfirmed");
    await ctx.db.updateTable("filings").set({ rulesetId: example.rulesetId }).where("id", "=", filing.id).execute();
    expect(await kinds(s)).toContain("filing_unconfirmed");
    await s.api.post(`/filings/${filing.id}/confirm`, { reference: "EC-9" });
    expect(await kinds(s)).not.toContain("filing_unconfirmed");

    ctx.now = new Date("2026-06-05T18:00:00Z");
    const visit2 = s.contract.obligations[1];
    expect((await inboxOf(s)).items.find((i) => i.kind === "next_visit_late")).toMatchObject({
      title: "Schedule the next visit by 2026-07-01",
      severity: "medium",
      target: { type: "obligation", id: visit2.id },
    });
    // On the route too late still counts; in time clears it.
    const job = (await s.api.post("/jobs", { obligationId: visit2.id, technicianId: s.tech.id, scheduledDate: "2026-07-10" })).json();
    expect((await inboxOf(s)).items.find((i) => i.kind === "next_visit_late")?.detail).toBe("It is on the route for 2026-07-10, after the authority's date");
    await s.api.patch(`/jobs/${job.jobId}`, { scheduledDate: "2026-06-20" });
    expect(await kinds(s)).not.toContain("next_visit_late");
  });

  it("gives a site one next due date: the authority's, when the contract's calendar had it later", async () => {
    const s = await countySetup(ctx);
    const [, visit2, visit3] = s.contract.obligations;
    expect(visit2).toMatchObject({ dueOn: "2026-07-31", windowStart: "2026-04-01", windowEnd: "2026-07-31" });
    const insp = await complete(s);
    // Done 2026-03-01: the county wants the next one within 4 months, by 2026-07-01.
    const filing = (await s.api.get("/filings?view=all")).json().items[0];
    expect(filing.nextDueOn).toBe("2026-07-01");
    const due = (await s.api.get("/obligations/due?through=2026-12-31")).json().items as { id: string; dueOn: string; windowEnd: string; effectiveDueOn: string }[];
    expect(due.map((o) => [o.id, o.dueOn, o.windowEnd, o.effectiveDueOn])).toEqual([
      [visit2.id, "2026-07-01", "2026-07-01", "2026-07-01"],
      // The one after keeps its own date.
      [visit3.id, "2026-11-30", "2026-11-30", "2026-11-30"],
    ]);
    const events = (await s.api.get(`/sites/${s.site.id}/compliance-events`)).json().items as { eventType: string; summary: string }[];
    expect(events.find((e) => e.eventType === "filing_opened")?.summary).toContain("visit 2 moved from 2026-07-31 to that date");
    // The technician's stop says the same date.
    const stop = (await s.api.post("/jobs", { obligationId: visit2.id, technicianId: s.tech.id, scheduledDate: "2026-06-20" })).json();
    expect(stop.obligation).toMatchObject({ id: visit2.id, dueOn: "2026-07-01", mustBeDoneBy: "2026-07-01" });
    expect(insp.status).toBe("completed");

    // A visit made after the report (a renewal's, say) still lists by the authority's date.
    await ctx.db.updateTable("serviceObligations").set({ dueOn: "2026-07-31", windowEnd: "2026-07-31" }).where("id", "=", visit2.id).execute();
    expect((await s.api.get("/obligations/due?through=2026-07-15")).json().items).toEqual([expect.objectContaining({ id: visit2.id, dueOn: "2026-07-31", effectiveDueOn: "2026-07-01", overdue: false })]);
    ctx.now = new Date("2026-07-02T18:00:00Z");
    expect((await s.api.get(`/obligations/due?overdueOnly=true`)).json()).toMatchObject({ overdueTotal: 1, items: [{ id: visit2.id, overdue: true }] });
  });

  it("raises no visit before the authority's date as urgent only within 30 days of it", async () => {
    const s = await countySetup(ctx);
    await complete(s);
    // The rest of the contract's visits are gone (say, it was cancelled): nothing meets 2026-07-01.
    await ctx.db.updateTable("serviceObligations").set({ status: "cancelled" }).where("contractId", "=", s.contract.id).where("status", "=", "open").execute();
    const item = async () => (await inboxOf(s)).items.find((i) => i.kind === "next_visit_late");
    expect(await item()).toMatchObject({ title: "No visit before the authority's next due date", severity: "low", dueOn: "2026-07-01" });
    ctx.now = new Date("2026-06-05T18:00:00Z");
    expect(await item()).toMatchObject({ severity: "high" });
  });

  it("shows issues found on finished inspections until someone resolves them", async () => {
    const s = await countySetup(ctx);
    await complete(s, {
      issues: [{ clientId: "6a3f1b2c-1d2e-4f3a-8b4c-5d6e7f8a9b01", type: "repair_needed", severity: "high", description: "Aerator noisy" }],
    });
    const item = (await inboxOf(s)).items.find((i) => i.kind === "issue_open")!;
    expect(item).toMatchObject({ severity: "high", title: "Repair needed", detail: "Aerator noisy · found 2026-03-01" });

    expect((await s.techApi.post(`/issues/${item.target.id}/resolve`, { resolution: "x" })).statusCode).toBe(403);
    expect((await s.api.post(`/issues/${item.target.id}/resolve`, { resolution: "Replaced the aerator" })).json()).toMatchObject({ status: "resolved" });
    expect(await kinds(s)).not.toContain("issue_open");
    expect((await s.api.post(`/issues/${item.target.id}/resolve`, { resolution: "again" })).statusCode).toBe(409);
  });

  it("shows contracts ending without a renewal, then expired ones", async () => {
    const s = await setup(ctx);
    ctx.now = new Date("2026-11-10T18:00:00Z");
    let inbox = await inboxOf(s);
    expect(inbox.items.find((i) => i.kind === "contract_expiring")).toMatchObject({ severity: "low", dueOn: "2026-11-30", target: { id: s.contract.id } });
    expect(inbox.counts.contractsExpiring).toBe(1);

    ctx.now = new Date("2026-12-05T18:00:00Z");
    expect(await kinds(s)).toContain("contract_expired");

    expect((await s.api.post(`/contracts/${s.contract.id}/renew`, {})).statusCode).toBe(201);
    inbox = await inboxOf(s);
    expect(inbox.items.map((i) => i.kind)).not.toContain("contract_expired");
  });

  it("puts the most urgent first and counts today's route", async () => {
    const s = await countySetup(ctx);
    await complete(s, {
      issues: [
        { clientId: "6a3f1b2c-1d2e-4f3a-8b4c-5d6e7f8a9b01", type: "callback", severity: "low", description: "" },
        { clientId: "6a3f1b2c-1d2e-4f3a-8b4c-5d6e7f8a9b02", type: "noncompliance", severity: "high", description: "Spray head in setback" },
      ],
    });
    const inbox = await inboxOf(s);
    const severities = inbox.items.map((i) => i.severity);
    expect(severities).toEqual([...severities].sort((a, b) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(b)));
    expect(inbox.routes).toEqual([{ technicianId: s.tech.id, name: "technician user", stops: 1, done: 1 }]);
    expect(inbox.today).toBe("2026-03-01");
  });
});

describe("inbox access", () => {
  it("shows each organization only its own exceptions", async () => {
    const a = await countySetup(ctx, "Org A");
    const b = await countySetup(ctx, "Org B");
    await complete(a, { issues: [{ clientId: "6a3f1b2c-1d2e-4f3a-8b4c-5d6e7f8a9b01", type: "pump_out", severity: "medium", description: "" }] });
    const issue = (await inboxOf(a)).items.find((i) => i.kind === "issue_open")!;
    expect((await inboxOf(b)).items.map((i) => i.key)).not.toContain(issue.key);
    expect((await b.api.post(`/issues/${issue.target.id}/resolve`, { resolution: "x" })).statusCode).toBe(404);
  });

  it("is for the office, not technicians", async () => {
    const s = await setup(ctx);
    expect((await s.techApi.get("/inbox")).statusCode).toBe(403);
    const ro = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, s.org.id, "read_only")).email));
    expect((await ro.get("/inbox")).statusCode).toBe(200);
  });
});
