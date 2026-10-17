import { drainTasks } from "@aerowise/tasks";
import { TEST_NUMBERS } from "@aerowise/sms";
import { beforeEach, describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, payload, setup, signAsProvider, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

const ctx = setupTestApp();
beforeEach(() => {
  ctx.sms.provider.sent.length = 0;
});
const APP_URL = "https://app.example.test";
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, appUrl: APP_URL, sms: c.sms });
const MOBILE = "+15125550123";
const textsTo = (to: string) => ctx.sms.provider.sent.filter((m) => m.to === to);
const anon = () => client(ctx.app);

/** Signs a webhook as Twilio would and posts it form-encoded. */
function webhook(kind: "inbound" | "status", params: Record<string, string>, signature?: string) {
  const url = `${ctx.sms.webhookBaseUrl}/webhooks/sms/${kind}`;
  return ctx.app.inject({
    method: "POST",
    url: `/webhooks/sms/${kind}`,
    payload: new URLSearchParams(params).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature ?? ctx.sms.provider.sign(url, params) },
  });
}

/** The setup's visit, with texting on and the site contact agreeing to texts on `phone`. */
async function texting(phone = "(512) 555-0123", name = "Org A") {
  const s = await setup(ctx, name);
  const on = await s.api.patch("/sms/settings", { enabled: true });
  expect(on.statusCode).toBe(200);
  expect((await s.api.patch(`/contacts/${s.contact.id}`, { phone, consentSms: true })).statusCode).toBe(200);
  return { ...s, fromNumber: on.json().fromNumber as string };
}

async function complete(s: Setup) {
  const clientId = payload(s).clientId;
  await s.techApi.put("/inspections/sync", payload(s));
  await uploadRequiredPhotos(s, clientId);
  const res = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: completeValues() }));
  expect(res.json().status).toBe("completed");
  return res.json() as { id: string };
}

async function issuedInvoice(s: { api: ReturnType<typeof client>; customer: { id: string }; site: { id: string } }) {
  const draft = (await s.api.post("/invoices", { customerId: s.customer.id, siteId: s.site.id, lines: [{ description: "Chlorine refill", quantity: 1, unitPriceCents: 4500 }] })).json();
  const issued = await s.api.post(`/invoices/${draft.id}/issue`, { send: false });
  expect(issued.statusCode).toBe(200);
  return issued.json() as { id: string; dueOn: string; number: number };
}

describe("texting settings", () => {
  it("is off until the owner turns it on, and only the owner can", async () => {
    const t = await createTenant(ctx, "Org A");
    expect((await t.api.get("/sms/settings")).json()).toEqual({
      mode: "test",
      enabled: false,
      kinds: ["on_the_way", "report_ready", "renewal_reminder", "payment_reminder"],
      fromNumber: null,
      webhooks: null,
    });
    const office = await createUser(ctx.db, t.org.id, "office");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    expect((await officeApi.get("/sms/settings")).statusCode).toBe(200);
    expect((await officeApi.patch("/sms/settings", { enabled: true })).statusCode).toBe(403);

    // In test mode, turning it on gives a made-up number to send from.
    const on = (await t.api.patch("/sms/settings", { enabled: true, kinds: ["on_the_way", "inspection_completed"] })).json();
    expect(on).toMatchObject({ enabled: true, kinds: ["on_the_way", "inspection_completed"], fromNumber: expect.stringMatching(/^\+1512555\d{4}$/) });
    expect((await t.api.patch("/sms/settings", { fromNumber: "512-555-0100" })).statusCode).toBe(400);

    // Another organization cannot take the same number.
    const other = await createTenant(ctx, "Org B");
    const taken = await other.api.patch("/sms/settings", { fromNumber: on.fromNumber });
    expect(taken.statusCode).toBe(409);
  });
});

