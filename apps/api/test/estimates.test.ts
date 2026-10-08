import type { EmailMessage, EmailResult, EmailTransport } from "@aerowise/compliance";
import { drainTasks, expiryRunAt } from "@aerowise/tasks";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";

class FakeMail implements EmailTransport {
  readonly name = "fake";
  delivered = new Map<string, EmailMessage>();
  async send(m: EmailMessage): Promise<EmailResult> {
    if (!this.delivered.has(m.idempotencyKey)) this.delivered.set(m.idempotencyKey, m);
    return { messageId: `<${m.idempotencyKey}@fake>`, acceptedAt: new Date().toISOString(), response: {} };
  }
}
const mail = new FakeMail();
const APP_URL = "https://app.example.test";
const ctx = setupTestApp({ features: ["work_orders", "service_items", "estimates"] });
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail, appUrl: APP_URL });
const anon = () => client(ctx.app);
const tokenOf = (url: string) => url.split("/estimate/")[1]!.split(/\s/)[0]!;

const LINES = [
  { description: "Replace aerator", quantity: 1, unitPriceCents: 45000, taxable: true },
  { description: "Labor", quantity: 1.5, unitPriceCents: 9000 },
  { description: "Riser lid", quantity: 1, unitPriceCents: 12000, taxable: true, optional: true, selectedByDefault: false },
  { description: "Alarm test", quantity: 1, unitPriceCents: 3000, optional: true },
];

