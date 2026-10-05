import { EmailNeedsReviewError, ProviderTransport, ResendEmailProvider, type EmailMessage } from "@aerowise/compliance";
import { drainTasks } from "@aerowise/tasks";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { FakeResend, RESEND_TEST_SECRET } from "./fake-resend.ts";
import { createOrg, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, payload, setup, uploadRequiredPhotos } from "./inspection-helpers.ts";

const ctx = setupTestApp();
const HOUR = 3600_000;
const later = (c: TestContext, ms: number) => (c.now = new Date(c.now.getTime() + ms));

function resend(c: TestContext, opts: { redirectTo?: string } = {}) {
  const api = new FakeResend(() => c.now);
  const provider = new ResendEmailProvider({ apiKey: "re_test", webhookSecrets: [RESEND_TEST_SECRET], baseUrl: "https://resend.test", fetch: api.fetch });
  const mail = new ProviderTransport(c.db, provider, () => c.now, opts);
  return { api, provider, mail };
}

const message = (organizationId: string | null, over: Partial<EmailMessage> = {}): EmailMessage => ({
  organizationId,
  idempotencyKey: "filing-1-submission-1",
  from: "Reports <reports@example.com>",
  to: "ossf@example.gov",
  subject: "Aerobic maintenance report, permit EX-1",
  text: "Attached.",
  attachments: [{ filename: "report.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4") }],
  ...over,
});

const sendRow = (c: TestContext, organizationId: string, key = "filing-1-submission-1") =>
  c.db.selectFrom("emailSends").selectAll().where("organizationId", "=", organizationId).where("idempotencyKey", "=", key).executeTakeFirstOrThrow();

describe("email through Resend", () => {
  it("sends once per key: a retry after a lost answer reuses the key and the provider sends nothing new", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const { api, mail } = resend(ctx);
    api.next = "lose";
    await expect(mail.send(message(org.id))).rejects.toThrow(/did not answer/);
    expect(await sendRow(ctx, org.id)).toMatchObject({ status: "failed", attempts: 1, uncertainSince: ctx.now, providerMessageId: null });

    later(ctx, 2 * HOUR);
    const result = await mail.send(message(org.id));
    expect(result.messageId).toBe("re_1");
    expect(api.emails).toHaveLength(1);
    expect(api.emails[0]!.tags).toEqual([
      { name: "aw_send", value: (await sendRow(ctx, org.id)).id },
      { name: "aw_org", value: org.id },
    ]);
    expect(await sendRow(ctx, org.id)).toMatchObject({ status: "accepted", attempts: 2, uncertainSince: null, providerMessageId: "re_1" });

    // Accepted: answered from the record, without calling Resend.
    const calls = api.requests.length;
    expect((await mail.send(message(org.id))).messageId).toBe("re_1");
    expect(api.requests).toHaveLength(calls);
  });

  it("past Resend's 24-hour window, finds an uncertain send at the provider instead of sending it again", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const { api, mail } = resend(ctx);
    // Something else went to the same address in the meantime; it must not be mistaken for ours.
    api.next = "lose";
    await expect(mail.send(message(org.id))).rejects.toThrow();
    later(ctx, HOUR);
    await mail.send(message(org.id, { idempotencyKey: "other", subject: "Something else" }));

    later(ctx, 24 * HOUR);
    const result = await mail.send(message(org.id));
    expect(result).toMatchObject({ messageId: "re_1", response: { reconciled: true } });
    expect(api.emails).toHaveLength(2);
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(2);
    expect(api.requests.some((r) => r.method === "GET")).toBe(true);
  });

  it("past the window, sends again when the provider has no such message", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const { api, mail } = resend(ctx);
    api.next = "error_500";
    await expect(mail.send(message(org.id))).rejects.toThrow(/500/);
    expect((await sendRow(ctx, org.id)).uncertainSince).toEqual(ctx.now);

    later(ctx, 30 * HOUR);
    expect((await mail.send(message(org.id))).messageId).toBe("re_1");
    expect(api.emails).toHaveLength(1);
    expect(await sendRow(ctx, org.id)).toMatchObject({ status: "accepted", attempts: 2 });
  });

  it("holds a send for a person when the provider cannot say whether it went out, and never sends it automatically", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const { api, mail } = resend(ctx);
    // Two identical messages at Resend that we know nothing about: which one is ours?
    api.next = "lose";
    await expect(mail.send(message(org.id))).rejects.toThrow();
    api.emails.push({ ...api.emails[0]!, id: "re_x", created_at: ctx.now.toISOString() });

    later(ctx, 25 * HOUR);
    await expect(mail.send(message(org.id))).rejects.toThrow(EmailNeedsReviewError);
    await expect(mail.send(message(org.id))).rejects.toThrow(/may have reached the mail provider/);
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(await sendRow(ctx, org.id)).toMatchObject({ status: "needs_review", providerMessageId: null });
  });

  it("a refused request is certainly not sent, so a later retry needs no lookup", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const { api, mail } = resend(ctx);
    api.next = "reject_422";
    await expect(mail.send(message(org.id))).rejects.toThrow(/422/);
    expect(await sendRow(ctx, org.id)).toMatchObject({ status: "failed", uncertainSince: null });
    later(ctx, 30 * HOUR);
    await mail.send(message(org.id));
    expect(api.requests.filter((r) => r.method === "GET")).toHaveLength(0);
    expect(api.emails).toHaveLength(1);
  });

  it("redirects every message to the test inbox when one is set (staging)", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const { api, mail } = resend(ctx, { redirectTo: "inbox@test.example" });
    await mail.send(message(org.id));
    expect(api.emails[0]).toMatchObject({ to: ["inbox@test.example"], subject: "[for ossf@example.gov] Aerobic maintenance report, permit EX-1" });
  });
});

