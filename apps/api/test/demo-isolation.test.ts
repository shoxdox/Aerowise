import { createHash, randomUUID } from "node:crypto";
import { OutboxTransport, type EmailMessage, type EmailResult, type EmailTransport } from "@aerowise/compliance";
import { TestPaymentProvider, WebhookSignatureError, type CheckoutInput, type PaymentProvider, type RefundInput } from "@aerowise/payments";
import { QuickBooksError, TestQuickBooksProvider, TokenCipher, type QuickBooksCompany, type QuickBooksProvider } from "@aerowise/quickbooks";
import { TestSmsProvider, type SmsProvider, type SmsSendInput } from "@aerowise/sms";
import { TestBillingProvider } from "@aerowise/billing";
import {
  demoCheck,
  DemoGatedBilling,
  DemoGatedPayments,
  DemoGatedQuickBooks,
  DemoGatedSms,
  DemoGatedTransport,
  drainTasks,
  queueQuickBooksSync,
  queueSms,
  type TaskContext,
} from "@aerowise/tasks";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../src/app.ts";
import { client, createUser, login, setupTestApp } from "./helpers.ts";
import { completeValues, JPEG } from "./inspection-helpers.ts";
import { pdfText } from "./pdf-text.ts";

// A deployment with every real service configured (as production, or staging with
// DEMO_LIVE_SERVICES), holding a demo company next to a real one. The "real" services here
// are fakes that record every call: a demo company must never reach one, by any route or job.

class LiveMail implements EmailTransport {
  readonly name = "resend";
  sent: EmailMessage[] = [];
  async send(m: EmailMessage): Promise<EmailResult> {
    this.sent.push(m);
    return { messageId: `<${m.idempotencyKey}@live>`, acceptedAt: new Date().toISOString(), response: {} };
  }
}

class LiveStripe implements PaymentProvider {
  readonly kind = "stripe";
  calls: string[] = [];
  private n = 0;
  async createAccount() {
    this.calls.push("createAccount");
    return { accountId: `acct_1Live${++this.n}` };
  }
  async accountLink(input: { returnUrl: string }) {
    this.calls.push("accountLink");
    return { url: `https://connect.stripe.example/setup?return=${encodeURIComponent(input.returnUrl)}` };
  }
  async getAccount() {
    this.calls.push("getAccount");
    return { chargesEnabled: true, detailsSubmitted: true };
  }
  async createCheckout(_input: CheckoutInput) {
    this.calls.push("createCheckout");
    return { sessionId: `cs_1Live${++this.n}`, url: "https://checkout.stripe.example/pay", expiresAt: new Date(Date.now() + 3600_000) };
  }
  async expireCheckout() {
    this.calls.push("expireCheckout");
  }
  async createRefund(_input: RefundInput) {
    this.calls.push("createRefund");
    return { refundId: "re_1Live", status: "succeeded" as const, failureReason: null };
  }
  parseWebhook(): never {
    throw new WebhookSignatureError("Stripe signature did not verify");
  }
}

class LiveQuickBooks implements QuickBooksProvider {
  readonly kind = "intuit";
  readonly environment = "sandbox";
  calls: string[] = [];
  authorizeUrl(input: { state: string; redirectUri: string }) {
    this.calls.push("authorizeUrl");
    return `https://appcenter.intuit.example/connect?state=${input.state}`;
  }
  async exchangeCode(): Promise<never> {
    this.calls.push("exchangeCode");
    throw new QuickBooksError("auth", "live exchange");
  }
  async refresh(): Promise<never> {
    this.calls.push("refresh");
    throw new QuickBooksError("auth", "live refresh");
  }
  async revoke() {
    this.calls.push("revoke");
  }
  company(): QuickBooksCompany {
    this.calls.push("company");
    throw new QuickBooksError("auth", "live company");
  }
}