describe("on the way", () => {
  it("texts the site's contact once per visit, from the technician's phone", async () => {
    const s = await texting();
    const res = await s.techApi.post(`/jobs/${s.job.jobId}/on-the-way`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: "queued", to: MOBILE });
    await runWorker(ctx);
    const [text] = textsTo(MOBILE).slice(-1);
    expect(text).toMatchObject({ from: s.fromNumber, statusCallback: "http://localhost:3000/api/webhooks/sms/status" });
    expect(text!.body).toBe("Org A: technician is on the way to 1 Main St for your septic service. Reply STOP to opt out.");

    // Tapping again does not text again.
    const before = textsTo(MOBILE).length;
    expect((await s.techApi.post(`/jobs/${s.job.jobId}/on-the-way`, {})).json().outcome).toBe("queued");
    await runWorker(ctx);
    expect(textsTo(MOBILE)).toHaveLength(before);

    const log = (await s.api.get("/sms/messages")).json().items;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ direction: "outbound", kind: "on_the_way", status: "delivered", phone: MOBILE, contactName: "Pat", customer: { id: s.customer.id } });

    // Another technician's stop is not theirs to announce.
    const other = await createUser(ctx.db, s.org.id, "technician");
    const otherApi = client(ctx.app, await login(ctx.app, other.email));
    expect((await otherApi.post(`/jobs/${s.job.jobId}/on-the-way`, {})).statusCode).toBe(404);
  });

  it("tells the technician's phone with the route whether these texts go, so it offers the button only then", async () => {
    const s = await setup(ctx);
    expect((await s.techApi.get("/route")).json().onTheWayTexts).toBe(false);
    await s.api.patch("/sms/settings", { enabled: true });
    expect((await s.techApi.get("/route")).json().onTheWayTexts).toBe(true);
    // Texting on, but not this kind.
    expect((await s.api.patch("/sms/settings", { kinds: ["report_ready"] })).statusCode).toBe(200);
    expect((await s.techApi.get("/route")).json().onTheWayTexts).toBe(false);
  });

  it("says why nothing went: texting off, no mobile number, no consent", async () => {
    const s = await setup(ctx);
    expect((await s.techApi.post(`/jobs/${s.job.jobId}/on-the-way`, {})).json()).toMatchObject({ outcome: "off" });
    await s.api.patch("/sms/settings", { enabled: true });
    expect((await s.techApi.post(`/jobs/${s.job.jobId}/on-the-way`, {})).json()).toMatchObject({ outcome: "no_phone" });
    await s.api.patch(`/contacts/${s.contact.id}`, { phone: "512 555 0123" });
    // The skip was already noted for this visit; the office sees one entry.
    expect((await s.techApi.post(`/jobs/${s.job.jobId}/on-the-way`, {})).json()).toMatchObject({ outcome: "no_consent", to: MOBILE });
    const problems = (await s.api.get("/sms/messages?filter=problems")).json().items;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ status: "skipped", skipReason: "no_phone" });
    expect(ctx.sms.provider.sent).toHaveLength(0);
  });
});

describe("inspection completed and report ready", () => {
  it("texts that the inspection is done, then a portal link to the report that is never stored", async () => {
    const s = await texting();
    await s.api.patch("/sms/settings", { kinds: ["inspection_completed", "report_ready"] });
    const insp = await complete(s);
    await runWorker(ctx);
    // The report is made, but the customer hears about it only once the maintenance
    // provider has signed it (30 TAC 285.7(b)(3)).
    expect(textsTo(MOBILE).map((t) => t.body)).toEqual(["Org A: we finished the inspection of your septic system at 1 Main St. Your report will follow. Reply STOP to opt out."]);
    await signAsProvider(s, insp.id);
    await runWorker(ctx);
    const texts = textsTo(MOBILE);
    expect(texts.map((t) => t.body)).toEqual([
      "Org A: we finished the inspection of your septic system at 1 Main St. Your report will follow. Reply STOP to opt out.",
      expect.stringMatching(/^Org A: the inspection report for 1 Main St is ready\. See it in your account: https:\/\/app\.example\.test\/portal\/[\w-]{43} Reply STOP to opt out\.$/),
    ]);
    const token = /\/portal\/([\w-]{43})/.exec(texts[1]!.body)![1]!;
    const portal = await anon().get(`/portal/${token}`);
    expect(portal.statusCode).toBe(200);
    expect(portal.json().sites[0].reports).toHaveLength(1);

    const log = (await s.api.get("/sms/messages")).json().items;
    const ready = log.find((m: { kind: string }) => m.kind === "report_ready");
    expect(ready.body).toBe("Org A: the inspection report for 1 Main St is ready. See it in your account: https://app.example.test/portal/… Reply STOP to opt out.");
    const stored = await ctx.db.selectFrom("smsMessages").select("body").execute();
    for (const m of stored) expect(m.body).not.toContain(token);
    const link = await ctx.db.selectFrom("portalLinks").select(["source", "sentTo"]).executeTakeFirstOrThrow();
    expect(link).toEqual({ source: "sms", sentTo: MOBILE });
    // The office's portal panel shows the texted link.
    expect((await s.api.get(`/customers/${s.customer.id}/portal`)).json().links[0].source).toBe("sms");
    expect(insp.id).toBeTruthy();
  });

  it("waits for the morning when a report is ready at night", async () => {
    const s = await texting();
    const insp = await complete(s);
    await runWorker(ctx);
    // The report is signed at 10:30 pm in Austin.
    ctx.now = new Date("2026-03-02T04:30:00Z");
    await signAsProvider(s, insp.id);
    await runWorker(ctx);
    expect(textsTo(MOBILE)).toHaveLength(0);
    const task = await ctx.db.selectFrom("backgroundTasks").select(["runAt", "completedAt"]).where("kind", "=", "sms.send").where("completedAt", "is", null).executeTakeFirstOrThrow();
    expect(task.runAt.toISOString()).toBe("2026-03-02T14:00:00.000Z");
    expect(task.completedAt).toBeNull();
    ctx.now = new Date("2026-03-02T14:00:00Z");
    await runWorker(ctx);
    expect(textsTo(MOBILE)).toHaveLength(1);
  });
});