describe("Resend webhooks", () => {
  it("verifies signatures the way Svix documents them", () => {
    // The worked example in docs.svix.com/receiving/verifying-payloads/how-manual (read 2026-10-05).
    const provider = new ResendEmailProvider({ apiKey: "re_test", webhookSecrets: ["whsec_plJ3nmyCDGBKInavdOK15jsl"] });
    const body = Buffer.from('{"event_type":"ping","data":{"success":true}}');
    const headers = { "svix-id": "msg_loFOjxBNrRLzqYUf", "svix-timestamp": "1731705121", "svix-signature": "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=" };
    expect(provider.parseWebhook(body, headers, new Date(1731705121_000)).id).toBe("msg_loFOjxBNrRLzqYUf");
    expect(() => provider.parseWebhook(body, { ...headers, "svix-signature": "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIkuD0=" }, new Date(1731705121_000))).toThrow(/did not verify/);
  });

  const appWith = (provider: ResendEmailProvider) => buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store, mailProvider: provider });

  it("refuses unsigned, wrongly signed and stale webhooks", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const { api, mail, provider } = resend(ctx);
    const app = await appWith(provider);
    await mail.send(message(org.id));
    const w = api.webhook("email.bounced", "re_1", { bounce: { type: "Permanent", subType: "General", message: "Mailbox does not exist" } });
    expect((await app.inject({ method: "POST", url: "/webhooks/email", payload: w.body, headers: { "content-type": "application/json" } })).statusCode).toBe(400);
    const tampered = w.body.replace("Mailbox", "Mailbix");
    expect((await app.inject({ method: "POST", url: "/webhooks/email", payload: tampered, headers: w.headers })).statusCode).toBe(400);
    later(ctx, 10 * 60_000);
    expect((await app.inject({ method: "POST", url: "/webhooks/email", payload: w.body, headers: w.headers })).statusCode).toBe(400);
    expect(await ctx.db.selectFrom("emailEvents").selectAll().execute()).toHaveLength(0);
    // Without a mail provider there is no webhook.
    const plain = await buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store });
    expect((await plain.inject({ method: "POST", url: "/webhooks/email", payload: w.body, headers: w.headers })).statusCode).toBe(404);
    await Promise.all([app.close(), plain.close()]);
  });

  it("records delivery, bounce and complaint on the send; repeats are ignored and a late 'delivered' does not hide a bounce", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const { api, mail, provider } = resend(ctx);
    const app = await appWith(provider);
    await mail.send(message(org.id));
    const post = (w: { body: string; headers: Record<string, string> }) => app.inject({ method: "POST", url: "/webhooks/email", payload: w.body, headers: w.headers });

    const bounce = api.webhook("email.bounced", "re_1", { bounce: { type: "Permanent", subType: "General", message: "Mailbox does not exist" } }, "msg_b");
    expect((await post(bounce)).json()).toEqual({ received: true, outcome: "applied" });
    expect((await post(bounce)).json()).toEqual({ received: true, outcome: "duplicate" });
    expect((await post(api.webhook("email.delivered", "re_1"))).json().outcome).toBe("applied");
    expect(await sendRow(ctx, org.id)).toMatchObject({ deliveryStatus: "bounced", deliveryDetail: "Permanent / General / Mailbox does not exist" });

    await mail.send(message(org.id, { idempotencyKey: "k2", to: "pat@example.com" }));
    await post(api.webhook("email.delivered", "re_2"));
    await post(api.webhook("email.complained", "re_2"));
    expect(await sendRow(ctx, org.id, "k2")).toMatchObject({ deliveryStatus: "complained" });
    expect((await ctx.db.selectFrom("emailEvents").select("type").orderBy("receivedAt").orderBy("type").execute()).map((e) => e.type).sort()).toEqual(
      ["bounced", "complained", "delivered", "delivered"].sort(),
    );
    // Opens and clicks are not tracked; an email this server never sent is not ours.
    expect((await post(api.webhook("email.opened", "re_2"))).json().outcome).toBe("ignored");
    expect((await post(api.webhook("email.delivered", "re_999"))).json().outcome).toBe("unknown");
    await app.close();
  });

  it("email to Aerowise itself (no organization) sends once per key and records its delivery", async () => {
    const { api, mail, provider } = resend(ctx);
    const app = await appWith(provider);
    const platform = message(null, { idempotencyKey: "demo-request-1-founder@example.com", to: "founder@example.com", attachments: [] });
    expect((await mail.send(platform)).messageId).toBe("re_1");
    expect((await mail.send(platform)).messageId).toBe("re_1");
    expect(api.emails).toHaveLength(1);
    expect(api.emails[0]!.tags).toContainEqual({ name: "aw_org", value: "platform" });
    // An organization may use the same key; it is a different send.
    const org = await createOrg(ctx.db, "Org A");
    expect((await mail.send(message(org.id, { idempotencyKey: platform.idempotencyKey }))).messageId).toBe("re_2");

    const w = api.webhook("email.bounced", "re_1", { bounce: { type: "Permanent", subType: "General", message: "Mailbox does not exist" } });
    expect((await app.inject({ method: "POST", url: "/webhooks/email", payload: w.body, headers: w.headers })).json().outcome).toBe("applied");
    const row = await ctx.db.selectFrom("emailSends").selectAll().where("organizationId", "is", null).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "accepted", deliveryStatus: "bounced", recipient: "founder@example.com" });
    await app.close();
  });

  it("settles a send whose answer was lost when Resend reports it sent", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const { api, mail, provider } = resend(ctx);
    const app = await appWith(provider);
    api.next = "lose";
    await expect(mail.send(message(org.id))).rejects.toThrow();
    const w = api.webhook("email.sent", "re_1");
    expect((await app.inject({ method: "POST", url: "/webhooks/email", payload: w.body, headers: w.headers })).json().outcome).toBe("applied");
    expect(await sendRow(ctx, org.id)).toMatchObject({ status: "accepted", providerMessageId: "re_1", uncertainSince: null });
    // The retry is answered from the record.
    const posts = api.requests.filter((r) => r.method === "POST").length;
    expect((await mail.send(message(org.id))).messageId).toBe("re_1");
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(posts);
    await app.close();
  });

  it("a bounced filing email goes on the site's ledger and in the inbox, for that organization only", async () => {
    const { api, mail, provider } = resend(ctx);
    const app = await appWith(provider);
    const s = await setup(ctx, "Org A");
    const other = await setup(ctx, "Org B");
    expect((await s.api.patch(`/sites/${s.site.id}`, { county: "Example County" })).statusCode).toBe(200);
    await ctx.db.updateTable("memberships").set({ technicianLicense: "MP-0001" }).where("userId", "=", s.tech.id).execute();
    const p = payload(s);
    await s.techApi.put("/inspections/sync", p);
    await uploadRequiredPhotos(s, p.clientId);
    await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: { ...completeValues(), air_pressure: 4.5 } }));
    await drainTasks({ db: ctx.db, store: ctx.store, now: () => ctx.now, mail });
    const filing = (await s.api.get("/filings?view=all")).json().items[0];
    expect(filing.status).toBe("sent");
    expect(api.emails).toHaveLength(1);
    expect((await s.api.get("/inbox")).json().items.map((i: { kind: string }) => i.kind)).not.toContain("filing_bounced");

    const w = api.webhook("email.bounced", api.emails[0]!.id, { bounce: { type: "Permanent", subType: "General", message: "Mailbox does not exist" } });
    expect((await app.inject({ method: "POST", url: "/webhooks/email", payload: w.body, headers: w.headers })).statusCode).toBe(200);

    const item = (await s.api.get("/inbox")).json().items.find((i: { kind: string }) => i.kind === "filing_bounced");
    expect(item).toMatchObject({ severity: "high", target: { type: "filing", id: filing.id }, detail: expect.stringContaining("Mailbox does not exist") });
    const ledger = (await s.api.get(`/sites/${s.site.id}/compliance-events`)).json().items as { eventType: string; summary: string; filingId: string }[];
    expect(ledger.find((e) => e.eventType === "filing_email_bounced")).toMatchObject({
      filingId: filing.id,
      summary: expect.stringContaining("bounced: the receiving mail server rejected it"),
    });
    expect((await other.api.get("/inbox")).json().items.map((i: { kind: string }) => i.kind)).not.toContain("filing_bounced");
    await app.close();
  });

  it("keeps each event with its own organization's send, in the database too", async () => {
    const a = await createOrg(ctx.db, "Org A");
    const b = await createOrg(ctx.db, "Org B");
    const { mail } = resend(ctx);
    await mail.send(message(a.id));
    const sendA = await sendRow(ctx, a.id);
    await expect(
      ctx.db
        .insertInto("emailEvents")
        .values({ organizationId: b.id, emailSendId: sendA.id, provider: "resend", providerEventId: "x", type: "delivered", occurredAt: ctx.now, receivedAt: ctx.now, detail: null })
        .execute(),
    ).rejects.toThrow(/foreign key/);
    // The same key in another organization is a different message.
    await mail.send(message(b.id));
    expect((await sendRow(ctx, b.id)).providerMessageId).toBe("re_2");
  });
});
