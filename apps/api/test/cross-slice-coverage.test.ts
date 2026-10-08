import { type Feature, snapshotSha256 } from "@aerowise/domain";
import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp } from "./helpers.ts";
import { JPEG } from "./inspection-helpers.ts";

// Coverage (SW-8) across the other ways a work order closes: an accepted estimate cancelled
// (SW-5a), and the final visit completed on the phone or attached from a held record (SW-2).
// A reserved use goes back when the work is cancelled and is spent when no-charge work is
// completed, whichever route closes it. The pinned clock is 2026-03-01.

const ON: Feature[] = ["work_orders", "service_items", "field_work", "estimates", "plan_builder"];
const ctx = setupTestApp({ features: ON });

type Tenant = Awaited<ReturnType<typeof createTenant>>;

const REPAIRS = [{ ruleKey: "repairs", label: "Repairs", match: { category: "repair" }, effect: "included", limit: { count: 1, per: "term" } }];

/** A plan covering one repair a term, and a contract on the tenant's site from 2026-01-01. */
async function covered(t: Tenant) {
  const plan = (await t.api.post("/plans", { name: "Gold", termMonths: 12, visitsPerTerm: 2, priceCents: 40000 })).json();
  const v = await t.api.post(`/plans/${plan.id}/versions`, { termsText: "Fictional test terms.", options: [], coverage: REPAIRS });
  expect(v.statusCode, v.body).toBe(201);
  const c = await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2026-01-01" });
  expect(c.statusCode, c.body).toBe(201);
}

const uses = (workOrderId: string) => ctx.db.selectFrom("coverageUses").select(["state", "invoiceId", "reason"]).where("workOrderId", "=", workOrderId).execute();

async function apply(t: Tenant, workOrderId: string) {
  const r = await t.api.post(`/work-orders/${workOrderId}/coverage/apply`, {});
  expect(r.statusCode, r.body).toBe(200);
  expect(await uses(workOrderId)).toEqual([expect.objectContaining({ state: "reserved" })]);
}

/** A repair order (no charge unless told otherwise) scheduled today for a technician, with coverage applied. */
async function scheduledNoCharge(t: Tenant, billing: "no_charge" | "unbilled" = "no_charge") {
  await covered(t);
  const tech = await createUser(ctx.db, t.org.id, "technician");
  const techApi = client(ctx.app, await login(ctx.app, tech.email));
  const repair = ((await t.api.get("/work-types")).json().items as { id: string; key: string }[]).find((x) => x.key === "repair")!;
  const wo = (await t.api.post("/work-orders", { siteId: t.site.id, workTypeId: repair.id, requestedOn: "2026-03-01" })).json();
  if (billing === "no_charge") expect((await t.api.patch(`/work-orders/${wo.id}`, { billingStatus: "no_charge" })).statusCode).toBe(200);
  await apply(t, wo.id);
  const scheduled = await t.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: tech.id, scheduledDate: "2026-03-01" });
  expect(scheduled.statusCode, scheduled.body).toBe(201);
  const jobId = scheduled.json().visits[0].jobId as string;
  const form = (await techApi.get("/form-templates/work-repair")).json();
  const clientId = crypto.randomUUID();
  const summary = { workDone: "Reset alarm", parts: [], notes: "Alarm tested" };
  const sync = (status: "draft" | "completed", revision: number) =>
    techApi.put("/work/sync", {
      clientId,
      jobId,
      templateId: form.id,
      status,
      revision,
      arrivedAt: "2026-03-01T15:00:00Z",
      completedAt: status === "completed" ? "2026-03-01T16:00:00Z" : null,
      values: { problem: "Alarm sounding", work_performed: "Reset alarm", follow_up_needed: false },
      summary,
    });
  /** Everything for the visit in the phone's order: draft, both photos, signature, completion. */
  const sendAll = async () => {
    const out = [await sync("draft", 1)];
    for (const key of ["before", "after"]) out.push(await techApi.putImage(`/work/${clientId}/photos/${crypto.randomUUID()}`, JPEG, { "x-photo-key": key }));
    out.push(
      await techApi.put(`/work/${clientId}/signatures/${crypto.randomUUID()}`, {
        requirementKey: "customer_signoff",
        signerName: "Pat Homeowner",
        capture: { kind: "typed" },
        summary,
        summarySha256: await snapshotSha256(summary),
        consentText: "I confirm this work was done.",
        signedAt: "2026-03-01T15:55:00Z",
      }),
    );
    out.push(await sync("completed", 2));
    return out;
  };
  return { wo, jobId, sendAll };
}