describe("replies", () => {
  it("STOP stops every text to that number until the customer texts START", async () => {
    const s = await texting();
    // A forged reply is refused.
    expect((await webhook("inbound", { From: MOBILE, To: s.fromNumber, Body: "STOP", MessageSid: "SMin1" }, "forged")).statusCode).toBe(403);

    const stop = await webhook("inbound", { From: MOBILE, To: s.fromNumber, Body: "Stop", MessageSid: "SMin1" });
    expect(stop.statusCode).toBe(200);
    expect(stop.headers["content-type"]).toContain("text/xml");
    // Twilio retries: the same reply is kept once.
    await webhook("inbound", { From: MOBILE, To: s.fromNumber, Body: "Stop", MessageSid: "SMin1" });

    expect((await s.api.get(`/customers/${s.customer.id}`)).json().contacts[0].consentSms).toBe(false);
    const optOuts = (await s.api.get("/sms/opt-outs")).json().items;
    expect(optOuts).toEqual([{ phone: MOBILE, source: "reply", optedOutAt: expect.any(String), customers: [{ id: s.customer.id, displayName: "Org A customer" }] }]);
    // The office cannot sign the number back up.
    const again = await s.api.patch(`/contacts/${s.contact.id}`, { consentSms: true });
    expect(again.statusCode).toBe(422);
    expect(again.json().message).toContain("START");
    expect((await s.techApi.post(`/jobs/${s.job.jobId}/on-the-way`, {})).json().outcome).toBe("no_consent");
    // STOP needs nobody to answer it: it is not in the inbox.
    expect((await s.api.get("/inbox")).json().items.filter((i: { kind: string }) => i.kind === "sms_reply")).toHaveLength(0);

    await webhook("inbound", { From: "512-555-0123", To: s.fromNumber, Body: "START", MessageSid: "SMin2" });
    expect((await s.api.get("/sms/opt-outs")).json().items).toHaveLength(0);
    expect((await s.api.get(`/customers/${s.customer.id}`)).json().contacts[0].consentSms).toBe(true);
    const audit = await ctx.db.selectFrom("auditEvents").select("action").where("action", "like", "sms.opted%").orderBy("occurredAt").execute();
    expect(audit.map((a) => a.action)).toEqual(["sms.opted_out", "sms.opted_in"]);
  });

  it("puts anything else a customer texts in the inbox until someone deals with it", async () => {
    const s = await texting();
    await webhook("inbound", { From: MOBILE, To: s.fromNumber, Body: "Gate code changed to 4321", MessageSid: "SMin3" });
    // Texts to a number nobody uses are dropped quietly.
    expect((await webhook("inbound", { From: MOBILE, To: "+15125559999", Body: "hi", MessageSid: "SMin4" })).statusCode).toBe(200);

    const inbox = (await s.api.get("/inbox")).json();
    const item = inbox.items.find((i: { kind: string }) => i.kind === "sms_reply");
    expect(item).toMatchObject({ title: "Customer texted back", customer: { id: s.customer.id }, target: { type: "sms_message" } });
    expect(item.detail).toContain("Gate code changed to 4321");
    expect(item.detail).toContain("(512) 555-0123");
    expect((await s.api.get("/sms/messages?filter=replies")).json().items).toHaveLength(1);

    const readOnly = await createUser(ctx.db, s.org.id, "read_only");
    const roApi = client(ctx.app, await login(ctx.app, readOnly.email));
    expect((await roApi.post(`/sms/messages/${item.target.id}/handled`, {})).statusCode).toBe(403);
    expect((await s.api.post(`/sms/messages/${item.target.id}/handled`, {})).statusCode).toBe(204);
    expect((await s.api.get("/inbox")).json().items.filter((i: { kind: string }) => i.kind === "sms_reply")).toHaveLength(0);

    // Another organization's reply is not found.
    const other = await createTenant(ctx, "Org B");
    expect((await other.api.post(`/sms/messages/${item.target.id}/handled`, {})).statusCode).toBe(404);
  });

  it("test mode can play a reply from the office", async () => {
    const s = await texting();
    const res = await s.api.post("/sms/test/inbound", { from: "(512) 555-0123", body: "STOP" });
    expect(res.json()).toEqual({ keyword: "stop" });
    expect((await s.api.get("/sms/opt-outs")).json().items).toHaveLength(1);
  });
});