class LiveSms implements SmsProvider {
  readonly kind = "twilio";
  sent: SmsSendInput[] = [];
  async send(input: SmsSendInput) {
    this.sent.push(input);
    return { providerMessageId: "SMlive", status: "sent" as const };
  }
  verifyWebhook() {
    return false;
  }
}

/** The outbox, keeping what it was handed. */
class Outbox extends OutboxTransport {
  sent: EmailMessage[] = [];
  override async send(m: EmailMessage) {
    this.sent.push(m);
    return super.send(m);
  }
}

const ctx = setupTestApp();
const live = { mail: new LiveMail(), stripe: new LiveStripe(), qbo: new LiveQuickBooks(), sms: new LiveSms() };
const standIn = { mail: new Outbox(ctx.store, () => ctx.now), stripe: new TestPaymentProvider(), sms: new TestSmsProvider() };
let app: App;
let gated: { mail: DemoGatedTransport; payments: DemoGatedPayments; quickbooks: DemoGatedQuickBooks; sms: DemoGatedSms };
let worker: TaskContext;

beforeAll(async () => {
  const isDemo = demoCheck(ctx.db);
  gated = {
    mail: new DemoGatedTransport(live.mail, standIn.mail, isDemo, ctx.db),
    payments: new DemoGatedPayments(live.stripe, standIn.stripe, isDemo),
    quickbooks: new DemoGatedQuickBooks(live.qbo, new TestQuickBooksProvider(ctx.db, () => ctx.now), isDemo),
    sms: new DemoGatedSms(live.sms, standIn.sms, isDemo),
  };
  const sms = { provider: gated.sms, webhookBaseUrl: "https://app.example.test/api" };
  const quickbooks = { provider: gated.quickbooks, cipher: new TokenCipher() };
  app = await buildApp({
    db: ctx.db,
    production: true,
    fileSigningSecret: "demo-isolation",
    loginRateLimit: 1000,
    now: () => ctx.now,
    store: ctx.store,
    mail: gated.mail,
    payments: gated.payments,
    quickbooks,
    sms,
    appUrl: "https://app.example.test",
  });
  worker = { db: ctx.db, store: ctx.store, now: () => ctx.now, mail: gated.mail, appUrl: "https://app.example.test", sms, quickbooks };
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  live.mail.sent.length = 0;
  live.stripe.calls.length = 0;
  live.qbo.calls.length = 0;
  live.sms.sent.length = 0;
  standIn.sms.sent.length = 0;
  standIn.mail.sent.length = 0;
});