describe("coverage across estimates and field work", () => {
  it("cancelling an accepted estimate gives back the coverage its work order reserved", async () => {
    const t = await createTenant(ctx, "Org A");
    await covered(t);
    const e = (await t.api.post("/estimates", { siteId: t.site.id, lines: [{ description: "Repair", quantity: 1, unitPriceCents: 9500 }], expiresOn: "2026-03-31" })).json();
    const accepted = await t.api.post(`/estimates/${e.id}/record-acceptance`, { evidence: "Signed paper copy, 2026-03-01" });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const workOrderId = accepted.json().workOrderId as string;
    await apply(t, workOrderId);

    const cancelled = await t.api.post(`/estimates/${e.id}/cancel`, { reason: "Customer changed their mind" });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await t.api.get(`/work-orders/${workOrderId}`)).json().status).toBe("cancelled");
    expect(await uses(workOrderId)).toEqual([expect.objectContaining({ state: "released", reason: "Work order cancelled" })]);
  });

  it("completing no-charge work on the phone spends its reserved coverage, as the office's completion does", async () => {
    const t = await createTenant(ctx, "Org A");
    const s = await scheduledNoCharge(t);
    const sent = await s.sendAll();
    expect(sent.map((r) => r.statusCode)).toEqual([200, 201, 201, 201, 200]);
    expect(sent[4]!.json()).toMatchObject({ status: "completed", finalVisit: true });
    expect((await t.api.get(`/work-orders/${s.wo.id}`)).json().status).toBe("completed");
    expect(await uses(s.wo.id)).toEqual([expect.objectContaining({ state: "consumed", invoiceId: null })]);
    // A replay changes nothing.
    await s.sendAll();
    expect(await uses(s.wo.id)).toEqual([expect.objectContaining({ state: "consumed", invoiceId: null })]);
  });

  it("the office attaching a held final record to no-charge work spends its reserved coverage", async () => {
    const t = await createTenant(ctx, "Org A");
    const s = await scheduledNoCharge(t);
    expect((await t.api.post(`/jobs/${s.jobId}/cancel`, { reason: "Wrong day" })).statusCode).toBe(204);
    await s.sendAll();
    expect(await uses(s.wo.id)).toEqual([expect.objectContaining({ state: "reserved" })]);
    const [c] = (await t.api.get("/work/conflicts?status=held")).json().items;
    const attached = await t.api.post(`/work/conflicts/${c.id}/attach`, { note: "Work was done before the cancel" });
    expect(attached.statusCode, attached.body).toBe(200);
    expect((await t.api.get(`/work-orders/${s.wo.id}`)).json().status).toBe("completed");
    expect(await uses(s.wo.id)).toEqual([expect.objectContaining({ state: "consumed", invoiceId: null })]);
  });

  it("billed work completed on the phone keeps its coverage reserved for the invoice", async () => {
    const t = await createTenant(ctx, "Org A");
    const s = await scheduledNoCharge(t, "unbilled");
    await s.sendAll();
    expect((await t.api.get(`/work-orders/${s.wo.id}`)).json()).toMatchObject({ status: "completed", billingStatus: "unbilled" });
    expect(await uses(s.wo.id)).toEqual([expect.objectContaining({ state: "reserved" })]);
  });
});