describe("failures", () => {
  it("records a number that cannot get texts, and a carrier opt-out stops later texts", async () => {
    const s = await texting(TEST_NUMBERS.notMobile);
    await s.techApi.post(`/jobs/${s.job.jobId}/on-the-way`, {});
    await runWorker(ctx);
    const [failed] = (await s.api.get("/sms/messages?filter=problems")).json().items;
    expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining("not capable of receiving SMS") });

    const t = await texting(TEST_NUMBERS.unsubscribed, "Org B");
    await t.techApi.post(`/jobs/${t.job.jobId}/on-the-way`, {});
    await runWorker(ctx);
    expect((await t.api.get("/sms/opt-outs")).json().items).toMatchObject([{ phone: TEST_NUMBERS.unsubscribed, source: "carrier" }]);
  });

  it("delivery receipts mark texts delivered or failed", async () => {
    const s = await texting();
    await s.techApi.post(`/jobs/${s.job.jobId}/on-the-way`, {});
    await runWorker(ctx);
    const row = await ctx.db.selectFrom("smsMessages").select(["id", "providerMessageId"]).executeTakeFirstOrThrow();
    // A receipt for a delivered text cannot undo it.
    await webhook("status", { MessageSid: row.providerMessageId!, MessageStatus: "undelivered", ErrorCode: "30003" });
    expect((await ctx.db.selectFrom("smsMessages").select("status").where("id", "=", row.id).executeTakeFirstOrThrow()).status).toBe("delivered");
    await ctx.db.updateTable("smsMessages").set({ status: "sent", deliveredAt: null }).where("id", "=", row.id).execute();
    expect((await webhook("status", { MessageSid: row.providerMessageId!, MessageStatus: "undelivered", ErrorCode: "21610" })).statusCode).toBe(204);
    const after = await ctx.db.selectFrom("smsMessages").select(["status", "errorCode"]).where("id", "=", row.id).executeTakeFirstOrThrow();
    expect(after).toEqual({ status: "failed", errorCode: "21610" });
    expect((await s.api.get("/sms/opt-outs")).json().items).toMatchObject([{ phone: MOBILE, source: "carrier" }]);
    expect((await webhook("status", { MessageSid: "SMnope", MessageStatus: "delivered" }, "bad")).statusCode).toBe(403);
  });
});

