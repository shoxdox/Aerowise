import { describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { adminLogin, client, createAdmin, createOrg, createTenant, createUser, login, PASSWORD, setupTestApp } from "./helpers.ts";

const mail = new FakeMail();
const ctx = setupTestApp({ mail });

const tokenOf = (url: string) => url.split("/invite/")[1]!;
const emailsTo = (to: string) => [...mail.delivered.values()].filter((m) => m.to === to);

async function invite(api: ReturnType<typeof client>, body: { email: string; role: string; name?: string }) {
  const res = await api.post("/invitations", body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { invitation: { id: string; status: string; role: string; invitedBy: string }; url: string; emailed: boolean };
}

const accept = (token: string, body: { name?: string; password: string }) =>
  ctx.app.inject({ method: "POST", url: `/invitations/accept/${token}`, payload: body });

describe("invitations", () => {
  it("emails a link that sets a password, signs the person in and makes them a member", async () => {
    mail.delivered.clear();
    const t = await createTenant(ctx, "Org A");
    const sent = await invite(t.api, { email: "Tina.Tech@Example.com", role: "technician", name: "Tina Tech" });
    expect(sent.emailed).toBe(true);
    expect(sent.invitation).toMatchObject({ status: "pending", role: "technician", invitedBy: "owner user" });
    const [email] = emailsTo("tina.tech@example.com");
    expect(email?.subject).toBe("owner user invited you to Org A on Aerowise");
    expect(email?.text).toContain(sent.url);

    const token = tokenOf(sent.url);
    const preview = await ctx.app.inject({ method: "GET", url: `/invitations/accept/${token}` });
    expect(preview.json()).toEqual({ organizationName: "Org A", email: "tina.tech@example.com", name: "Tina Tech", role: "technician", existingUser: false });

    const res = await accept(token, { password: "a strong password" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ role: "technician", organization: { id: t.org.id }, user: { name: "Tina Tech", email: "tina.tech@example.com" } });
    const cookie = res.cookies.find((c) => c.name === "aw_session")!;
    expect((await client(ctx.app, `aw_session=${cookie.value}`).get("/auth/me")).json().role).toBe("technician");
    // The password works for a normal sign-in afterwards.
    await login(ctx.app, "tina.tech@example.com", "a strong password");

    const overview = (await t.api.get("/users")).json();
    expect(overview.members.map((m: { email: string; role: string }) => [m.email, m.role])).toContainEqual(["tina.tech@example.com", "technician"]);
    expect(overview.invitations).toHaveLength(0);

    const audit = await ctx.db.selectFrom("auditEvents").select(["action", "actorUserId"]).where("entityType", "=", "invitation").orderBy("id").execute();
    expect(audit.map((a) => a.action)).toEqual(["invitation.sent", "invitation.accepted"]);
  });

  it("works once", async () => {
    const t = await createTenant(ctx, "Org A");
    const token = tokenOf((await invite(t.api, { email: "new@example.com", role: "office", name: "New" })).url);
    expect((await accept(token, { password: "a strong password" })).statusCode).toBe(200);
    const again = await accept(token, { password: "another password" });
    expect(again.statusCode).toBe(410);
    expect(again.json().error).toBe("invitation_used");
    expect((await ctx.app.inject({ method: "GET", url: `/invitations/accept/${token}` })).statusCode).toBe(410);
  });

  it("expires", async () => {
    const t = await createTenant(ctx, "Org A");
    const sent = await invite(t.api, { email: "late@example.com", role: "technician", name: "Late" });
    ctx.now = new Date(ctx.now.getTime() + 7 * 86_400_000 + 1000);
    const res = await accept(tokenOf(sent.url), { password: "a strong password" });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("invitation_expired");
    expect((await t.api.get("/users")).json().invitations[0].status).toBe("expired");
    expect(await ctx.db.selectFrom("users").select("id").where("email", "=", "late@example.com").execute()).toHaveLength(0);
  });

  it("refuses a tampered or unknown token", async () => {
    const t = await createTenant(ctx, "Org A");
    const token = tokenOf((await invite(t.api, { email: "x@example.com", role: "technician", name: "X" })).url);
    // Change a character that is not the last (the last base64url character can be padding bits).
    const tampered = token.slice(0, 5) + (token[5] === "A" ? "B" : "A") + token.slice(6);
    const res = await accept(tampered, { password: "a strong password" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("invitation_not_found");
    expect((await ctx.app.inject({ method: "GET", url: `/invitations/accept/${tampered}` })).statusCode).toBe(404);
  });

  it("makes a resent invitation's old link stop working, and a revoked one never works", async () => {
    const t = await createTenant(ctx, "Org A");
    const first = await invite(t.api, { email: "y@example.com", role: "technician", name: "Y" });
    const resent = (await t.api.post(`/invitations/${first.invitation.id}/resend`, {})).json();
    expect(resent.url).not.toBe(first.url);
    expect((await accept(tokenOf(first.url), { password: "a strong password" })).statusCode).toBe(404);

    // Inviting the same email again replaces the open invitation too.
    const replacement = await invite(t.api, { email: "y@example.com", role: "office", name: "Y" });
    expect((await accept(tokenOf(resent.url), { password: "a strong password" })).json().error).toBe("invitation_revoked");

    expect((await t.api.post(`/invitations/${replacement.invitation.id}/revoke`, {})).statusCode).toBe(204);
    expect((await accept(tokenOf(replacement.url), { password: "a strong password" })).json().error).toBe("invitation_revoked");
  });

  it("asks for a real password and a name", async () => {
    const t = await createTenant(ctx, "Org A");
    const token = tokenOf((await invite(t.api, { email: "z@example.com", role: "technician" })).url);
    expect((await accept(token, { password: "short" })).statusCode).toBe(422);
    expect((await accept(token, { password: "a strong password" })).json().error).toBe("name_required");
    expect((await accept(token, { name: "Zed", password: "a strong password" })).statusCode).toBe(200);
  });

  it("adds an existing Aerowise user after they confirm their own password", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const token = tokenOf((await invite(b.api, { email: a.owner.email, role: "office" })).url);
    expect((await ctx.app.inject({ method: "GET", url: `/invitations/accept/${token}` })).json().existingUser).toBe(true);
    // The link alone cannot take over an existing login by choosing a new password.
    expect((await accept(token, { password: "a brand new password" })).statusCode).toBe(401);
    const res = await accept(token, { password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json().organizations.map((o: { name: string }) => o.name)).toEqual(["Org A", "Org B"]);
    // Their password and their membership in Org A are unchanged.
    await login(ctx.app, a.owner.email, PASSWORD, a.org.id);
  });

  it("refuses to invite someone who is already a member", async () => {
    const t = await createTenant(ctx, "Org A");
    const res = await t.api.post("/invitations", { email: t.owner.email.toUpperCase(), role: "office" });
    expect(res.statusCode).toBe(409);
  });
});

describe("who may invite whom", () => {
  it("lets owners invite any role and office staff any role but owner", async () => {
    const t = await createTenant(ctx, "Org A");
    for (const role of ["owner", "office", "technician", "read_only"]) {
      await invite(t.api, { email: `owner-invites-${role}@example.com`, role });
    }
    const office = await createUser(ctx.db, t.org.id, "office");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    for (const role of ["office", "technician", "read_only"]) {
      await invite(officeApi, { email: `office-invites-${role}@example.com`, role });
    }
    expect((await officeApi.post("/invitations", { email: "boss@example.com", role: "owner" })).statusCode).toBe(403);

    // Nor can office staff touch an owner invitation someone else sent.
    const ownerInvite = (await t.api.get("/users")).json().invitations.find((i: { role: string }) => i.role === "owner");
    expect((await officeApi.post(`/invitations/${ownerInvite.id}/resend`, {})).statusCode).toBe(403);
    expect((await officeApi.post(`/invitations/${ownerInvite.id}/revoke`, {})).statusCode).toBe(403);
  });

  it("does not let technicians or read-only users invite or list users", async () => {
    const t = await createTenant(ctx, "Org A");
    for (const role of ["technician", "read_only"] as const) {
      const u = await createUser(ctx.db, t.org.id, role);
      const api = client(ctx.app, await login(ctx.app, u.email));
      expect((await api.post("/invitations", { email: "a@example.com", role: "technician" })).statusCode).toBe(403);
      expect((await api.get("/users")).statusCode).toBe(403);
    }
  });
});

describe("invitation isolation", () => {
  it("hides and protects another organization's invitations", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const bInvite = await invite(b.api, { email: "b-person@example.com", role: "technician", name: "B" });
    expect((await a.api.get("/users")).json().invitations).toHaveLength(0);
    expect((await a.api.get("/users")).json().members.map((m: { email: string }) => m.email)).toEqual([a.owner.email]);
    expect((await a.api.post(`/invitations/${bInvite.invitation.id}/resend`, {})).statusCode).toBe(404);
    expect((await a.api.post(`/invitations/${bInvite.invitation.id}/revoke`, {})).statusCode).toBe(404);
    // Accepting B's invitation makes a member of B only.
    const res = await accept(tokenOf(bInvite.url), { password: "a strong password" });
    expect(res.json().organization.id).toBe(b.org.id);
    expect(res.json().organizations).toHaveLength(1);
  });
});

describe("owner invitations from /admin", () => {
  it("lets a platform admin invite a new organization's first owner", async () => {
    mail.delivered.clear();
    await createAdmin(ctx);
    const admin = client(ctx.app, await adminLogin(ctx));
    const org = (await admin.post("/admin/organizations", { name: "Brazos Aerobic Co" })).json();
    const res = await admin.post(`/admin/organizations/${org.id}/invitations`, { email: "owner@brazos.example", name: "Bea Owner" });
    expect(res.statusCode, res.body).toBe(201);
    const sent = res.json();
    expect(sent.invitation).toMatchObject({ role: "owner", invitedBy: "Aerowise" });
    expect(emailsTo("owner@brazos.example")[0]?.subject).toBe("The Aerowise team invited you to Brazos Aerobic Co on Aerowise");

    const events = await ctx.db.selectFrom("platformAuditEvents").select(["action", "organizationId"]).orderBy("id").execute();
    expect(events.at(-1)).toEqual({ action: "invitation.sent", organizationId: org.id });

    const accepted = await accept(tokenOf(sent.url), { password: "a strong password" });
    expect(accepted.json()).toMatchObject({ role: "owner", organization: { name: "Brazos Aerobic Co" } });
    const list = (await admin.get("/admin/organizations")).json().items;
    expect(list.find((o: { id: string }) => o.id === org.id).users).toBe(1);
  });

  it("answers 404 for an unknown organization", async () => {
    await createAdmin(ctx);
    const admin = client(ctx.app, await adminLogin(ctx));
    const res = await admin.post(`/admin/organizations/${crypto.randomUUID()}/invitations`, { email: "x@example.com" });
    expect(res.statusCode).toBe(404);
  });

  it("keeps the invitation and returns the link when the email fails", async () => {
    const org = await createOrg(ctx.db, "Org C");
    await createAdmin(ctx);
    const admin = client(ctx.app, await adminLogin(ctx));
    mail.mode = "fail";
    try {
      const res = await admin.post(`/admin/organizations/${org.id}/invitations`, { email: "c@example.com", name: "C" });
      expect(res.statusCode).toBe(201);
      expect(res.json().emailed).toBe(false);
      expect((await accept(tokenOf(res.json().url), { password: "a strong password" })).statusCode).toBe(200);
    } finally {
      mail.mode = "ok";
    }
  });
});