async function tenant(c: TestContext, name = "Org A") {
  const t = await createTenant(c, name);
  await t.api.patch(`/contacts/${t.contact.id}`, { email: "pat@example.test" });
  return t;
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

async function draft(t: Tenant, body: Record<string, unknown> = {}) {
  const res = await t.api.post("/estimates", { siteId: t.site.id, lines: LINES, taxRateBps: 825, expiresOn: "2026-03-31", ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

/** Sends without email and returns a link for the homeowner. */
async function sent(t: Tenant, body: Record<string, unknown> = {}) {
  const e = await draft(t, body);
  const s = await t.api.post(`/estimates/${e.id}/send`, { email: false });
  expect(s.statusCode, s.body).toBe(200);
  const link = await t.api.post(`/estimates/${e.id}/link`, {});
  expect(link.statusCode, link.body).toBe(201);
  return { estimate: s.json(), token: tokenOf(link.json().url) };
}

const acceptBody = (version: number, selected: string[] = [], extra: Record<string, unknown> = {}) => ({ version, selectedOptionalLineIds: selected, signerName: "Pat Homeowner", signature: { kind: "typed" }, agree: true, ...extra });

async function count(c: TestContext, table: string, organizationId: string) {
  return Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(table)} where organization_id = ${organizationId}`.execute(c.db)).rows[0]!.n);
}

describe("estimates", () => {
  it("drafts with optional lines, computes totals like an invoice, and freezes a version when sent", async () => {
    const t = await tenant(ctx);
    const e = await draft(t);
    expect(e).toMatchObject({ number: 1001, label: "EST-1001", status: "draft", currentVersion: 1, versions: [], title: "Estimate" });
    // Required lines plus the alarm test (selected by default); the riser lid is left out.
    // Taxable 45000 at 8.25% = 3712.5 → 3713.
    expect(e.draft.totals).toEqual({ subtotalCents: 45000 + 13500 + 3000, discountCents: 0, taxableCents: 45000, taxCents: 3713, totalCents: 61500 + 3713 });
    expect(e.draft.lines.map((l: { quantityMilli: number; amountCents: number }) => [l.quantityMilli, l.amountCents])).toEqual([
      [1000, 45000],
      [1500, 13500],
      [1000, 12000],
      [1000, 3000],
    ]);

    const s = await t.api.post(`/estimates/${e.id}/send`, {});
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json()).toMatchObject({ status: "sent", versions: [{ version: 1, totals: { totalCents: 65213 }, expiresOn: "2026-03-31" }] });
    expect(s.json().versions[0].contentSha256).toMatch(/^[0-9a-f]{64}$/);
    // A sent estimate is changed only by revising it; its version never changes.
    expect((await t.api.patch(`/estimates/${e.id}`, { title: "Changed" })).statusCode).toBe(409);
    await expect(sql`update estimate_versions set discount_cents = 1`.execute(ctx.db)).rejects.toThrow(/never changed/);

    await runWorker(ctx);
    const emails = [...mail.delivered.values()].filter((m) => m.to === "pat@example.test" && m.idempotencyKey.startsWith(`estimate-${e.id}-email-`));
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toContain("Your estimate from Org A");
    const token = tokenOf(emails[0]!.text);
    // Only a hash of the link is stored.
    const links = await ctx.db.selectFrom("estimateLinks").select(["tokenHash"]).execute();
    expect(links.some((l) => l.tokenHash.toString("hex").includes(Buffer.from(token).toString("hex")))).toBe(false);
    const pub = await anon().get(`/estimate/${token}`);
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json()).toMatchObject({ status: "sent", label: "EST-1001", customerName: "Org A customer", version: { version: 1, totals: { totalCents: 65213 } }, beingRevised: false, accepted: null });
  });

  it("accepts with a signature and chosen options exactly once, creating one work order with the accepted lines", async () => {
    const t = await tenant(ctx);
    const { estimate, token } = await sent(t);
    const [, , riser] = estimate.versions[0].lines as { id: string }[];
    await anon().post(`/estimate/${token}/view`, {});
    expect((await t.api.get(`/estimates/${estimate.id}`)).json().status).toBe("viewed");

    // A line that is not an option cannot be "chosen".
    const bad = await anon().post(`/estimate/${token}/accept`, acceptBody(1, [estimate.versions[0].lines[0].id]));
    expect(bad.statusCode).toBe(422);
    expect((await anon().post(`/estimate/${token}/accept`, { ...acceptBody(1), agree: false })).statusCode).toBe(400);

    // Adds the riser lid, leaves out the alarm test.
    const [a, b] = await Promise.all([anon().post(`/estimate/${token}/accept`, acceptBody(1, [riser!.id])), anon().post(`/estimate/${token}/accept`, acceptBody(1, [riser!.id]))]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().alreadyAccepted, b.json().alreadyAccepted].sort()).toEqual([false, true]);

    const d = (await t.api.get(`/estimates/${estimate.id}`)).json();
    // 45000 + 13500 + 12000; taxable 57000 → 4703 tax (4702.5 rounds half up).
    expect(d).toMatchObject({
      status: "accepted",
      acceptance: { version: 1, kind: "signature", selectedOptionalLineIds: [riser!.id], signerName: "Pat Homeowner", signatureKind: "typed", totals: { subtotalCents: 70500, taxCents: 4703, totalCents: 75203 }, evidence: null },
      workOrder: { label: "WO-1001", status: "open" },
    });
    expect(d.acceptance.documentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.events.map((e: { eventType: string }) => e.eventType)).toEqual(["created", "sent", "viewed", "accepted", "converted"]);
    expect(await count(ctx, "work_orders", t.org.id)).toBe(1);
    expect(await count(ctx, "signed_documents", t.org.id)).toBe(1);

    const wo = (await t.api.get(`/work-orders/${d.workOrder.id}`)).json();
    expect(wo).toMatchObject({ sourceKind: "estimate", sourceId: estimate.id, title: "Estimate", source: { label: "Estimate" }, linesTotalCents: 70500 });
    expect(wo.lines.map((l: { description: string }) => l.description)).toEqual(["Replace aerator", "Labor", "Riser lid"]);
    expect(wo.lines.map((l: { description: string }) => l.description)).not.toContain("Alarm test");

    const doc = await ctx.db.selectFrom("signedDocuments").selectAll().executeTakeFirstOrThrow();
    expect(doc).toMatchObject({ kind: "estimate_acceptance", estimateId: estimate.id, signerName: "Pat Homeowner", renewalId: null });
    expect((doc.content as { totals: { totalCents: number }; versionSha256: string }).totals.totalCents).toBe(75203);
    expect((doc.content as { versionSha256: string }).versionSha256).toBe(estimate.versions[0].contentSha256);

    // After acceptance the link shows the acceptance; declining or accepting another version is refused.
    expect((await anon().get(`/estimate/${token}`)).json()).toMatchObject({ status: "accepted", accepted: { version: 1, kind: "signature", signerName: "Pat Homeowner", totals: { totalCents: 75203 } } });
    expect((await anon().post(`/estimate/${token}/decline`, {})).statusCode).toBe(409);
    expect((await anon().post(`/estimate/${token}/accept`, acceptBody(2))).statusCode).toBe(409);
  });

  it("refuses a stale version after a revision, and accepts the new one", async () => {
    const t = await tenant(ctx);
    const { estimate, token } = await sent(t);
    const rev = await t.api.post(`/estimates/${estimate.id}/revise`, {});
    expect(rev.statusCode, rev.body).toBe(200);
    expect(rev.json()).toMatchObject({ status: "draft", currentVersion: 2 });
    // While the revision is drafted the link waits for it.
    expect((await anon().get(`/estimate/${token}`)).json()).toMatchObject({ status: "draft", beingRevised: true, version: { version: 1 } });
    expect((await anon().post(`/estimate/${token}/accept`, acceptBody(1))).statusCode).toBe(409);

    await t.api.patch(`/estimates/${estimate.id}`, { discountCents: 5000 });
    await t.api.post(`/estimates/${estimate.id}/send`, { email: false });
    const stale = await anon().post(`/estimate/${token}/accept`, acceptBody(1));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("estimate_revised");
    const ok = await anon().post(`/estimate/${token}/accept`, acceptBody(2));
    expect(ok.statusCode, ok.body).toBe(200);
    const d = (await t.api.get(`/estimates/${estimate.id}`)).json();
    expect(d.versions.map((v: { version: number; discountCents: number }) => [v.version, v.discountCents])).toEqual([
      [1, 0],
      [2, 5000],
    ]);
    expect(d.acceptance).toMatchObject({ version: 2, totals: { discountCents: 5000 } });
  });

  it("declines with a reason, voids, and expires after its last day in the company's timezone", async () => {
    const t = await tenant(ctx);
    const a = await sent(t);
    expect((await anon().post(`/estimate/${a.token}/decline`, { reason: "Too expensive" })).statusCode).toBe(200);
    expect((await t.api.get(`/estimates/${a.estimate.id}`)).json()).toMatchObject({ status: "declined", declinedReason: "Too expensive" });

    const b = await sent(t);
    expect((await t.api.post(`/estimates/${b.estimate.id}/void`, { reason: "Wrong site" })).statusCode).toBe(200);
    expect((await anon().get(`/estimate/${b.token}`)).json().status).toBe("void");
    expect((await anon().post(`/estimate/${b.token}/accept`, acceptBody(1))).statusCode).toBe(409);

    const c = await sent(t);
    // March 31 is still good in Central time at 23:30 local (05:30Z April 1).
    ctx.now = new Date("2026-04-01T04:30:00Z");
    expect((await anon().get(`/estimate/${c.token}`)).json().status).toBe("sent");
    ctx.now = new Date("2026-04-01T05:30:00Z");
    await runWorker(ctx);
    expect((await t.api.get(`/estimates/${c.estimate.id}`)).json()).toMatchObject({ status: "expired" });
    expect((await anon().post(`/estimate/${c.token}/accept`, acceptBody(1))).statusCode).toBe(409);
    expect(expiryRunAt("2026-03-31", "America/Chicago").toISOString()).toBe("2026-04-01T05:00:00.000Z");
  });

  it("expires on the link itself when the worker has not run yet", async () => {
    const t = await tenant(ctx);
    const { estimate, token } = await sent(t);
    ctx.now = new Date("2026-04-02T18:00:00Z");
    const res = await anon().post(`/estimate/${token}/accept`, acceptBody(1));
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("expired");
    expect((await t.api.get(`/estimates/${estimate.id}`)).json().status).toBe("expired");
    expect(await count(ctx, "work_orders", t.org.id)).toBe(0);
  });

  it("records a paper approval with evidence, never as an e-signature", async () => {
    const t = await tenant(ctx);
    const e = await draft(t);
    expect((await t.api.post(`/estimates/${e.id}/record-acceptance`, { selectedOptionalLineIds: [] })).statusCode).toBe(400);
    const r = await t.api.post(`/estimates/${e.id}/record-acceptance`, { selectedOptionalLineIds: [], evidence: "Signed paper copy in the truck file, 2026-03-01" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      status: "accepted",
      acceptance: { kind: "office_recorded", evidence: "Signed paper copy in the truck file, 2026-03-01", signerName: null, documentSha256: null, recordedByName: "owner user" },
      workOrder: { label: "WO-1001" },
      versions: [{ version: 1 }],
    });
    expect(await count(ctx, "signed_documents", t.org.id)).toBe(0);
    // Recording again is refused, not a second work order.
    expect((await t.api.post(`/estimates/${e.id}/record-acceptance`, { evidence: "again" })).statusCode).toBe(409);
    expect(await count(ctx, "work_orders", t.org.id)).toBe(1);
  });

  it("cancels after acceptance with its work order, unless work was done", async () => {
    const t = await tenant(ctx);
    const tech = await createUser(ctx.db, t.org.id, "technician");
    const a = await sent(t);
    await anon().post(`/estimate/${a.token}/accept`, acceptBody(1));
    const woId = (await t.api.get(`/estimates/${a.estimate.id}`)).json().workOrder.id;
    await t.api.post(`/work-orders/${woId}/schedule`, { technicianId: tech.id, scheduledDate: "2026-03-05" });
    const c = await t.api.post(`/estimates/${a.estimate.id}/cancel`, { reason: "Customer changed their mind" });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ status: "cancelled", cancelReason: "Customer changed their mind", workOrder: { status: "cancelled" } });
    const wo = (await t.api.get(`/work-orders/${woId}`)).json();
    expect(wo.visits).toMatchObject([{ status: "cancelled" }]);
    // The source is free again: a new estimate for the same issue could be made.

    const b = await sent(t);
    await anon().post(`/estimate/${b.token}/accept`, acceptBody(1));
    const wo2 = (await t.api.get(`/estimates/${b.estimate.id}`)).json().workOrder.id;
    await t.api.post(`/work-orders/${wo2}/complete`, { reason: "Done on paper" });
    const blocked = await t.api.post(`/estimates/${b.estimate.id}/cancel`, { reason: "Too late" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("work_started");
  });

  it("refuses to cancel while the work order's own invoice is live, draft or issued, and allows it once discarded or voided", async () => {
    const t = await tenant(ctx);
    const acceptedOrder = async () => {
      const a = await sent(t);
      expect((await anon().post(`/estimate/${a.token}/accept`, acceptBody(1))).statusCode).toBe(200);
      return { estimateId: a.estimate.id as string, woId: (await t.api.get(`/estimates/${a.estimate.id}`)).json().workOrder.id as string };
    };

    // An open work order invoiced before any visit (SW-3 links it by invoices.work_order_id, with no job lines).
    const a = await acceptedOrder();
    const draftInvoice = await t.api.post(`/work-orders/${a.woId}/invoice`, {});
    expect(draftInvoice.statusCode, draftInvoice.body).toBe(201);
    const blockedDraft = await t.api.post(`/estimates/${a.estimateId}/cancel`, { reason: "Changed their mind" });
    expect(blockedDraft.statusCode, blockedDraft.body).toBe(409);
    expect(blockedDraft.json().error).toBe("work_started");
    expect((await t.api.get(`/work-orders/${a.woId}`)).json().status).toBe("open");
    const discarded = await t.api.post(`/invoices/${draftInvoice.json().invoiceId}/discard`, {});
    expect(discarded.statusCode, discarded.body).toBe(204);
    const allowed = await t.api.post(`/estimates/${a.estimateId}/cancel`, { reason: "Changed their mind" });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json()).toMatchObject({ status: "cancelled", workOrder: { status: "cancelled" } });

    // The same with the invoice issued, then voided.
    const b = await acceptedOrder();
    const inv = { id: (await t.api.post(`/work-orders/${b.woId}/invoice`, {})).json().invoiceId as string };
    const issued = await t.api.post(`/invoices/${inv.id}/issue`, { send: false });
    expect(issued.statusCode, issued.body).toBe(200);
    expect((await t.api.post(`/estimates/${b.estimateId}/cancel`, { reason: "Changed their mind" })).statusCode).toBe(409);
    expect((await t.api.post(`/invoices/${inv.id}/void`, { reason: "Billed in error" })).statusCode).toBe(200);
    expect((await t.api.post(`/estimates/${b.estimateId}/cancel`, { reason: "Changed their mind" })).statusCode).toBe(200);
  });

  it("never leaves a cancelled work order with a live invoice when invoicing and cancelling race", async () => {
    const t = await tenant(ctx);
    for (let i = 0; i < 3; i++) {
      const a = await sent(t);
      expect((await anon().post(`/estimate/${a.token}/accept`, acceptBody(1))).statusCode).toBe(200);
      const woId = (await t.api.get(`/estimates/${a.estimate.id}`)).json().workOrder.id as string;
      const [inv, cancel] = await Promise.all([t.api.post(`/work-orders/${woId}/invoice`, {}), t.api.post(`/estimates/${a.estimate.id}/cancel`, { reason: "Race" })]);
      // Exactly one wins: either the invoice exists and the cancel was refused, or the cancel went through and invoicing was refused.
      expect([inv.statusCode, cancel.statusCode].sort(), inv.body + cancel.body).toEqual(inv.statusCode === 201 ? [201, 409] : [200, 409]);
      const wo = await ctx.db.selectFrom("workOrders").select("status").where("id", "=", woId).executeTakeFirstOrThrow();
      const live = await ctx.db.selectFrom("invoices").select("id").where("workOrderId", "=", woId).where("status", "<>", "void").execute();
      expect(wo.status === "cancelled" && live.length > 0).toBe(false);
    }
  });

  it("invoices accepted work at the accepted version's discount and tax rate, not the company's current defaults", async () => {
    const t = await tenant(ctx);
    const other = await tenant(ctx, "Org B");
    await t.api.patch("/billing/settings", { defaultTaxRateBps: 0 });
    const a = await sent(t, { discountCents: 5000 });
    const accepted = await anon().post(`/estimate/${a.token}/accept`, acceptBody(1, []));
    expect(accepted.statusCode, accepted.body).toBe(200);
    const detail = (await t.api.get(`/estimates/${a.estimate.id}`)).json();
    const woId = detail.workOrder.id as string;
    expect(detail.acceptance.totals).toEqual({ subtotalCents: 58500, discountCents: 5000, taxableCents: 41154, taxCents: 3395, totalCents: 56895 });
    // The company's rate changes after acceptance; the accepted price does not.
    await t.api.patch("/billing/settings", { defaultTaxRateBps: 500 });
    await other.api.patch("/billing/settings", { defaultTaxRateBps: 300 });
    const invoiceOf = async () => {
      const r = await t.api.post(`/work-orders/${woId}/invoice`, {});
      expect(r.statusCode, r.body).toBe(201);
      return (await t.api.get(`/invoices/${r.json().invoiceId}`)).json();
    };

    // Unchanged work bills exactly what was accepted.
    const first = await invoiceOf();
    expect(first).toMatchObject({ taxRateBps: 825, discountCents: 5000, subtotalCents: 58500, taxCents: 3395, totalCents: 56895 });

    // Its replacement after a void starts from the accepted price too.
    expect((await t.api.post(`/invoices/${first.id}/issue`, { send: false })).statusCode).toBe(200);
    expect((await t.api.post(`/invoices/${first.id}/void`, { reason: "Billed in error" })).statusCode).toBe(200);
    const second = await invoiceOf();
    expect(second).toMatchObject({ taxRateBps: 825, discountCents: 5000, totalCents: 56895 });

    // Actual work that differs is still billed as done, at the accepted rate and discount.
    expect((await t.api.post(`/invoices/${second.id}/discard`, {})).statusCode).toBe(204);
    const wo = (await t.api.get(`/work-orders/${woId}`)).json();
    const lines = [...wo.lines.map((l: { description: string; quantity: number; unitPriceCents: number; taxable: boolean }) => ({ description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, taxable: l.taxable })), { description: "Extra riser", quantity: 1, unitPriceCents: 10000, taxable: true }];
    const edited = await t.api.patch(`/work-orders/${woId}`, { lines });
    expect(edited.statusCode, edited.body).toBe(200);
    const third = await invoiceOf();
    expect(third).toMatchObject({ taxRateBps: 825, discountCents: 5000, subtotalCents: 68500 });

    // The office can still change the draft's rate and discount, and other companies' work keeps their own defaults.
    const changed = await t.api.patch(`/invoices/${third.id}`, { discountCents: 0, taxRateBps: 500, lines: third.lines.map((l: { id: string; description: string; quantity: number; unitPriceCents: number; taxable: boolean }) => ({ id: l.id, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, taxable: l.taxable })) });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ taxRateBps: 500, discountCents: 0 });
    const types = (await other.api.get("/work-types")).json().items as { id: string; key: string }[];
    const plain = await other.api.post("/work-orders", { siteId: other.site.id, workTypeId: types[0]!.id, lines: [{ description: "Labor", quantity: 1, unitPriceCents: 9000, taxable: true }], ready: true });
    expect(plain.statusCode, plain.body).toBe(201);
    const plainInvoice = await other.api.post(`/work-orders/${plain.json().id}/invoice`, {});
    expect(plainInvoice.statusCode, plainInvoice.body).toBe(201);
    expect((await other.api.get(`/invoices/${plainInvoice.json().invoiceId}`)).json()).toMatchObject({ taxRateBps: 300, discountCents: 0 });
    // Org B cannot invoice Org A's accepted work.
    expect((await other.api.post(`/work-orders/${woId}/invoice`, {})).statusCode).toBe(404);
  });

  it("drafts one estimate per inspection issue or request however often it is asked", async () => {
    const t = await tenant(ctx);
    const sr = await ctx.db
      .insertInto("serviceRequests")
      .values({ organizationId: t.org.id, customerId: t.customer.id, siteId: t.site.id, kind: "repair", description: "Alarm keeps going off", source: "office", receivedAt: ctx.now } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    const [x, y] = await Promise.all([t.api.post(`/service-requests/${sr.id}/estimate`, {}), t.api.post(`/service-requests/${sr.id}/estimate`, {})]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 201]);
    expect(x.json().id).toBe(y.json().id);
    expect(x.json()).toMatchObject({ source: { kind: "portal_request" }, title: "Something needs repair", workType: { name: "Repair" } });
    // Withdrawn, the request can have a new one.
    await t.api.post(`/estimates/${x.json().id}/void`, { reason: "Start over" });
    const z = await t.api.post(`/service-requests/${sr.id}/estimate`, {});
    expect(z.statusCode).toBe(201);
    expect(z.json().id).not.toBe(x.json().id);
  });

  it("keeps companies apart and prices away from technicians", async () => {
    const a = await tenant(ctx, "Org A");
    const b = await tenant(ctx, "Org B");
    const e = await draft(a);
    expect((await b.api.get(`/estimates/${e.id}`)).statusCode).toBe(404);
    expect((await b.api.post(`/estimates/${e.id}/send`, {})).statusCode).toBe(404);
    expect((await b.api.post("/estimates", { siteId: a.site.id, lines: LINES })).statusCode).toBe(404);
    const tech = await createUser(ctx.db, a.org.id, "technician");
    const techApi = client(ctx.app, await login(ctx.app, tech.email));
    expect((await techApi.get("/estimates")).statusCode).toBe(403);
    const ro = await createUser(ctx.db, a.org.id, "read_only");
    const roApi = client(ctx.app, await login(ctx.app, ro.email));
    expect((await roApi.get("/estimates")).json().total).toBe(1);
    expect((await roApi.post("/estimates", { siteId: a.site.id, lines: LINES })).statusCode).toBe(403);
    expect((await anon().get(`/estimate/${"x".repeat(43)}`)).statusCode).toBe(404);
  });

  it("refuses new estimates with the feature off, and keeps existing ones readable", async () => {
    const t = await tenant(ctx);
    const e = await draft(t);
    const off = await buildApp({ db: ctx.db, loginRateLimit: 1000, now: () => ctx.now, store: ctx.store, features: new Set(["work_orders"]) });
    try {
      const api = client(off, await login(off, t.owner.email));
      const res = await api.post("/estimates", { siteId: t.site.id, lines: LINES });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("feature_off");
      expect((await api.get(`/estimates/${e.id}`)).statusCode).toBe(200);
    } finally {
      await off.close();
    }
  });
  it("refuses accepting nothing when every line is optional, on the homeowner's link and the office's record, leaving nothing behind", async () => {
    const t = await tenant(ctx);
    const allOptional = LINES.map((l) => ({ ...l, optional: true, selectedByDefault: false }));
    const { estimate, token } = await sent(t, { lines: allOptional });
    const before = { docs: await count(ctx, "signed_documents", t.org.id), orders: await count(ctx, "work_orders", t.org.id) };

    const signed = await anon().post(`/estimate/${token}/accept`, acceptBody(1, []));
    expect(signed.statusCode, signed.body).toBe(422);
    expect(signed.json()).toMatchObject({ error: "nothing_chosen", message: "Choose at least one item to accept this estimate." });
    const recorded = await t.api.post(`/estimates/${estimate.id}/record-acceptance`, { selectedOptionalLineIds: [], evidence: "Phoned in, nothing chosen" });
    expect(recorded.statusCode, recorded.body).toBe(422);
    expect(recorded.json().error).toBe("nothing_chosen");

    // No signature, work order or acceptance was kept.
    expect(await count(ctx, "signed_documents", t.org.id)).toBe(before.docs);
    expect(await count(ctx, "work_orders", t.org.id)).toBe(before.orders);
    const after = (await t.api.get(`/estimates/${estimate.id}`)).json();
    expect(after).toMatchObject({ status: "sent", acceptance: null, workOrder: null });

    // Choosing one option still works, exactly once.
    const one = estimate.versions[0].lines[1].id as string;
    const [a, b] = await Promise.all([anon().post(`/estimate/${token}/accept`, acceptBody(1, [one])), anon().post(`/estimate/${token}/accept`, acceptBody(1, [one]))]);
    expect([a.statusCode, b.statusCode], a.body + b.body).toEqual([200, 200]);
    expect([a.json().alreadyAccepted, b.json().alreadyAccepted].sort()).toEqual([false, true]);
    const done = (await t.api.get(`/estimates/${estimate.id}`)).json();
    const lines = await ctx.db.selectFrom("workOrderLines").select("description").where("workOrderId", "=", done.workOrder.id).execute();
    expect(lines).toEqual([{ description: "Labor" }]);
    expect(await count(ctx, "work_orders", t.org.id)).toBe(before.orders + 1);
  });

  it("refuses an office-recorded acceptance of nothing on a draft too, without freezing a version", async () => {
    const t = await tenant(ctx);
    const e = await draft(t, { lines: [{ description: "Optional pump-out", quantity: 1, unitPriceCents: 30000, optional: true }] });
    const r = await t.api.post(`/estimates/${e.id}/record-acceptance`, { selectedOptionalLineIds: [], evidence: "Phoned in" });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toBe("nothing_chosen");
    expect((await t.api.get(`/estimates/${e.id}`)).json()).toMatchObject({ status: "draft", versions: [], acceptance: null, workOrder: null });
    expect(await count(ctx, "work_orders", t.org.id)).toBe(0);
  });

  it("refuses to ask for a deposit with the deposits feature off, and drafts without one as before", async () => {
    const t = await tenant(ctx);
    const res = await t.api.post("/estimates", { siteId: t.site.id, lines: LINES, depositCents: 10000 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "feature_off" });
    const e = await draft(t);
    expect((await t.api.patch(`/estimates/${e.id}`, { depositCents: 5000 })).statusCode).toBe(409);
    expect((await t.api.patch(`/estimates/${e.id}`, { depositCents: null })).statusCode).toBe(200);
    const accepted = (await t.api.post(`/estimates/${e.id}/record-acceptance`, { evidence: "Phone" })).json();
    expect(accepted).toMatchObject({ status: "accepted", deposit: null, versions: [{ depositCents: null }] });
  });
});
