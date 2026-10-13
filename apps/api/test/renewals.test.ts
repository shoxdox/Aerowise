import type { EmailMessage, EmailResult, EmailTransport } from "@aerowise/compliance";
import { agreementContent } from "@aerowise/domain";
import { canonicalJson, sha256Hex } from "@aerowise/renewals";
import { drainTasks, linkToken } from "@aerowise/tasks";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { client, createTenant, setupTestApp, type TestContext } from "./helpers.ts";

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
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail, appUrl: "https://app.example.test" });
const anon = () => client(ctx.app);

// A 1x1 transparent PNG, as the signature pad would send it.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * A tenant with a billing email, Stripe connected, a 12-month plan with 2 visits at $300,
 * and a contract that ends on 2026-03-31 (the pinned clock is 2026-03-01).
 */
async function renewalTenant(c: TestContext, name = "Org A", opts: { email?: boolean; autoRenew?: boolean; billing?: "annual" | "monthly" } = {}) {
  const t = await createTenant(c, name);
  if (opts.email !== false) await t.api.post(`/customers/${t.customer.id}/contacts`, { name: "Billing", email: `billing@${name.replace(/\W/g, "").toLowerCase()}.test`, type: "billing" });
  expect((await t.api.post("/billing/stripe/connect", {})).statusCode).toBe(200);
  await t.api.post("/billing/stripe/refresh", {});
  const plan = (await t.api.post("/plans", { name: "Standard", termMonths: 12, visitsPerTerm: 2, priceCents: 30000, billingFrequency: opts.billing ?? "annual" })).json();
  const contract = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2025-04-01", autoRenew: opts.autoRenew ?? false })).json();
  expect(contract.endOn).toBe("2026-03-31");
  return { ...t, plan, contract };
}

async function startRenewal(t: Awaited<ReturnType<typeof renewalTenant>>, send = false) {
  const res = await t.api.post(`/contracts/${t.contract.id}/renewal`, { send });
  expect(res.statusCode).toBe(201);
  const r = res.json();
  return { ...r, token: (r.link as string).split("/renew/")[1]! };
}

const signBody = (version: number, extra: object = {}) => ({
  version,
  contact: { email: "new-email@example.test", phone: "512-555-0100" },
  signerName: "Pat Homeowner",
  signature: { kind: "typed" },
  agree: true,
  ...extra,
});

/** Pays the renewal through the test checkout, the way the homeowner's browser does. */
async function payOnline(token: string) {
  const checkout = await anon().post(`/renew/${token}/checkout`, {});
  expect(checkout.statusCode).toBe(200);
  const url = new URL(checkout.json().url);
  expect(url.searchParams.get("done")).toBe(`/renew/${token}?paid=1`);
  const invToken = url.pathname.split("/")[2]!;
  const done = await anon().post(`/pay/${invToken}/test-checkout`, { sessionId: url.searchParams.get("session"), outcome: "card" });
  expect(done.json().ok).toBe(true);
}

