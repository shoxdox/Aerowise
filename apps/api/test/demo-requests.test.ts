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
    expect(res.json()).toEqual({ ok: true });

    const items = (await api.get("/admin/demo-requests")).json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Pat Rivera", email: "pat@example.com", company: "Rivera Aerobic Service", counties: "Travis, Williamson", status: "new", notifyError: null });
    expect(items[0].notifiedAt).toBe(ctx.now.toISOString());

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
    expect((await submit(request, "198.51.100.3")).statusCode).toBe(202);
    mail.mode = "ok";
    const [item] = (await api.get("/admin/demo-requests")).json().items;
    expect(item).toMatchObject({ notifiedAt: null, notifyError: expect.stringContaining("SMTP 451") });
  });

  it("drops a request that fills the spam trap, answering as usual", async () => {
    const api = await admin();
    mail.delivered.clear();
    const res = await submit({ ...request, website: "http://spam.example" }, "198.51.100.4");
    expect(res.statusCode).toBe(202);
    expect((await api.get("/admin/demo-requests")).json().items).toEqual([]);
    expect(mail.delivered.size).toBe(0);
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