describe("payment reminders", () => {
  it("texts an overdue invoice 3 and 14 days late, once each", async () => {
    const s = await texting();
    // Online payment is set up, so the text offers it.
    expect((await s.api.post("/billing/stripe/connect", {})).statusCode).toBe(200);
    await s.api.post("/billing/stripe/refresh", {});
    const inv = await issuedInvoice(s);
    const at = (dueOffset: number) => {
      const d = new Date(`${inv.dueOn}T18:00:00Z`);
      d.setUTCDate(d.getUTCDate() + dueOffset);
      return d;
    };
    const sweep = async () => {
      await ctx.db.insertInto("backgroundTasks").values({ kind: "sms.sweep", organizationId: s.org.id, payload: JSON.stringify({ organizationId: s.org.id }), runAt: ctx.now } as never).execute();
      await runWorker(ctx);
    };
    ctx.now = at(2);
    await sweep();
    expect(textsTo(MOBILE)).toHaveLength(0);
    ctx.now = at(3);
    await sweep();
    await sweep();
    expect(textsTo(MOBILE)).toHaveLength(1);
    expect(textsTo(MOBILE)[0]!.body).toMatch(new RegExp(`^Org A: invoice INV-${inv.number} for \\$45\\.00 was due \\w+ \\d+\\. Pay online: https://app\\.example\\.test/pay/[\\w.-]+ Reply STOP to opt out\\.$`));
    ctx.now = at(14);
    await sweep();
    expect(textsTo(MOBILE)).toHaveLength(2);
  });

  it("does not text the whole overdue book when texting is first turned on", async () => {
    const s = await setup(ctx);
    await s.api.patch(`/contacts/${s.contact.id}`, { phone: MOBILE, consentSms: true });
    const inv = await issuedInvoice(s);
    ctx.now = new Date(`${inv.dueOn}T18:00:00Z`);
    ctx.now.setUTCDate(ctx.now.getUTCDate() + 40);
    await s.api.patch("/sms/settings", { enabled: true });
    await ctx.db.insertInto("backgroundTasks").values({ kind: "sms.sweep", organizationId: s.org.id, payload: JSON.stringify({ organizationId: s.org.id }), runAt: ctx.now } as never).execute();
    await runWorker(ctx);
    expect(textsTo(MOBILE)).toHaveLength(0);
  });

  it("lets the office text a reminder by hand, once a day", async () => {
    const s = await texting();
    await s.api.patch("/sms/settings", { kinds: [] });
    const inv = await issuedInvoice(s);
    const res = await s.api.post(`/invoices/${inv.id}/text-reminder`, {});
    expect(res.json()).toEqual({ outcome: "queued", to: MOBILE });
    await runWorker(ctx);
    expect(textsTo(MOBILE)[0]!.body).toContain("is due");
    // Without online payment set up, the link is to view the invoice, not to pay online.
    expect(textsTo(MOBILE)[0]!.body).toContain(". View it: https://app.example.test/pay/");
    expect((await s.api.post(`/invoices/${inv.id}/text-reminder`, {})).statusCode).toBe(409);

    await s.api.post(`/invoices/${inv.id}/void`, { reason: "Entered twice" });
    expect((await s.api.post(`/invoices/${inv.id}/text-reminder`, {})).statusCode).toBe(422);
    const tech = client(ctx.app, await login(ctx.app, s.tech.email));
    expect((await tech.post(`/invoices/${inv.id}/text-reminder`, {})).statusCode).toBe(403);
  });
});

describe("renewal reminders", () => {
  it("text the renewal link along with the reminder email", async () => {
    const t = await createTenant(ctx, "Org A");
    await t.api.patch("/sms/settings", { enabled: true });
    await t.api.patch(`/contacts/${t.contact.id}`, { phone: MOBILE, email: "pat@orga.test", consentSms: true });
    const plan = (await t.api.post("/plans", { name: "Standard", termMonths: 12, visitsPerTerm: 2, priceCents: 30000 })).json();
    await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2025-04-01" });
    await t.api.patch("/renewals/settings", { autoSend: true });
    expect((await t.api.post("/renewals/campaign", {})).json()).toMatchObject({ created: 1, sent: 1 });
    await runWorker(ctx);
    // The offer itself goes by email only.
    expect(textsTo(MOBILE)).toHaveLength(0);
    ctx.now = new Date("2026-03-05T18:00:00Z");
    expect((await t.api.post("/renewals/campaign", {})).json().reminded).toBe(1);
    await runWorker(ctx);
    expect(textsTo(MOBILE).map((m) => m.body)).toEqual([
      expect.stringMatching(/^Org A: your septic maintenance plan ends Mar 31\. Renew online in a couple of minutes: https:\/\/app\.example\.test\/renew\/[\w.-]+ Reply STOP to opt out\.$/),
    ]);
  });

  it("text nothing once the office has renewed the contract another way", async () => {
    const t = await createTenant(ctx, "Org A");
    await t.api.patch("/sms/settings", { enabled: true });
    await t.api.patch(`/contacts/${t.contact.id}`, { phone: MOBILE, email: "pat@orga.test", consentSms: true });
    const plan = (await t.api.post("/plans", { name: "Standard", termMonths: 12, visitsPerTerm: 2, priceCents: 30000 })).json();
    const contract = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2025-04-01" })).json();
    await t.api.patch("/renewals/settings", { autoSend: true });
    await t.api.post("/renewals/campaign", {});
    await runWorker(ctx);
    // The reminder is queued, then the customer renews by phone before it goes out.
    ctx.now = new Date("2026-03-05T18:00:00Z");
    expect((await t.api.post("/renewals/campaign", {})).json().reminded).toBe(1);
    expect((await t.api.post(`/contracts/${contract.id}/renew`, {})).statusCode).toBe(201);
    await runWorker(ctx);
    expect(textsTo(MOBILE)).toHaveLength(0);
    // And the campaign queues no more.
    ctx.now = new Date("2026-03-25T18:00:00Z");
    expect((await t.api.post("/renewals/campaign", {})).json().reminded).toBe(0);
  });
});