describe("renewal campaign", () => {
  it("starts renewals for contracts inside the window once, and emails them only when automatic emails are on", async () => {
    const t = await renewalTenant(ctx);
    // A contract ending outside the 60-day window is left alone.
    const site2 = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "2 Oak Ln", city: "Austin" })).json();
    await t.api.post(`/sites/${site2.id}/contracts`, { planId: t.plan.id, startOn: "2025-09-01" });

    const first = (await t.api.post("/renewals/campaign", {})).json();
    expect(first).toMatchObject({ created: 1, sent: 0 });
    const list = (await t.api.get("/renewals")).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ status: "upcoming", startOn: "2026-04-01", endOn: "2027-03-31", priceCents: 30000, contractEndOn: "2026-03-31", hasEmail: true });
    expect(list.counts).toEqual({ upcoming: 1 });
    expect((await t.api.post("/renewals/campaign", {})).json().created).toBe(0);

    // The contract shows its renewal.
    expect((await t.api.get(`/contracts/${t.contract.id}`)).json()).toMatchObject({ renewalStatus: "upcoming", renewalId: list.items[0].id });

    expect((await t.api.patch("/renewals/settings", { autoSend: true })).json().autoSend).toBe(true);
    expect((await t.api.post("/renewals/campaign", {})).json()).toMatchObject({ sent: 1 });
    expect((await t.api.get(`/renewals/${list.items[0].id}`)).json()).toMatchObject({ status: "sent", sendCount: 1 });
    await runWorker(ctx);
    const email = [...mail.delivered.values()].find((m) => m.idempotencyKey === `renewal-${list.items[0].id}-send-1`)!;
    expect(email.to).toBe("billing@orga.test");
    expect(email.subject).toContain("Renew your septic maintenance plan");
    expect(email.text).toMatch(/https:\/\/app\.example\.test\/renew\/[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/);

    // Reminders at 30 and 7 days out, never twice for the same mark.
    ctx.now = new Date("2026-03-05T18:00:00Z");
    expect((await t.api.post("/renewals/campaign", {})).json().reminded).toBe(1);
    expect((await t.api.post("/renewals/campaign", {})).json().reminded).toBe(0);
    ctx.now = new Date("2026-03-25T18:00:00Z");
    expect((await t.api.post("/renewals/campaign", {})).json().reminded).toBe(1);
    expect((await t.api.get(`/renewals/${list.items[0].id}`)).json().sendCount).toBe(3);

    // Unsigned when the contract ends: the offer expires, and the contract shows as expired in the inbox.
    ctx.now = new Date("2026-04-02T18:00:00Z");
    expect((await t.api.post("/renewals/campaign", {})).json().expired).toBe(1);
    const expired = (await t.api.get(`/renewals/${list.items[0].id}`)).json();
    expect(expired.status).toBe("expired");
    expect((await anon().post(`/renew/${expired.link.split("/renew/")[1]}/sign`, signBody(1))).statusCode).toBe(409);
    const inbox = (await t.api.get("/inbox")).json();
    expect(inbox.items.find((i: { kind: string }) => i.kind === "contract_expired").detail).toContain("renewal: expired");
  });

  it("will not email a customer with no email address", async () => {
    const t = await renewalTenant(ctx, "Org A", { email: false });
    const r = await startRenewal(t);
    const res = await t.api.post(`/renewals/${r.id}/send`, {});
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain("no email address");
  });
});

