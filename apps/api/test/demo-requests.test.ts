import { OutboxTransport } from "@aerowise/compliance";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { FakeMail } from "./fake-mail.ts";
import { adminLogin, client, createAdmin, createTenant, setupTestApp } from "./helpers.ts";

const mail = new FakeMail();
const ctx = setupTestApp({ mail });

const request = { name: "Pat Rivera", email: "Pat@Example.com", company: "Rivera Aerobic Service", phone: "512-555-0100", counties: "Travis, Williamson", message: "We run 400 contracts." };
const submit = (body: Record<string, unknown>, remoteAddress = "198.51.100.1", app = ctx.app) =>
  app.inject({ method: "POST", url: "/public/demo-requests", payload: body, remoteAddress });

async function admin() {
  await createAdmin(ctx);
  return client(ctx.app, await adminLogin(ctx));
}

describe("demo requests", () => {
  it("a signed-out visitor's request lands in /admin and emails every platform admin", async () => {
    mail.mode = "ok";
    mail.delivered.clear();
    const api = await admin();
    const res = await submit(request);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, saved: true, duplicate: false, notification: "provider_accepted" });

    const items = (await api.get("/admin/demo-requests")).json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Pat Rivera", email: "pat@example.com", company: "Rivera Aerobic Service", counties: "Travis, Williamson", status: "new", notifyError: null });
    expect(items[0].notifiedAt).toBe(ctx.now.toISOString());
    // A mail provider took it, so it counts as emailed.
    expect(items[0].notifyDelivery).toBe("provider");

    const sent = [...mail.delivered.values()];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ organizationId: null, to: "founder@example.com", subject: "Demo request: Rivera Aerobic Service" });
    expect(sent[0]!.text).toContain("pat@example.com");
    expect(sent[0]!.text).toContain("/admin/demo-requests");
  });

  it("emails the configured address instead when one is set", async () => {
    mail.delivered.clear();
    const app = await buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store, mail, demoRequestNotifyTo: ["justin@example.com", "sales@example.com"] });
    try {
      expect((await submit(request, "198.51.100.2", app)).statusCode).toBe(202);
      expect([...mail.delivered.values()].map((m) => m.to).sort()).toEqual(["justin@example.com", "sales@example.com"]);
    } finally {
      await app.close();
    }
  });

  it("keeps the request when the email fails, and says so in /admin", async () => {
    const api = await admin();
    mail.mode = "fail";
    const saved = await submit(request, "198.51.100.3");
    expect(saved.statusCode).toBe(202);
    expect(saved.json()).toMatchObject({ saved: true, notification: "failed" });
    mail.mode = "ok";
    const [item] = (await api.get("/admin/demo-requests")).json().items;
    expect(item).toMatchObject({ notifiedAt: null, notifyError: expect.stringContaining("SMTP 451"), notifyDelivery: null });
  });

  it("says an alert kept in the local test outbox was recorded there, not emailed (STG-08)", async () => {
    const app = await buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store, mail: new OutboxTransport(ctx.store, () => ctx.now) });
    try {
      const api = await admin();
      const saved = await submit(request, "198.51.100.9", app);
      expect(saved.statusCode).toBe(202);
      expect(saved.json()).toMatchObject({ saved: true, notification: "simulated" });
      const [item] = (await api.get("/admin/demo-requests")).json().items;
      expect(item).toMatchObject({ notifiedAt: ctx.now.toISOString(), notifyError: null, notifyDelivery: "outbox" });
    } finally {
      await app.close();
    }
  });

  it("drops a request that fills the spam trap, answering as usual", async () => {
    const api = await admin();
    mail.delivered.clear();
    const res = await submit({ ...request, website: "http://spam.example" }, "198.51.100.4");
    expect(res.statusCode).toBe(202);
    expect((await api.get("/admin/demo-requests")).json().items).toEqual([]);
    expect(mail.delivered.size).toBe(0);
  });

  it("concurrent submissions and a retry reuse one saved request and one alert", async () => {
    const api = await admin();
    mail.mode = "ok";
    mail.delivered.clear();
    const body = { ...request, submissionKey: crypto.randomUUID() };
    const responses = await Promise.all([submit(body, "198.51.100.20"), submit(body, "198.51.100.20")]);
    expect(responses.map((r) => r.statusCode)).toEqual([202, 202]);
    expect(responses.map((r) => r.json().duplicate).sort()).toEqual([false, true]);
    expect((await submit(body, "198.51.100.20")).json()).toMatchObject({ duplicate: true, notification: "provider_accepted" });
    expect((await api.get("/admin/demo-requests")).json().items).toHaveLength(1);
    expect(mail.delivered.size).toBe(1);
  });

  it("failed notification retries preserve the saved lead and do not send again", async () => {
    const api = await admin();
    mail.mode = "fail";
    mail.delivered.clear();
    const body = { ...request, submissionKey: crypto.randomUUID() };
    expect((await submit(body, "198.51.100.21")).json()).toMatchObject({ duplicate: false, notification: "failed" });
    mail.mode = "ok";
    expect((await submit(body, "198.51.100.21")).json()).toMatchObject({ duplicate: true, notification: "failed" });
    expect((await api.get("/admin/demo-requests")).json().items).toHaveLength(1);
    expect(mail.delivered.size).toBe(0);
  });

  it("refuses changing a saved submission's details without overwriting it", async () => {
    const api = await admin();
    const body = { ...request, submissionKey: crypto.randomUUID() };
    expect((await submit(body, "198.51.100.22")).statusCode).toBe(202);
    expect((await submit({ ...body, company: "A different company" }, "198.51.100.22")).statusCode).toBe(409);
    expect((await api.get("/admin/demo-requests")).json().items).toEqual([expect.objectContaining({ company: request.company })]);
  });

  it("refuses incomplete requests", async () => {
    expect((await submit({ ...request, email: "not-an-email" }, "198.51.100.5")).statusCode).toBe(400);
    expect((await submit({ ...request, company: "  " }, "198.51.100.5")).statusCode).toBe(400);
    expect((await submit({ ...request, message: "x".repeat(2001) }, "198.51.100.5")).statusCode).toBe(400);
  });

  it("is rate-limited per client address", async () => {
    for (let i = 0; i < 5; i++) expect((await submit(request, "198.51.100.6")).statusCode).toBe(202);
    expect((await submit(request, "198.51.100.6")).statusCode).toBe(429);
    // Another address is unaffected.
    expect((await submit(request, "198.51.100.7")).statusCode).toBe(202);
  });

  it("only platform admins can read or handle requests; a tenant session cannot", async () => {
    const api = await admin();
    await submit(request, "198.51.100.8");
    const [item] = (await api.get("/admin/demo-requests")).json().items;
    expect((await api.put(`/admin/demo-requests/${item.id}/status`, { status: "handled" })).json()).toMatchObject({ status: "handled" });
    expect((await api.put(`/admin/demo-requests/${crypto.randomUUID()}/status`, { status: "handled" })).statusCode).toBe(404);

    expect((await ctx.app.inject({ method: "GET", url: "/admin/demo-requests" })).statusCode).toBe(401);
    const tenant = await createTenant(ctx, "Org A");
    expect((await tenant.api.get("/admin/demo-requests")).statusCode).toBe(401);
    const audit = await ctx.db.selectFrom("platformAuditEvents").select(["action", "entityId"]).where("action", "=", "demo_request.status_changed").execute();
    expect(audit).toEqual([{ action: "demo_request.status_changed", entityId: item.id }]);
  });
});