/** Production's session cookie is Secure; injected requests just pass it on. */
async function company(name: string, demo: boolean) {
  const org = await ctx.db
    .insertInto("organizations")
    .values({ name, demo, email: demo ? "office@example.com" : "office@realseptic.com", phone: demo ? "(512) 555-0100" : "(512) 867-5309" } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  const owner = await createUser(ctx.db, org.id, "owner");
  const api = client(app, await login(app, owner.email));
  const customer = (await api.post("/customers", { displayName: `${name} customer` })).json();
  const site = (await api.post(`/customers/${customer.id}/sites`, { addressLine1: "1 Main St", city: "Austin" })).json();
  const email = demo ? "pat@example.com" : "pat@gmail.com";
  const phone = demo ? "(512) 555-0123" : "(512) 867-5310";
  const contact = await api.post(`/customers/${customer.id}/contacts`, { name: "Pat", siteId: site.id, email, phone, type: "billing", consentEmail: true, consentSms: true });
  expect(contact.statusCode).toBe(201);
  return { org, owner, api, customer, site, contact: contact.json() as { id: string }, email, phone };
}

async function invoiceFor(t: Awaited<ReturnType<typeof company>>, send = true) {
  const draft = (await t.api.post("/invoices", { customerId: t.customer.id, siteId: t.site.id, lines: [{ description: "Aerator repair", quantity: 1, unitPriceCents: 30000 }] })).json();
  const res = await t.api.post(`/invoices/${draft.id}/issue`, { send });
  expect(res.statusCode).toBe(200);
  const inv = res.json();
  return { ...inv, token: (inv.payUrl as string).split("/pay/")[1]! } as { id: string; token: string };
}

/** Whether a PDF carries the demo stamp, read back as text through its embedded font. */
const stamped = (pdf: Buffer) => pdfText(pdf).includes("DEMO - FICTIONAL DATA");

describe("a demo company next to a real one, with real services configured", () => {
  it("connects payments, checks out and finishes payment only on the stand-in", async () => {
    const demo = await company("Demo Co", true);
    expect((await demo.api.post("/billing/stripe/connect", {})).statusCode).toBe(200);
    expect((await demo.api.post("/billing/stripe/refresh", {})).json().stripe.chargesEnabled).toBe(true);
    const org = await ctx.db.selectFrom("organizations").select("stripeAccountId").where("id", "=", demo.org.id).executeTakeFirstOrThrow();
    expect(org.stripeAccountId).toMatch(/^acct_test_/);
    expect((await demo.api.get("/billing/settings")).json().provider).toBe("test");

    const inv = await invoiceFor(demo);
    await drainTasks(worker);
    const anon = client(app);
    expect((await anon.get(`/pay/${inv.token}`)).json().testMode).toBe(true);
    const checkout = (await anon.post(`/pay/${inv.token}/checkout`, {})).json();
    expect(checkout.url).toContain("/test-checkout?session=");
    const sessionId = new URL(checkout.url).searchParams.get("session")!;
    expect((await anon.post(`/pay/${inv.token}/test-checkout`, { sessionId, outcome: "card" })).json()).toEqual({ ok: true, message: "Payment received." });
    expect((await demo.api.get(`/invoices/${inv.id}`)).json().paymentStatus).toBe("paid");

    // Nothing reached the real services: no Stripe call, and the invoice email went to the outbox.
    expect(live.stripe.calls).toEqual([]);
    expect(live.mail.sent).toEqual([]);
    expect(standIn.mail.sent.map((m) => [m.organizationId, m.to])).toEqual([[demo.org.id, "pat@example.com"]]);
  });

  it("still uses the real services for the real company, which can't use the test checkout", async () => {
    const real = await company("Real Septic", false);
    expect((await real.api.post("/billing/stripe/connect", {})).json().url).toMatch(/^https:\/\/connect\.stripe\.example/);
    await real.api.post("/billing/stripe/refresh", {});
    expect((await real.api.get("/billing/settings")).json().provider).toBe("stripe");
    const inv = await invoiceFor(real);
    await drainTasks(worker);
    expect(live.mail.sent.map((m) => [m.organizationId, m.to])).toEqual([[real.org.id, "pat@gmail.com"]]);
    const anon = client(app);
    expect((await anon.post(`/pay/${inv.token}/checkout`, {})).json().url).toBe("https://checkout.stripe.example/pay");
    expect(live.stripe.calls).toEqual(["createAccount", "accountLink", "getAccount", "createCheckout"]);

    // The stand-in's checkout cannot mark a real company's invoice paid, even with a real session id.
    const session = await ctx.db.selectFrom("checkoutSessions").select("providerSessionId").where("invoiceId", "=", inv.id).executeTakeFirstOrThrow();
    const res = await anon.post(`/pay/${inv.token}/test-checkout`, { sessionId: session.providerSessionId, outcome: "card" });
    expect(res.statusCode).toBe(404);
    expect((await real.api.get(`/invoices/${inv.id}`)).json().paymentStatus).toBe("unpaid");
    // Nor can a stand-in-signed webhook: the public webhook only takes the real service's.
    const forged = standIn.stripe.signedEvent("checkout.session.completed", { id: session.providerSessionId, object: "checkout.session" }, "acct_1Live1");
    const hook = await app.inject({ method: "POST", url: "/webhooks/stripe", payload: forged.body, headers: { "content-type": "application/json", "stripe-signature": forged.signature } });
    expect(hook.statusCode).toBe(400);
  });

  it("sends a demo company's queued email and texts to the stand-ins only", async () => {
    const demo = await company("Demo Co", true);
    const real = await company("Real Septic", false);
    const invoices = new Map<string, string>();
    for (const t of [demo, real]) {
      expect((await t.api.patch("/sms/settings", t === demo ? { enabled: true } : { enabled: true, fromNumber: "+15125550111" })).statusCode).toBe(200);
      invoices.set(t.org.id, (await invoiceFor(t)).id);
    }
    // A demo company is in test mode for texting even though Twilio is configured.
    expect((await demo.api.get("/sms/settings")).json().mode).toBe("test");
    expect((await real.api.get("/sms/settings")).json().mode).toBe("live");
    // Queued as the office's "text the customer" does, then sent by the worker.
    for (const t of [demo, real]) {
      const req = { kind: "payment_reminder" as const, customerId: t.customer.id, siteId: t.site.id, relatedType: "invoice" as const, relatedId: invoices.get(t.org.id)!, dedupeKey: `iso-${t.org.id}`, manual: true };
      expect((await queueSms(ctx.db, t.org.id, req, ctx.now)).outcome).toBe("queued");
    }
    await drainTasks(worker);
    expect(live.sms.sent).toHaveLength(1);
    expect(standIn.sms.sent).toHaveLength(1);
    expect(live.mail.sent.map((m) => m.organizationId)).toEqual([real.org.id]);
    expect(standIn.mail.sent.map((m) => m.organizationId)).toEqual([demo.org.id]);
    expect(live.sms.sent.every((s) => s.organizationId === real.org.id)).toBe(true);
    expect(standIn.sms.sent.every((s) => s.organizationId === demo.org.id)).toBe(true);
  });

  it("connects a demo company to the QuickBooks stand-in, even when someone brings a real Intuit code", async () => {
    const demo = await company("Demo Co", true);
    const start = (await demo.api.post("/quickbooks/connect", {})).json().url as string;
    const back = new URL(start);
    expect(back.searchParams.get("realmId")).toMatch(/^test-/);
    // A visitor swaps in a real company and code with the signed state the demo company was given.
    const state = back.searchParams.get("state")!;
    const cookie = (await login(app, demo.owner.email));
    const swapped = await app.inject({ method: "GET", url: `/quickbooks/callback?code=real-intuit-code&realmId=9130350000000000&state=${encodeURIComponent(state)}`, headers: { cookie } });
    expect(swapped.headers.location).toContain("error=connect");
    expect(live.qbo.calls).toEqual([]);
    // The stand-in's own answer connects.
    const ok = await app.inject({ method: "GET", url: `${back.pathname.replace(/^\/api/, "")}?${back.searchParams}`, headers: { cookie } });
    expect(ok.headers.location).toContain("connected=1");
    expect((await demo.api.get("/quickbooks")).json()).toMatchObject({ provider: "test", connection: { environment: "test" } });
    expect(live.qbo.calls).toEqual([]);

    const real = await company("Real Septic", false);
    expect((await real.api.post("/quickbooks/connect", {})).json().url).toMatch(/^https:\/\/appcenter\.intuit\.example/);
    expect(live.qbo.calls).toEqual(["authorizeUrl"]);
  });

  it("hands out a demo company's PDFs stamped as fictional, leaving the stored file as made", async () => {
    const demo = await company("Demo Co", true);
    const real = await company("Real Septic", false);
    const ids = { demo: (await invoiceFor(demo, false)).id, real: (await invoiceFor(real, false)).id };
    await drainTasks(worker);
    for (const [t, id, demoCo] of [[demo, ids.demo, true], [real, ids.real, false]] as const) {
      const res = await t.api.get(`/invoices/${id}/pdf`);
      expect(res.statusCode).toBe(200);
      const key = (await ctx.db.selectFrom("invoices").select("pdfStorageKey").where("id", "=", id).executeTakeFirstOrThrow()).pdfStorageKey!;
      const stored = (await ctx.store.get(key))!;
      expect(stamped(res.rawPayload)).toBe(demoCo);
      expect(stamped(stored)).toBe(false);
      if (!demoCo) expect(createHash("sha256").update(res.rawPayload).digest("hex")).toBe(createHash("sha256").update(stored).digest("hex"));
    }
  });

  it("marks a demo company's data export as fictional", async () => {
    const demo = await company("Demo Co", true);
    const exp = (await demo.api.post("/exports", {})).json();
    await drainTasks(worker);
    const res = await demo.api.get(`/exports/${exp.id}/download`);
    expect(res.headers["content-disposition"]).toMatch(/aerowise-DEMO-export-/);
    const files = unzipSync(new Uint8Array(res.rawPayload));
    expect(new TextDecoder().decode(files["DEMO-FICTIONAL-DATA.txt"])).toMatch(/^DEMO: everything in this export is fictional/);
    expect(new TextDecoder().decode(files["README.txt"])).toMatch(/^DEMO:/);
    // STG-07: each CSV says so on its own, header and every row, ahead of the usual columns.
    const csvs = Object.keys(files).filter((f) => f.endsWith(".csv"));
    expect(csvs).toHaveLength(21);
    for (const name of csvs) {
      const lines = new TextDecoder().decode(files[name]).trimEnd().split("\r\n");
      expect(lines[0], name).toMatch(/^aerowise_demo_notice,(id,)?(seq,)?organization_id,/);
      for (const line of lines.slice(1)) expect(line.startsWith("DEMO - FICTIONAL DATA - NOT FILED,"), name).toBe(true);
    }
    const customers = new TextDecoder().decode(files["customers.csv"]);
    expect(customers.trimEnd().split("\r\n").length).toBeGreaterThan(1);

    // A detached demo CSV cannot become a real company's records.
    const real = await company("Real Septic", false);
    const upload = { filename: "customers.csv", contentBase64: Buffer.from(customers).toString("base64") };
    const refused = await real.api.post("/imports", upload);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message ?? refused.body).toMatch(/exported from an Aerowise demo company/);
    expect((await demo.api.post("/imports", upload)).statusCode).toBe(201);
  });
});

