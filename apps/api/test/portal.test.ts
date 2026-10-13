import { createHash } from "node:crypto";
import type { EmailMessage, EmailResult, EmailTransport } from "@aerowise/compliance";
import { drainTasks } from "@aerowise/tasks";
import { describe, expect, it } from "vitest";
import { client, createTenant, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, payload, setup, signAsProvider, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

const ctx = setupTestApp();

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
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail, appUrl: APP_URL });
const anon = () => client(ctx.app);
const tokenOf = (url: string) => url.split("/portal/")[1]!;
const emailsTo = (to: string) => [...mail.delivered.values()].filter((m) => m.to === to && m.idempotencyKey.startsWith("portal-link-"));

/** Completes the setup's inspection and makes its reports. */
async function inspected(s: Setup) {
  const clientId = payload(s).clientId;
  await s.techApi.put("/inspections/sync", payload(s));
  await uploadRequiredPhotos(s, clientId);
  const res = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: completeValues() }));
  expect(res.json().status).toBe("completed");
  await runWorker(ctx);
  return res.json() as { id: string };
}

async function copyLink(s: { api: ReturnType<typeof client>; customer: { id: string } }) {
  const res = await s.api.post(`/customers/${s.customer.id}/portal-link`, { send: false });
  expect(res.statusCode).toBe(201);
  return tokenOf(res.json().url);
}

