import { describe, expect, it } from "vitest";
import { client, createAdmin, createOrg, createUser, login, setupTestApp } from "./helpers.ts";
import { JPEG, payload, photoUrl, setup } from "./inspection-helpers.ts";

// STG-03: a phone holding a demo company's route must learn when that demo has ended, so it
// can clear it, without being able to learn anything about any other company; and work queued
// on a phone for one sign-in is never recorded under another sign-in on the same phone.
const ctx = setupTestApp();

const status = (organizationId: unknown, ip = "203.0.113.7") =>
  ctx.app.inject({ method: "POST", url: "/auth/access-status", payload: organizationId === undefined ? {} : { organizationId }, remoteAddress: ip });

async function demoCompany(name: string, endsAt: Date) {
  return ctx.db.insertInto("organizations").values({ name, demo: true, demoExpiresAt: endsAt } as never).returning("id").executeTakeFirstOrThrow();
}

describe("access status", () => {
  it("says ended only for a demo company past its end", async () => {
    const ended = await demoCompany("Ended demo", new Date(Date.now() - 60_000));
    const live = await demoCompany("Live demo", new Date(Date.now() + 86_400_000));
    expect((await status(ended.id)).json()).toEqual({ state: "ended" });
    expect((await status(live.id)).json()).toEqual({ state: "unknown" });
  });

  it("answers a live real company, a deleted one, a random id and a malformed one identically", async () => {
    const real = await createOrg(ctx.db, "Real company");
    await createUser(ctx.db, real.id, "owner");
    const deleted = await createOrg(ctx.db, "Deleted company");
    await ctx.db.updateTable("organizations").set({ dataDeletedAt: new Date(), dataDeletedBy: (await createAdmin(ctx)).id }).where("id", "=", deleted.id).execute();
    const answers = [];
    for (const id of [real.id, deleted.id, crypto.randomUUID(), "not-a-uuid", 42, null, undefined]) {
      const res = await status(id, `198.51.100.${answers.length + 1}`);
      answers.push({ code: res.statusCode, body: res.body, type: res.headers["content-type"] });
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual({ code: 200, body: JSON.stringify({ state: "unknown" }), type: expect.stringContaining("application/json") });
  });

  it("is limited per address", async () => {
    for (let i = 0; i < 30; i++) expect((await status(crypto.randomUUID(), "192.0.2.1")).statusCode).toBe(200);
    expect((await status(crypto.randomUUID(), "192.0.2.1")).statusCode).toBe(429);
    expect((await status(crypto.randomUUID(), "192.0.2.99")).statusCode).toBe(200);
  });
});

describe("the sign-in a request is for", () => {
  it("refuses work queued for one company replayed under another company's sign-in, and records nothing", async () => {
    const a = await setup(ctx, "Org A");
    const b = await setup(ctx, "Org B");
    const forA = { "x-aerowise-tenant": `${a.org.id}:${a.tech.id}` };
    const forB = { "x-aerowise-tenant": `${b.org.id}:${b.tech.id}` };
    const techB = await login(ctx.app, b.tech.email);
    const queued = payload(a, { clientId: crypto.randomUUID() });

    // The phone now holds B's session; A's queued sync and photo are replayed.
    const replay = await ctx.app.inject({ method: "PUT", url: "/inspections/sync", payload: queued, headers: { cookie: techB, ...forA } });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error).toBe("tenant_mismatch");
    const photo = await ctx.app.inject({
      method: "PUT",
      url: photoUrl(queued.clientId, 1),
      payload: JPEG,
      headers: { cookie: techB, ...forA, "content-type": "image/jpeg", "x-photo-key": "overview", "x-captured-at": "2026-03-01T15:10:00Z" },
    });
    expect(photo.statusCode).toBe(409);
    // Reads are refused too, so a phone never saves B's route as A's.
    expect((await ctx.app.inject({ method: "GET", url: "/route", headers: { cookie: techB, ...forA } })).statusCode).toBe(409);
    expect(await ctx.db.selectFrom("inspections").select("id").execute()).toEqual([]);
    expect(await ctx.db.selectFrom("attachments").select("id").execute()).toEqual([]);

    // Signed in as A again, the same queued work goes through, once.
    const techA = await login(ctx.app, a.tech.email);
    const sent = await ctx.app.inject({ method: "PUT", url: "/inspections/sync", payload: queued, headers: { cookie: techA, ...forA } });
    expect(sent.statusCode).toBe(200);
    const again = await ctx.app.inject({ method: "PUT", url: "/inspections/sync", payload: queued, headers: { cookie: techA, ...forA } });
    expect(again.json().id).toBe(sent.json().id);
    expect(await ctx.db.selectFrom("inspections").select("organizationId").execute()).toEqual([{ organizationId: a.org.id }]);
    // B's own requests, naming B, are unaffected.
    expect((await ctx.app.inject({ method: "GET", url: "/route", headers: { cookie: techB, ...forB } })).statusCode).toBe(200);
  });

  it("refuses another person's queued work in the same company", async () => {
    const a = await setup(ctx, "Org A");
    const other = await createUser(ctx.db, a.org.id, "technician");
    const res = await ctx.app.inject({
      method: "PUT",
      url: "/inspections/sync",
      payload: payload(a),
      headers: { cookie: await login(ctx.app, other.email), "x-aerowise-tenant": `${a.org.id}:${a.tech.id}` },
    });
    expect(res.statusCode).toBe(409);
    expect(await ctx.db.selectFrom("inspections").select("id").execute()).toEqual([]);
  });

  it("changes nothing for requests that do not name one", async () => {
    const a = await setup(ctx, "Org A");
    expect((await a.techApi.put("/inspections/sync", payload(a))).statusCode).toBe(200);
    expect((await client(ctx.app).get("/route")).statusCode).toBe(401);
  });
});