describe("queued and follow-on work of a demo company", () => {
  /** A demo company with online payments on, and one invoice paid by card on the test checkout. */
  async function paidInvoice() {
    const demo = await company("Demo Co", true);
    await demo.api.post("/billing/stripe/connect", {});
    await demo.api.post("/billing/stripe/refresh", {});
    const inv = await invoiceFor(demo, false);
    const anon = client(app);
    const checkout = (await anon.post(`/pay/${inv.token}/checkout`, {})).json();
    const sessionId = new URL(checkout.url).searchParams.get("session")!;
    expect((await anon.post(`/pay/${inv.token}/test-checkout`, { sessionId, outcome: "card" })).json().ok).toBe(true);
    return { demo, inv };
  }

  it("decides by the company on record, never by how an id looks", async () => {
    const demo = await company("Demo Co", true);
    const real = await company("Real Septic", false);
    // A demo company holding a real-looking account id still only reaches the stand-in...
    await ctx.db.updateTable("organizations").set({ stripeAccountId: "acct_1RealLooking" }).where("id", "=", demo.org.id).execute();
    expect((await demo.api.post("/billing/stripe/refresh", {})).statusCode).toBe(200);
    expect(live.stripe.calls).toEqual([]);
    // ...and a real company holding a stand-in-looking one still reaches the real service.
    await ctx.db.updateTable("organizations").set({ stripeAccountId: "acct_test_000000000000000000000000" }).where("id", "=", real.org.id).execute();
    expect((await real.api.post("/billing/stripe/refresh", {})).statusCode).toBe(200);
    expect(live.stripe.calls).toEqual(["getAccount"]);
  });

  it("refunds a demo company's card payment on the stand-in", async () => {
    const { demo, inv } = await paidInvoice();
    const payment = (await demo.api.get(`/invoices/${inv.id}`)).json().payments[0];
    const refunded = await demo.api.post(`/payments/${payment.id}/refund`, { amountCents: 1000, reason: "Goodwill" });
    expect(refunded.statusCode, refunded.body).toBe(200);
    expect(live.stripe.calls).toEqual([]);
  });

  it("syncs a demo company's books from the queued job with the stand-in company only", async () => {
    const { demo } = await paidInvoice();
    const start = new URL((await demo.api.post("/quickbooks/connect", {})).json().url as string);
    const cookie = await login(app, demo.owner.email);
    expect((await app.inject({ method: "GET", url: `${start.pathname.replace(/^\/api/, "")}?${start.searchParams}`, headers: { cookie } })).headers.location).toContain("connected=1");
    // Past the first review: syncing is on (the review itself is the QuickBooks tests' business).
    await ctx.db.updateTable("quickbooksConnections").set({ setupState: "active" }).where("organizationId", "=", demo.org.id).execute();
    await queueQuickBooksSync(ctx.db, demo.org.id, ctx.now);
    await drainTasks(worker);
    // A token past its time is refreshed, again on the stand-in.
    await ctx.db.updateTable("quickbooksConnections").set({ accessExpiresAt: new Date(0) }).where("organizationId", "=", demo.org.id).execute();
    await queueQuickBooksSync(ctx.db, demo.org.id, new Date(ctx.now.getTime() + 60_000));
    ctx.now = new Date(ctx.now.getTime() + 120_000);
    await drainTasks(worker);
    expect(live.qbo.calls).toEqual([]);
    const conn = await ctx.db.selectFrom("quickbooksConnections").select(["status", "environment", "lastSyncError", "lastSyncFinishedAt", "accessExpiresAt"]).where("organizationId", "=", demo.org.id).executeTakeFirstOrThrow();
    expect(conn).toMatchObject({ status: "connected", environment: "test", lastSyncError: null });
    expect(conn.lastSyncFinishedAt).not.toBeNull();
    expect(conn.accessExpiresAt!.getTime()).toBeGreaterThan(0);
  });

  it("files a demo company's inspection report with the county through the outbox only", async () => {
    const demo = await company("Demo Co", true);
    expect((await demo.api.patch(`/sites/${demo.site.id}`, { county: "Example County" })).statusCode).toBe(200);
    const tech = await createUser(ctx.db, demo.org.id, "technician");
    await ctx.db.updateTable("memberships").set({ technicianLicense: "MT-DEMO-0002" }).where("userId", "=", tech.id).execute();
    const techApi = client(app, await login(app, tech.email));
    const plan = (await demo.api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
    const contract = (await demo.api.post(`/sites/${demo.site.id}/contracts`, { planId: plan.id, startOn: "2025-12-01" })).json();
    const job = (await demo.api.post("/jobs", { obligationId: contract.obligations[0].id, technicianId: tech.id, scheduledDate: "2026-03-01" })).json();
    const template = (await techApi.get("/inspection-template")).json();
    const clientId = randomUUID();
    const base = { clientId, jobId: job.jobId, templateId: template.id, arrivedAt: "2026-03-01T15:00:00Z", arrivalGps: { lat: 30.27, lng: -97.74, accuracyM: 8 } };
    await techApi.put("/inspections/sync", { ...base, status: "draft", values: { aerator: "pass" } });
    for (const [n, key] of [[1, "overview"], [2, "chlorinator"]] as const) {
      const res = await techApi.putImage(`/inspections/${clientId}/photos/00000000-0000-4000-8000-00000000000${n}`, JPEG, { "x-photo-key": key, "x-captured-at": "2026-03-01T15:10:00Z" });
      expect(res.statusCode).toBe(201);
    }
    const done = await techApi.put("/inspections/sync", { ...base, status: "completed", completedAt: "2026-03-01T15:40:00Z", values: { ...completeValues(), air_pressure: 4.5 } });
    expect(done.json().status).toBe("completed");
    await drainTasks(worker);
    const filing = await ctx.db.selectFrom("filings").select("status").where("organizationId", "=", demo.org.id).executeTakeFirstOrThrow();
    expect(filing.status).toBe("sent");
    expect(live.mail.sent).toEqual([]);
    expect(standIn.mail.sent.map((m) => m.to)).toContain("filings@tx-example-county.example");
  });
});

describe("a demo company's contact details", () => {
  it("must be made up, whichever way they arrive", async () => {
    const demo = await company("Demo Co", true);
    const bad = await demo.api.post(`/customers/${demo.customer.id}/contacts`, { name: "Real", email: "someone@gmail.com" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: "fictional_contact_required", message: expect.stringMatching(/^A demo company only holds made-up email addresses/) });
    expect((await demo.api.post(`/customers/${demo.customer.id}/contacts`, { name: "Real", phone: "(512) 867-5309" })).json().error).toBe("fictional_contact_required");
    expect((await demo.api.patch(`/contacts/${demo.contact.id}`, { email: "pat@realmail.com" })).statusCode).toBe(422);
    expect((await demo.api.post("/invitations", { email: "friend@gmail.com", role: "office" })).statusCode).toBe(422);
    expect((await demo.api.post("/invitations", { email: "friend@example.com", role: "office" })).statusCode).toBe(201);
    expect((await demo.api.patch("/organization/settings", { email: "me@realseptic.com" })).statusCode).toBe(422);
    expect((await demo.api.patch("/organization/settings", { emergencyPhone: "(512) 867-5309" })).statusCode).toBe(422);
    expect((await demo.api.patch("/organization/settings", { emergencyPhone: "(512) 555-0111" })).statusCode).toBe(200);

    // Straight to the database too: a person with a real address cannot join, and a member cannot take one.
    const person = await ctx.db.insertInto("users").values({ name: "Real", email: "real@gmail.com", phone: null, passwordHash: "x" }).returning("id").executeTakeFirstOrThrow();
    await expect(ctx.db.insertInto("memberships").values({ organizationId: demo.org.id, userId: person.id, role: "office", technicianLicense: null }).execute()).rejects.toMatchObject({ constraint: "demo_fictional_email" });
    await expect(ctx.db.updateTable("users").set({ email: "owner@gmail.com" }).where("id", "=", demo.owner.id).execute()).rejects.toMatchObject({ constraint: "demo_fictional_email" });
    await expect(ctx.db.updateTable("users").set({ phone: "+15128675309" }).where("id", "=", demo.owner.id).execute()).rejects.toMatchObject({ constraint: "demo_fictional_phone" });

    // A real company keeps real details.
    const real = await company("Real Septic", false);
    expect((await real.api.post(`/customers/${real.customer.id}/contacts`, { name: "Real", email: "someone@gmail.com", phone: "(512) 867-5309" })).statusCode).toBe(201);
    expect((await ctx.db.insertInto("memberships").values({ organizationId: real.org.id, userId: person.id, role: "office", technicianLicense: null }).execute())).toBeTruthy();
  });

  it("stays demo or real for good, whatever is sent", async () => {
    const demo = await company("Demo Co", true);
    const real = await company("Real Septic", false);
    for (const t of [demo, real]) await t.api.patch("/organization/settings", { demo: !(t === demo) } as object);
    await expect(ctx.db.updateTable("organizations").set({ demo: false }).where("id", "=", demo.org.id).execute()).rejects.toMatchObject({ constraint: "organizations_demo_fixed" });
    await expect(ctx.db.updateTable("organizations").set({ demo: true }).where("id", "=", real.org.id).execute()).rejects.toMatchObject({ constraint: "organizations_demo_fixed" });
    const rows = await ctx.db.selectFrom("organizations").select(["id", "demo"]).where("id", "in", [demo.org.id, real.org.id]).execute();
    expect(Object.fromEntries(rows.map((r) => [r.id, r.demo]))).toEqual({ [demo.org.id]: true, [real.org.id]: false });
  });

  it("shows the banner to anyone signed in to a demo company", async () => {
    const demo = await company("Demo Co", true);
    const real = await company("Real Septic", false);
    expect((await app.inject({ method: "GET", url: "/app-info" })).json()).toEqual({ demo: false, demoCompany: false, demoVisitor: false, features: [] });
    expect((await demo.api.get("/app-info")).json()).toEqual({ demo: false, demoCompany: true, demoVisitor: false, features: [] });
    expect((await real.api.get("/app-info")).json()).toEqual({ demo: false, demoCompany: false, demoVisitor: false, features: [] });
  });
});

describe("the gates", () => {
  it("send mail with no company to a made-up address to the outbox", async () => {
    const isDemo = demoCheck(ctx.db);
    const mail = new DemoGatedTransport(live.mail, standIn.mail, isDemo, ctx.db);
    const msg = (to: string): EmailMessage => ({ organizationId: null, idempotencyKey: `k-${to}`, from: "a@aerowise.test", to, subject: "Reset", text: "x", attachments: [] });
    await mail.send(msg("owner@example.com"));
    await mail.send(msg("someone@gmail.com"));
    expect(live.mail.sent.map((m) => m.to)).toEqual(["someone@gmail.com"]);
  });

  it("fail closed: no company, or one not on record, gets the stand-in", async () => {
    const isDemo = demoCheck(ctx.db);
    const nobody = [null, undefined, "", "not-a-uuid", randomUUID()];
    for (const id of nobody) expect(await isDemo(id), String(id)).toBe(true);
    const payments = new DemoGatedPayments(live.stripe, standIn.stripe, isDemo);
    const sms = new DemoGatedSms(live.sms, standIn.sms, isDemo);
    const qbo = new DemoGatedQuickBooks(live.qbo, new TestQuickBooksProvider(ctx.db, () => ctx.now), isDemo);
    const mail = new DemoGatedTransport(live.mail, standIn.mail, isDemo, ctx.db);
    const unknown = randomUUID();
    await payments.createAccount({ organizationId: unknown, name: "x", email: null });
    await payments.getAccount("acct_1RealLooking", unknown);
    await sms.send({ organizationId: unknown, from: "+15125550100", to: "+15125550123", body: "x", statusCallback: null });
    await qbo.refresh("live-refresh-token", unknown).catch(() => {});
    expect(qbo.authorizeUrl({ state: "s", redirectUri: "https://app.example.test/api/quickbooks/callback", organizationId: unknown })).toContain("realmId=test-");
    await mail.send({ organizationId: unknown, idempotencyKey: "k-unknown", from: "a@aerowise.test", to: "someone@gmail.com", subject: "x", text: "x", attachments: [] });
    expect([live.stripe.calls, live.sms.sent, live.qbo.calls, live.mail.sent]).toEqual([[], [], [], []]);
  });

  it("keep Aerowise's own billing of a demo company on the stand-in", async () => {
    const demo = await company("Demo Co", true);
    const real = await company("Real Septic", false);
    const calls: string[] = [];
    // The stand-in, dressed as Stripe Billing and noting who it was asked for.
    class LiveBilling extends TestBillingProvider {
      override readonly kind = "stripe" as "test";
      override async createCustomer(input: { organizationId: string; name: string; email: string | null }) {
        calls.push(input.organizationId);
        return super.createCustomer(input);
      }
    }
    const billing = new DemoGatedBilling(new LiveBilling(), new TestBillingProvider(), demoCheck(ctx.db));
    await billing.createCustomer({ organizationId: demo.org.id, name: "Demo Co", email: null });
    await billing.createCustomer({ organizationId: real.org.id, name: "Real Septic", email: null });
    expect(calls).toEqual([real.org.id]);
  });
});