describe("customer portal", () => {
  it("shows the customer their plan, next visit, own report copies and invoices", async () => {
    const s = await setup(ctx);
    const insp = await inspected(s);
    const draft = (await s.api.post("/invoices", { customerId: s.customer.id, siteId: s.site.id, lines: [{ description: "Filter", quantity: 1, unitPriceCents: 4500 }] })).json();
    expect((await s.api.post(`/invoices/${draft.id}/issue`, { send: false })).statusCode).toBe(200);

    const res = await s.api.post(`/customers/${s.customer.id}/portal-link`, { send: false });
    expect(res.json()).toMatchObject({ url: expect.stringMatching(/^http:\/\/localhost:3000\/portal\/[\w-]{43}$/), sentTo: null });
    const token = tokenOf(res.json().url);
    // Only a hash of the token is kept.
    const stored = await ctx.db.selectFrom("portalLinks").select(["tokenHash"]).executeTakeFirstOrThrow();
    expect(stored.tokenHash.toString("hex")).not.toContain(Buffer.from(token).toString("hex"));

    // Until the maintenance provider signs it, the customer's copy is neither listed nor served (30 TAC 285.7(b)(3)).
    const customerReport = await ctx.db.selectFrom("reports").select("id").where("inspectionId", "=", insp.id).where("audience", "=", "customer").executeTakeFirstOrThrow();
    expect((await anon().get(`/portal/${token}`)).json().sites[0].reports).toEqual([]);
    expect((await anon().get(`/portal/${token}/reports/${customerReport.id}`)).statusCode).toBe(404);
    await signAsProvider(s, insp.id);

    const view = await anon().get(`/portal/${token}`);
    expect(view.statusCode).toBe(200);
    const v = view.json();
    expect(v.customerName).toBe("Org A customer");
    expect(v.sites).toHaveLength(1);
    const site = v.sites[0];
    expect(site.address).toBe("1 Main St, Austin, TX");
    expect(site.system.manufacturer).toBe("Acme");
    expect(site.contract).toMatchObject({ planName: "Annual", state: "active", visitsPerTerm: 3, visitsDone: 1 });
    expect(site.nextVisit).toMatchObject({ dueOn: s.contract.obligations[1].dueOn, scheduledDate: null });
    expect(site.reports).toHaveLength(1);
    expect(site.reports[0].inspectedOn).toBe("2026-03-01");
    expect(v.invoices).toHaveLength(1);
    expect(v.invoices[0]).toMatchObject({ totalCents: 4500, amountDueCents: 4500, paymentStatus: "unpaid", payUrl: expect.stringContaining("/pay/") });
    expect(v.amountDueCents).toBe(4500);

    const pdf = await anon().get(site.reports[0].url);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    // It is the signed copy.
    const signature = await ctx.db.selectFrom("reportSignatures").select("sha256").where("reportId", "=", customerReport.id).executeTakeFirstOrThrow();
    expect(createHash("sha256").update(pdf.rawPayload).digest("hex")).toBe(signature.sha256);
    expect(pdf.headers["content-disposition"]).toContain("-signed.pdf");

    // The authority copy of the same inspection is not reachable from the portal.
    const authority = await ctx.db.selectFrom("reports").select("id").where("inspectionId", "=", insp.id).where("audience", "=", "authority").executeTakeFirstOrThrow();
    expect((await anon().get(`/portal/${token}/reports/${authority.id}`)).statusCode).toBe(404);

    // Using the link is recorded for the office.
    const access = (await s.api.get(`/customers/${s.customer.id}/portal`)).json();
    expect(access).toMatchObject({ activeLinks: 1, lastUsedAt: ctx.now.toISOString() });
  });

  it("never opens another customer's report, in the same organization or another", async () => {
    const s = await setup(ctx);
    await inspected(s);
    const report = await ctx.db.selectFrom("reports").select("id").where("audience", "=", "customer").executeTakeFirstOrThrow();

    // A second customer of the same provider.
    const other = (await s.api.post("/customers", { displayName: "Neighbor" })).json();
    const otherToken = await copyLink({ api: s.api, customer: other });
    expect((await anon().get(`/portal/${otherToken}`)).json().sites).toEqual([]);
    expect((await anon().get(`/portal/${otherToken}/reports/${report.id}`)).statusCode).toBe(404);

    // A customer of another provider.
    const b = await createTenant(ctx, "Org B");
    const bToken = await copyLink(b);
    expect((await anon().get(`/portal/${bToken}/reports/${report.id}`)).statusCode).toBe(404);

    // Made-up and edited tokens open nothing.
    const mine = await copyLink(s);
    const edited = mine.slice(0, -1) + (mine.endsWith("A") ? "B" : "A");
    expect((await anon().get(`/portal/${edited}`)).statusCode).toBe(404);
    expect((await anon().get(`/portal/${"x".repeat(43)}/reports/${report.id}`)).statusCode).toBe(404);
  });

  it("stops working once expired or revoked", async () => {
    const t = await createTenant(ctx, "Org A");
    const token = await copyLink(t);
    expect((await anon().get(`/portal/${token}`)).statusCode).toBe(200);

    ctx.now = new Date("2026-05-31T18:00:00Z"); // 91 days later
    const expired = await anon().get(`/portal/${token}`);
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error).toBe("expired");

    ctx.now = new Date("2026-03-01T18:00:00Z");
    const second = await copyLink(t);
    expect((await t.api.post(`/customers/${t.customer.id}/portal-links/revoke`, {})).json()).toEqual({ revoked: 2 });
    expect((await anon().get(`/portal/${second}`)).json()).toMatchObject({ error: "revoked" });
    expect((await t.api.get(`/customers/${t.customer.id}/portal`)).json().activeLinks).toBe(0);
  });

  it("emails a link to whoever asks with an address on file, and says the same thing either way", async () => {
    const t = await createTenant(ctx, "Org A");
    await t.api.post(`/customers/${t.customer.id}/contacts`, { name: "Billing", email: "Pat@Example.test", type: "billing" });

    const unknown = await anon().post("/portal/request", { email: "nobody@example.test" });
    const known = await anon().post("/portal/request", { email: "pat@example.test" });
    expect(unknown.statusCode).toBe(202);
    expect(known.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
    // Asking again straight away does not send a second email.
    await anon().post("/portal/request", { email: "PAT@example.test" });
    await runWorker(ctx);

    const sent = emailsTo("pat@example.test");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("Org A");
    const link = sent[0]!.text.match(/https:\/\/app\.example\.test\/portal\/([\w-]+)/)![1]!;
    expect((await anon().get(`/portal/${link}`)).json().customerName).toBe("Org A customer");
    expect(emailsTo("nobody@example.test")).toHaveLength(0);

    // No token ever reaches the task queue.
    const tasks = await ctx.db.selectFrom("backgroundTasks").select("payload").execute();
    expect(JSON.stringify(tasks)).not.toContain(link);
  });

  it("lets the office email the link, or says there is no address", async () => {
    const t = await createTenant(ctx, "Org A");
    const none = await t.api.post(`/customers/${t.customer.id}/portal-link`, { send: true });
    expect(none.statusCode).toBe(422);
    await t.api.post(`/customers/${t.customer.id}/contacts`, { name: "Billing", email: "office-sent@example.test", type: "billing" });
    const res = await t.api.post(`/customers/${t.customer.id}/portal-link`, { send: true });
    expect(res.json()).toEqual({ url: null, expiresAt: null, sentTo: "office-sent@example.test" });
    await runWorker(ctx);
    expect(emailsTo("office-sent@example.test")).toHaveLength(1);
    const access = (await t.api.get(`/customers/${t.customer.id}/portal`)).json();
    expect(access.links[0]).toMatchObject({ source: "office", sentTo: "office-sent@example.test", createdByName: "owner user" });
  });

  it("takes service requests for the customer's own properties into the office inbox", async () => {
    const t = await createTenant(ctx, "Org A");
    const token = await copyLink(t);
    const b = await createTenant(ctx, "Org B");

    // Not someone else's property.
    expect((await anon().post(`/portal/${token}/service-requests`, { siteId: b.site.id, kind: "alarm", description: "Alarm is beeping" })).statusCode).toBe(404);

    const res = await anon().post(`/portal/${token}/service-requests`, { siteId: t.site.id, kind: "alarm", description: "Alarm is beeping", contactPhone: "512-555-0100" });
    expect(res.statusCode).toBe(201);
    const { id } = res.json();

    const portal = (await anon().get(`/portal/${token}`)).json();
    expect(portal.sites[0].serviceRequests).toEqual([expect.objectContaining({ id, kind: "alarm", status: "open" })]);

    const inbox = (await t.api.get("/inbox")).json();
    const item = inbox.items.find((e: { kind: string }) => e.kind === "service_request");
    expect(item).toMatchObject({ severity: "high", target: { type: "service_request", id }, customer: { id: t.customer.id } });
    expect(item.detail).toContain("512-555-0100");
    expect((await b.api.get("/inbox")).json().items.some((e: { kind: string }) => e.kind === "service_request")).toBe(false);
    expect((await b.api.post(`/service-requests/${id}/resolve`, { resolution: "x" })).statusCode).toBe(404);

    const list = (await t.api.get(`/service-requests?customerId=${t.customer.id}`)).json();
    expect(list.items).toHaveLength(1);

    const closed = await t.api.post(`/service-requests/${id}/resolve`, { resolution: "Reset the alarm by phone" });
    expect(closed.json()).toMatchObject({ status: "closed", resolution: "Reset the alarm by phone" });
    expect((await t.api.post(`/service-requests/${id}/resolve`, { resolution: "again" })).statusCode).toBe(409);
    expect((await t.api.get("/inbox")).json().items.some((e: { kind: string }) => e.kind === "service_request")).toBe(false);
    expect((await anon().get(`/portal/${token}`)).json().sites[0].serviceRequests[0]).toMatchObject({ status: "closed", resolution: "Reset the alarm by phone" });
  });

  it("keeps the office side to signed-in staff with the right role", async () => {
    const t = await createTenant(ctx, "Org A");
    expect((await anon().post(`/customers/${t.customer.id}/portal-link`, { send: false })).statusCode).toBe(401);
    const b = await createTenant(ctx, "Org B");
    expect((await b.api.post(`/customers/${t.customer.id}/portal-link`, { send: false })).statusCode).toBe(404);
    expect((await b.api.get(`/customers/${t.customer.id}/portal`)).statusCode).toBe(404);
  });
});