describe("the homeowner's link", () => {
  it("signs with add-ons and updated contact details, pays, and activates the next term", async () => {
    const t = await renewalTenant(ctx);
    await t.api.patch("/billing/settings", { defaultTaxRateBps: 825 });
    const lid = (await t.api.post("/renewals/addons", { name: "Riser lid", priceCents: 4500, taxable: true })).json();
    await t.api.post("/renewals/addons", { name: "Retired extra", priceCents: 100, active: false });
    const r = await startRenewal(t, true);

    // The link works without signing in and shows what is on offer.
    const view = (await anon().get(`/renew/${r.token}`)).json();
    expect(view).toMatchObject({
      status: "sent",
      version: 1,
      customerName: "Org A customer",
      serviceAddress: "1 Main St, Austin, TX",
      currentTerm: { planName: "Standard", endOn: "2026-03-31" },
      terms: { planName: "Standard", startOn: "2026-04-01", endOn: "2027-03-31", priceCents: 30000, visitsPerTerm: 2 },
      firstPaymentCents: 30000,
      installments: 1,
      contact: { email: "billing@orga.test" },
      payment: "pay_to_activate",
      signed: null,
      pay: null,
      testMode: true,
    });
    expect(view.addons.map((a: { name: string }) => a.name)).toEqual(["Riser lid"]);
    expect((await anon().post(`/renew/${r.token}/view`, {})).statusCode).toBe(204);
    expect((await t.api.get(`/renewals/${r.id}`)).json().status).toBe("viewed");

    ctx.now = new Date("2026-03-02T15:00:00Z");
    const signed = await ctx.app.inject({
      method: "POST",
      url: `/renew/${r.token}/sign`,
      payload: signBody(1, { addonIds: [lid.id], signature: { kind: "drawn", image: PNG } }),
      headers: { "user-agent": "Mozilla/5.0 (Pixel 7)", "x-forwarded-for": "203.0.113.9" },
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().status).toBe("payment_pending");

    const d = (await t.api.get(`/renewals/${r.id}`)).json();
    expect(d).toMatchObject({
      status: "payment_pending",
      selectedAddons: [{ name: "Riser lid", priceCents: 4500, taxable: true }],
      customerUpdates: { contact: { before: { email: "billing@orga.test" }, after: { email: "new-email@example.test", phone: "512-555-0100" } } },
      signedDocument: { signerName: "Pat Homeowner", signatureKind: "drawn", userAgent: "Mozilla/5.0 (Pixel 7)", pdfReady: false },
      invoice: { totalCents: 30000 + 4500 + 371, paymentStatus: "unpaid" },
    });
    expect(d.signedDocument.ipAddress).toContain("203.0.113.9");
    // The customer's contact now has what they confirmed.
    const customer = (await t.api.get(`/customers/${t.customer.id}`)).json();
    expect(customer.contacts.find((c: { type: string }) => c.type === "billing")).toMatchObject({ email: "new-email@example.test", phone: "512-555-0100" });

    // What was signed is frozen, and its hash is the hash of exactly that content.
    const doc = await ctx.db.selectFrom("signedDocuments").selectAll().where("id", "=", d.signedDocument.id).executeTakeFirstOrThrow();
    const content = agreementContent.parse(doc.content);
    expect(content.charges).toMatchObject({ totalCents: 34871, taxCents: 371, payment: "pay_to_activate" });
    expect(doc.contentSha256).toBe(sha256Hex(canonicalJson(content)));
    await expect(sql`update signed_documents set signer_name = 'Someone else' where id = ${doc.id}`.execute(ctx.db)).rejects.toThrow(/cannot be changed/);
    await expect(sql`delete from signed_documents where id = ${doc.id}`.execute(ctx.db)).rejects.toThrow(/never deleted/);

    // Signing again, or after a change, is refused.
    expect((await anon().post(`/renew/${r.token}/sign`, signBody(1))).statusCode).toBe(409);
    const pending = (await anon().get(`/renew/${r.token}`)).json();
    expect(pending.pay).toMatchObject({ amountDueCents: 34871, canPayOnline: true });
    expect(pending.signed.signerName).toBe("Pat Homeowner");

    // Nothing activates until it is paid.
    expect((await t.api.get(`/sites/${t.site.id}/contracts`)).json().items).toHaveLength(1);
    await payOnline(r.token);

    const done = (await t.api.get(`/renewals/${r.id}`)).json();
    expect(done).toMatchObject({ status: "activated", invoice: { paymentStatus: "paid" } });
    expect(done.paidAt).not.toBeNull();
    const contracts = (await t.api.get(`/sites/${t.site.id}/contracts`)).json().items;
    expect(contracts).toHaveLength(2);
    const [next, old] = contracts;
    expect(next).toMatchObject({ id: done.newContractId, startOn: "2026-04-01", endOn: "2027-03-31", previousContractId: t.contract.id, state: "upcoming" });
    expect(next.obligations).toHaveLength(2);
    // The old contract is history, unchanged apart from now being renewed.
    expect(old).toMatchObject({ id: t.contract.id, startOn: "2025-04-01", endOn: "2026-03-31", renewedById: next.id, renewalStatus: "activated" });
    const signedDocId = await ctx.db.selectFrom("contracts").select("signedDocumentId").where("id", "=", next.id).executeTakeFirstOrThrow();
    expect(signedDocId.signedDocumentId).toBe(d.signedDocument.id);

    // The first installment was paid with the renewal, so it is not billed again.
    const bill = await t.api.post(`/contracts/${next.id}/invoice`, {});
    expect(bill.statusCode).toBe(422);
    expect(bill.json().message).toContain("already on an invoice");

    // On the site's timeline.
    const timeline = await ctx.db.selectFrom("complianceEvents").select(["eventType"]).where("siteId", "=", t.site.id).orderBy("occurredAt").execute();
    expect(timeline.map((e) => e.eventType)).toEqual(expect.arrayContaining(["renewal_signed", "payment_received", "contract_renewed"]));

    // The worker draws the signed PDF once and emails the customer their copy.
    await runWorker(ctx);
    const copy = mail.delivered.get(`renewal-agreement-${d.signedDocument.id}`)!;
    expect(copy.to).toBe("new-email@example.test");
    expect(copy.attachments[0]!.content.subarray(0, 5).toString()).toBe("%PDF-");
    const pdf = await anon().get(`/renew/${r.token}/agreement.pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((await t.api.get(`/renewals/${r.id}/agreement.pdf`)).statusCode).toBe(200);
    const final = (await anon().get(`/renew/${r.token}`)).json();
    expect(final).toMatchObject({ status: "activated", newTermStartsOn: "2026-04-01", pay: null, signed: { pdfReady: true } });
  });

  it("asks the customer to re-read an offer the office changed after they opened it", async () => {
    const t = await renewalTenant(ctx);
    const r = await startRenewal(t);
    const changed = (await t.api.patch(`/renewals/${r.id}`, { priceCents: 32000 })).json();
    expect(changed).toMatchObject({ version: 2, terms: { priceCents: 32000 } });
    const stale = await anon().post(`/renew/${r.token}/sign`, signBody(1));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("offer_changed");
    expect((await anon().post(`/renew/${r.token}/sign`, signBody(2))).json().status).toBe("payment_pending");
    // Once signed, the offer is fixed.
    expect((await t.api.patch(`/renewals/${r.id}`, { priceCents: 1 })).statusCode).toBe(422);
  });

  it("activates at signing when the provider bills afterwards, and bills monthly plans one month up front", async () => {
    const t = await renewalTenant(ctx, "Org A", { billing: "monthly" });
    await t.api.patch("/renewals/settings", { payment: "invoice" });
    const r = await startRenewal(t);
    expect((await anon().get(`/renew/${r.token}`)).json()).toMatchObject({ firstPaymentCents: 2500, installments: 12 });
    expect((await anon().post(`/renew/${r.token}/sign`, signBody(1))).json().status).toBe("activated");
    const d = (await t.api.get(`/renewals/${r.id}`)).json();
    expect(d.invoice).toMatchObject({ totalCents: 2500, paymentStatus: "unpaid" });
    // The next bill for the new contract is month two.
    const second = (await t.api.post(`/contracts/${d.newContractId}/invoice`, {})).json();
    expect(second.lines[0]).toMatchObject({ installment: 2, unitPriceCents: 2500 });
  });

  it("lets the customer decline", async () => {
    const t = await renewalTenant(ctx);
    const r = await startRenewal(t);
    expect((await anon().post(`/renew/${r.token}/decline`, { reason: "Selling the house" })).json().status).toBe("declined");
    expect((await t.api.get(`/renewals/${r.id}`)).json()).toMatchObject({ status: "declined", declineReason: "Selling the house" });
    expect((await anon().post(`/renew/${r.token}/sign`, signBody(1))).statusCode).toBe(409);
    // The office can start again after a decline.
    expect((await t.api.post(`/contracts/${t.contract.id}/renewal`, {})).statusCode).toBe(201);
  });

  it("adds the customer as a contact when they had none on file", async () => {
    const t = await renewalTenant(ctx, "Org A", { email: false });
    await ctx.db.deleteFrom("contacts").where("customerId", "=", t.customer.id).execute();
    const r = await startRenewal(t);
    expect((await anon().get(`/renew/${r.token}`)).json().contact).toEqual({ name: null, email: null, phone: null });
    expect((await anon().post(`/renew/${r.token}/sign`, signBody(1))).json().status).toBe("payment_pending");
    const customer = (await t.api.get(`/customers/${t.customer.id}`)).json();
    expect(customer.contacts).toEqual([expect.objectContaining({ name: "Pat Homeowner", email: "new-email@example.test", phone: "512-555-0100", type: "primary" })]);
  });

  it("rejects an unknown link and a malformed signature", async () => {
    const t = await renewalTenant(ctx);
    const r = await startRenewal(t);
    expect((await anon().get(`/renew/${"x".repeat(32)}`)).statusCode).toBe(404);
    expect((await anon().post(`/renew/${r.token}/sign`, signBody(1, { signature: { kind: "drawn", image: "data:image/svg+xml;base64,AAAA" } }))).statusCode).toBe(400);
    expect((await anon().post(`/renew/${r.token}/sign`, { ...signBody(1), agree: false })).statusCode).toBe(400);
  });
});

describe("the office", () => {
  it("sends a renewal to review when the contract was renewed another way before payment", async () => {
    const t = await renewalTenant(ctx);
    const r = await startRenewal(t);
    await anon().post(`/renew/${r.token}/sign`, signBody(1));
    expect((await t.api.post(`/contracts/${t.contract.id}/renew`, {})).statusCode).toBe(201);
    await payOnline(r.token);
    const d = (await t.api.get(`/renewals/${r.id}`)).json();
    expect(d).toMatchObject({ status: "needs_review", reviewReason: "This contract was already renewed another way", invoice: { paymentStatus: "paid" } });
    const inbox = (await t.api.get("/inbox")).json();
    expect(inbox.items).toContainEqual(expect.objectContaining({ kind: "renewal_needs_review", target: { type: "renewal", id: r.id } }));
    // Trying again does not help until someone sorts it out.
    expect((await t.api.post(`/renewals/${r.id}/activate`, {})).statusCode).toBe(409);
  });

  it("renews an auto-renewing contract without a new signature, and refuses that for others", async () => {
    const auto = await renewalTenant(ctx, "Org A", { autoRenew: true });
    const r = await startRenewal(auto);
    const res = await auto.api.post(`/renewals/${r.id}/activate`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "activated", signedDocument: null, invoice: null });
    // Its first installment is billed the usual way.
    expect((await auto.api.post(`/contracts/${res.json().newContractId}/invoice`, {})).statusCode).toBe(201);

    const manual = await renewalTenant(ctx, "Org B");
    const m = await startRenewal(manual);
    const refused = await manual.api.post(`/renewals/${m.id}/activate`, {});
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toContain("sign first");
  });

  it("keeps renewals inside their organization", async () => {
    const a = await renewalTenant(ctx, "Org A");
    const b = await renewalTenant(ctx, "Org B");
    const r = await startRenewal(a);
    expect((await b.api.get(`/renewals/${r.id}`)).statusCode).toBe(404);
    expect((await b.api.post(`/renewals/${r.id}/send`, {})).statusCode).toBe(404);
    expect((await b.api.post(`/contracts/${a.contract.id}/renewal`, {})).statusCode).toBe(404);
    expect((await b.api.get("/renewals")).json().items).toHaveLength(0);
    const addon = (await a.api.post("/renewals/addons", { name: "Lid", priceCents: 100 })).json();
    expect((await b.api.patch(`/renewals/addons/${addon.id}`, { priceCents: 1 })).statusCode).toBe(404);
    // Org B's add-ons cannot be chosen on Org A's renewal.
    const other = (await b.api.post("/renewals/addons", { name: "Other", priceCents: 100 })).json();
    expect((await anon().post(`/renew/${r.token}/sign`, signBody(1, { addonIds: [other.id] }))).statusCode).toBe(422);
  });

  it("only lets office roles change renewals", async () => {
    const t = await renewalTenant(ctx);
    const r = await startRenewal(t);
    const { createUser, login } = await import("./helpers.ts");
    const tech = await createUser(ctx.db, t.org.id, "technician");
    const techApi = client(ctx.app, await login(ctx.app, tech.email));
    expect((await techApi.get(`/renewals/${r.id}`)).statusCode).toBe(200);
    expect((await techApi.post(`/renewals/${r.id}/send`, {})).statusCode).toBe(403);
    expect((await techApi.post("/renewals/campaign", {})).statusCode).toBe(403);
  });
});

describe("renewal links are signed, not stored", () => {
  it("opens only with the signature the server made for that renewal", async () => {
    const t = await renewalTenant(ctx);
    const r = await startRenewal(t);
    expect((await client(ctx.app).get(`/renew/${r.token}`)).statusCode).toBe(200);
    const [id] = r.token.split(".");
    for (const forged of [`${id}.${"A".repeat(43)}`, linkToken("pay", r.id), linkToken("renew", t.contract.id)]) {
      expect((await client(ctx.app).get(`/renew/${forged}`)).statusCode, forged).toBe(404);
      expect((await client(ctx.app).post(`/renew/${forged}/decline`, {})).statusCode, forged).toBe(404);
    }
    expect((await client(ctx.app).get(`/renew/${"b".repeat(32)}`)).statusCode).toBe(404);
  });
});


describe("renewal payment confirmation on the original link", () => {
  it("keeps actual bank pending and verification visible at zero payable balance, then identifies terminal failure", async () => {
    const t = await renewalTenant(ctx);
    const r = await startRenewal(t);
    expect((await anon().post(`/renew/${r.token}/sign`, signBody(1))).statusCode).toBe(200);
    const url = new URL((await anon().post(`/renew/${r.token}/checkout`, {})).json().url);
    const invoiceToken = url.pathname.split("/")[2]!;
    const step = (outcome: string) => anon().post(`/pay/${invoiceToken}/test-checkout`, { sessionId: url.searchParams.get("session"), outcome });
    expect((await step("ach_pending")).statusCode).toBe(200);
    const pending = (await anon().get(`/renew/${r.token}`)).json();
    expect(pending).toMatchObject({ pay: null, paymentConfirmation: { pendingCents: 30000, paymentStatus: "processing", bankVerificationRequired: false, latestPaymentFailed: false } });
    const record = await ctx.db.selectFrom("payments").select("id").where("organizationId", "=", t.org.id).where("status", "=", "pending").executeTakeFirstOrThrow();
    await ctx.db.updateTable("payments").set({ bankVerificationUrl: "https://payments.example.test/private-verification" }).where("id", "=", record.id).execute();
    expect((await anon().get(`/renew/${r.token}`)).json().paymentConfirmation.bankVerificationRequired).toBe(true);
    expect((await step("ach_fails")).statusCode).toBe(200);
    expect((await anon().get(`/renew/${r.token}`)).json()).toMatchObject({ paymentConfirmation: { pendingCents: 0, latestPaymentFailed: true } });
    expect((await anon().get(`/pay/${invoiceToken}`)).json()).toMatchObject({ pendingCents: 0, latestPaymentFailed: true });
    const retry = await anon().post(`/renew/${r.token}/checkout`, {});
    expect(retry.statusCode).toBe(200);
    // A fresh retry is not failed just because its predecessor was; its webhook has not arrived.
    expect((await anon().get(`/pay/${invoiceToken}`)).json().latestPaymentFailed).toBe(false);
    expect((await anon().get(`/renew/${r.token}`)).json().paymentConfirmation.latestPaymentFailed).toBe(false);
  });
});
