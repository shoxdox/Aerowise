import type { EmailMessage, EmailResult, EmailTransport } from "@aerowise/compliance";
import { agreementContent } from "@aerowise/domain";
import { canonicalJson, insertContract, sha256Hex } from "@aerowise/renewals";
import { drainTasks, linkToken, queueRenewalEmail } from "@aerowise/tasks";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { client, createTenant, setupTestApp, type TestContext } from "./helpers.ts";
import { pdfText } from "./pdf-text.ts";

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
    // The customer is told to pay from the invoice email, so it is emailed to the address they confirmed.
    const view = (await anon().get(`/renew/${r.token}`)).json();
    expect(view).toMatchObject({ status: "activated", pay: { amountDueCents: 2500, canPayOnline: true, dueOn: "2026-03-31" }, contact: { email: "new-email@example.test" } });
    const invoice = (await t.api.get(`/invoices/${d.invoice.id}`)).json();
    expect(invoice.events.map((e: { summary: string }) => e.summary)).toContain("Issued as INV-1001; emailing to new-email@example.test");
    await runWorker(ctx);
    expect(mail.delivered.get(`invoice-${d.invoice.id}-send-1`)?.to).toBe("new-email@example.test");
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

  it("shows the homeowner the same term rows and agreement text the signed PDF prints, including that it renews automatically", async () => {
    const t = await renewalTenant(ctx, "Org A", { autoRenew: true });
    const r = await startRenewal(t);
    const view = (await anon().get(`/renew/${r.token}`)).json();
    expect(view.termRows).toEqual([
      { key: "plan", label: "Plan", value: "Standard" },
      { key: "term", label: "Term", value: "April 1, 2026 to March 31, 2027 (12 months)" },
      { key: "visits", label: "Visits", value: "2 maintenance visits" },
      { key: "price", label: "Price", value: "$300.00 for the term, billed yearly" },
      // Present tense: the term being renewed has not ended yet.
      { key: "follows", label: "Follows", value: "The term ending March 31, 2026" },
      { key: "renews", label: "Renews", value: "Automatically, unless either party gives written notice before this term ends." },
    ]);
    expect(view.agreementText).toContain("5. Term. This agreement covers the dates shown above and renews automatically unless either party gives written notice before it ends.");
    expect(view.pitch).toBe("Renewing keeps your aerobic system inspected on schedule, with each report filed where your county requires it.");

    await anon().post(`/renew/${r.token}/sign`, signBody(1));
    await runWorker(ctx);
    const pdf = pdfText((await anon().get(`/renew/${r.token}/agreement.pdf`)).rawPayload).replace(/\s+/g, "");
    for (const row of view.termRows) expect(pdf).toContain(`${row.label}${row.value}`.replace(/\s+/g, ""));
    expect(pdf).toContain(view.agreementText.replace(/\s+/g, ""));
    expect(pdf).not.toContain("thatended");
    // Once signed, the page reads its rows from the signed copy: the same ones.
    expect((await anon().get(`/renew/${r.token}`)).json().termRows).toEqual(view.termRows);

    // Without auto-renew there is no such row, and clause 5 is the plain one.
    const plain = await renewalTenant(ctx, "Org B");
    const p = (await anon().get(`/renew/${(await startRenewal(plain)).token}`)).json();
    expect(p.termRows.map((row: { key: string }) => row.key)).toEqual(["plan", "term", "visits", "price", "follows"]);
    expect(p.agreementText).toContain("5. Term. This agreement covers the dates shown above. Either party may end it");
  });

  it("emails the renewal with replies going to the provider, and promises no inspections on a pumping plan", async () => {
    const t = await renewalTenant(ctx);
    await ctx.db.updateTable("organizations").set({ email: "office@orga.test" }).where("id", "=", t.org.id).execute();
    const r = await startRenewal(t);
    await ctx.db.updateTable("renewals").set({ serviceType: "pumping" }).where("id", "=", r.id).execute();
    expect((await t.api.post(`/renewals/${r.id}/send`, {})).statusCode).toBe(200);
    await runWorker(ctx);
    const email = mail.delivered.get(`renewal-${r.id}-send-1`)!;
    expect(email.replyTo).toBe("office@orga.test");
    expect(email.text).toContain("Renewing keeps your pumping visits on schedule. The next term runs April 1, 2026 to March 31, 2027 for $300.00.");
    expect(email.text).not.toMatch(/inspect|filed/);
    expect((await anon().get(`/renew/${r.token}`)).json().pitch).toBe("Renewing keeps your pumping visits on schedule.");
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
  it("closes the emailed offer when the office renews by hand, so the term is never sold or billed twice", async () => {
    const t = await renewalTenant(ctx);
    await t.api.patch("/renewals/settings", { autoSend: true });
    const r = await startRenewal(t, true);
    await runWorker(ctx);
    expect(mail.delivered.has(`renewal-${r.id}-send-1`)).toBe(true);
    // The customer calls and renews by phone.
    const renewed = await t.api.post(`/contracts/${t.contract.id}/renew`, {});
    expect(renewed.statusCode).toBe(201);
    const next = renewed.json();

    // The offer closed in the same step, pointing at the term that replaced it.
    expect((await t.api.get(`/renewals/${r.id}`)).json()).toMatchObject({ status: "superseded", newContractId: next.id, signedDocument: null, invoice: null });
    expect((await t.api.get(`/contracts/${t.contract.id}`)).json()).toMatchObject({ renewedById: next.id, renewalStatus: "superseded" });

    // The homeowner's link says so, and takes neither a signature nor money.
    expect((await anon().get(`/renew/${r.token}`)).json()).toMatchObject({ status: "superseded", pay: null, newTermStartsOn: "2026-04-01" });
    const sign = await anon().post(`/renew/${r.token}/sign`, signBody(1));
    expect(sign.statusCode).toBe(409);
    expect(sign.json().message).toBe("Your plan was already renewed. Nothing is due.");
    expect((await anon().post(`/renew/${r.token}/checkout`, {})).statusCode).toBe(409);
    expect((await anon().post(`/renew/${r.token}/decline`, {})).statusCode).toBe(409);
    expect(await ctx.db.selectFrom("invoices").select("id").where("organizationId", "=", t.org.id).execute()).toHaveLength(0);

    // No reminder email or text goes out for it, and the campaign does not start another.
    ctx.now = new Date("2026-03-25T18:00:00Z");
    expect((await t.api.post("/renewals/campaign", {})).json()).toMatchObject({ created: 0, sent: 0, reminded: 0 });
    // A reminder queued before the office renewed is dropped when the worker reaches it.
    await ctx.db.transaction().execute((trx) => queueRenewalEmail(trx, t.org.id, r.id, { now: ctx.now, reminderDays: 7 }));
    await runWorker(ctx);
    expect([...mail.delivered.keys()].filter((k) => k.startsWith(`renewal-${r.id}-send-`))).toEqual([`renewal-${r.id}-send-1`]);

    // The new term's first installment is billed once, from the site page.
    expect((await t.api.post(`/contracts/${next.id}/invoice`, {})).statusCode).toBe(201);
    expect((await t.api.post(`/contracts/${next.id}/invoice`, {})).statusCode).toBe(422);
  });

  it("will not renew by hand once the customer has signed, and points to the renewal instead", async () => {
    const t = await renewalTenant(ctx);
    const r = await startRenewal(t);
    expect((await anon().post(`/renew/${r.token}/sign`, signBody(1))).json().status).toBe("payment_pending");
    const res = await t.api.post(`/contracts/${t.contract.id}/renew`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "renewal_in_progress", message: "The customer already signed this renewal. Finish it from the renewal page." });
    expect((await t.api.get(`/sites/${t.site.id}/contracts`)).json().items).toHaveLength(1);
    // Paying still activates the one term the customer signed for.
    await payOnline(r.token);
    expect((await t.api.get(`/renewals/${r.id}`)).json().status).toBe("activated");
  });

  it("refuses to sign or take payment for a renewal whose contract is ending, before any invoice is made", async () => {
    const t = await renewalTenant(ctx);
    const r = await startRenewal(t);
    expect((await t.api.post(`/contracts/${t.contract.id}/cancel`, { reason: "Selling the house", discontinuedBy: "owner", serviceEndsOn: "2026-03-20" })).statusCode).toBe(200);
    const sign = await anon().post(`/renew/${r.token}/sign`, signBody(1));
    expect(sign.statusCode).toBe(409);
    expect(sign.json().message).toContain("This renewal offer has ended");
    expect(await ctx.db.selectFrom("invoices").select("id").where("organizationId", "=", t.org.id).execute()).toHaveLength(0);
    expect(await ctx.db.selectFrom("signedDocuments").select("id").where("organizationId", "=", t.org.id).execute()).toHaveLength(0);
    // The link says the offer ended, and the campaign emails nothing for it.
    expect((await anon().get(`/renew/${r.token}`)).json()).toMatchObject({ status: "upcoming", unavailable: "ended", pay: null });
    await t.api.patch("/renewals/settings", { autoSend: true });
    expect((await t.api.post("/renewals/campaign", {})).json()).toMatchObject({ sent: 0, reminded: 0 });

    // Signed before the contract was cancelled: the payment page is refused, not charged.
    const t2 = await renewalTenant(ctx, "Org B");
    const r2 = await startRenewal(t2);
    expect((await anon().post(`/renew/${r2.token}/sign`, signBody(1))).json().status).toBe("payment_pending");
    expect((await t2.api.post(`/contracts/${t2.contract.id}/cancel`, { reason: "Sold the house" })).statusCode).toBe(200);
    const checkout = await anon().post(`/renew/${r2.token}/checkout`, {});
    expect(checkout.statusCode).toBe(409);
    expect(await ctx.db.selectFrom("checkoutSessions").select("id").where("organizationId", "=", t2.org.id).execute()).toHaveLength(0);
  });

  /**
   * What a 'Renew now' made while the customer was paying left behind before it closed the
   * offer: the next term made by hand, and the renewal paid for that same term, in review.
   */
  async function stuckRenewal(t: Awaited<ReturnType<typeof renewalTenant>>) {
    const r = await startRenewal(t);
    await anon().post(`/renew/${r.token}/sign`, signBody(1));
    const url = new URL((await anon().post(`/renew/${r.token}/checkout`, {})).json().url);
    // The term made the way 'Renew now' used to make it, with the customer on the payment page.
    const successor = await ctx.db.transaction().execute((trx) =>
      insertContract(trx, t.org.id, {
        siteId: t.site.id,
        startOn: "2026-04-01",
        terms: { planId: t.plan.id, planName: "Standard", customerType: "residential", termMonths: 12, visitsPerTerm: 2, priceCents: 30000, billingFrequency: "annual", serviceType: "aerobic_inspection", planVersionId: t.contract.planVersionId ?? null },
        autoRenew: false,
        previousContractId: t.contract.id,
      }),
    );
    const paid = await anon().post(`/pay/${url.pathname.split("/")[2]}/test-checkout`, { sessionId: url.searchParams.get("session"), outcome: "card" });
    expect(paid.json().ok).toBe(true);
    return { r, successor };
  }

  it("counts a paid renewal toward the term that was already made another way, so it is not billed again", async () => {
    const t = await renewalTenant(ctx);
    const { r, successor } = await stuckRenewal(t);
    const d = (await t.api.get(`/renewals/${r.id}`)).json();
    expect(d).toMatchObject({ status: "needs_review", reviewReason: "This contract was already renewed another way", invoice: { paymentStatus: "paid" } });
    const inbox = (await t.api.get("/inbox")).json();
    expect(inbox.items).toContainEqual(expect.objectContaining({ kind: "renewal_needs_review", target: { type: "renewal", id: r.id } }));
    // Trying again does not help; counting the payment toward the existing term does.
    expect((await t.api.post(`/renewals/${r.id}/activate`, {})).statusCode).toBe(409);
    const applied = await t.api.post(`/renewals/${r.id}/apply-to-term`, {});
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ status: "activated", newContractId: successor, reviewReason: null, invoice: { paymentStatus: "paid" } });
    const line = await ctx.db.selectFrom("invoiceLines").select(["contractId", "installment", "periodStart", "periodEnd"]).where("invoiceId", "=", d.invoice.id).where("position", "=", 1).executeTakeFirstOrThrow();
    expect(line).toEqual({ contractId: successor, installment: 1, periodStart: "2026-04-01", periodEnd: "2027-03-31" });
    expect((await t.api.post(`/contracts/${successor}/invoice`, {})).json().message).toContain("already on an invoice");
    expect((await t.api.get("/inbox")).json().items.some((i: { kind: string }) => i.kind === "renewal_needs_review")).toBe(false);
    expect((await anon().get(`/renew/${r.token}`)).json()).toMatchObject({ status: "activated", pay: null });
  });

  it("will not count a renewal payment toward a term whose first installment is already billed", async () => {
    const t = await renewalTenant(ctx);
    const { r, successor } = await stuckRenewal(t);
    const draft = (await t.api.post(`/contracts/${successor}/invoice`, {})).json();
    await t.api.post(`/invoices/${draft.id}/issue`, { send: false });
    const refused = await t.api.post(`/renewals/${r.id}/apply-to-term`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toBe("The new term's first installment is already on INV-1002. Void INV-1002 first, or refund this renewal's payment.");
    expect((await t.api.get(`/renewals/${r.id}`)).json().status).toBe("needs_review");
  });

  it("renews an auto-renewing contract without a new signature, and refuses that for others", async () => {
    const auto = await renewalTenant(ctx, "Org A", { autoRenew: true });
    const r = await startRenewal(auto);
    const res = await auto.api.post(`/renewals/${r.id}/activate`, {});
    expect(res.statusCode).toBe(200);
    // Its first installment is invoiced and emailed right away, as a renewal billed afterwards is.
    expect(res.json()).toMatchObject({ status: "activated", signedDocument: null, invoice: { number: 1001, totalCents: 30000, paymentStatus: "unpaid" } });
    const inv = (await auto.api.get(`/invoices/${res.json().invoice.id}`)).json();
    expect(inv).toMatchObject({ status: "open", memo: "Renewal of your maintenance plan, April 1, 2026 to March 31, 2027." });
    expect(inv.lines[0]).toMatchObject({ contractId: res.json().newContractId, installment: 1, unitPriceCents: 30000 });
    expect(inv.events.map((e: { summary: string }) => e.summary)).toContain("Issued as INV-1001; emailing to billing@orga.test");
    await runWorker(ctx);
    expect(mail.delivered.get(`invoice-${inv.id}-send-1`)).toMatchObject({ to: "billing@orga.test", subject: "Invoice INV-1001 from Org A: $300.00 due March 31, 2026" });
    // So it is never billed a second time.
    expect((await auto.api.post(`/contracts/${res.json().newContractId}/invoice`, {})).json().message).toContain("already on an invoice");

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
    // Missing expiry webhooks leave status=open behind. Expiry time still ends that attempt.
    await ctx.db.updateTable("checkoutSessions").set({ expiresAt: new Date(ctx.now.getTime() - 1) })
      .where("organizationId", "=", t.org.id).where("status", "=", "open").execute();
    expect((await anon().get(`/pay/${invoiceToken}`)).json().latestPaymentFailed).toBe(true);
    expect((await anon().get(`/renew/${r.token}`)).json().paymentConfirmation.latestPaymentFailed).toBe(true);
  });
});
