import { CURRENT_LEGAL_VERSIONS } from "@aerowise/domain";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();
const CURRENT = { terms: CURRENT_LEGAL_VERSIONS.terms, privacy: CURRENT_LEGAL_VERSIONS.privacy };

describe("terms and privacy acceptance", () => {
  it("an owner is asked to accept, and the acceptance is recorded with the version and time", async () => {
    const t = await createTenant(ctx, "Org A");
    expect((await t.api.get("/auth/me")).json().legalDue).toEqual(["terms", "privacy"]);

    const res = await t.api.post("/legal/accept", CURRENT);
    expect(res.statusCode).toBe(200);
    expect(res.json().due).toEqual([]);
    expect(res.json().documents).toEqual([
      { document: "terms", title: "Terms of service", currentVersion: CURRENT.terms, acceptedVersion: CURRENT.terms, acceptedAt: ctx.now.toISOString() },
      { document: "privacy", title: "Privacy policy", currentVersion: CURRENT.privacy, acceptedVersion: CURRENT.privacy, acceptedAt: ctx.now.toISOString() },
    ]);
    expect((await t.api.get("/auth/me")).json().legalDue).toEqual([]);

    const rows = await ctx.db.selectFrom("legalAcceptances").select(["organizationId", "userId", "document", "version", "acceptedAt"]).orderBy("document").execute();
    expect(rows).toEqual([
      { organizationId: t.org.id, userId: t.owner.id, document: "privacy", version: CURRENT.privacy, acceptedAt: ctx.now },
      { organizationId: t.org.id, userId: t.owner.id, document: "terms", version: CURRENT.terms, acceptedAt: ctx.now },
    ]);
    const audit = await ctx.db.selectFrom("auditEvents").select("action").where("action", "=", "legal.accepted").execute();
    expect(audit).toHaveLength(2);

    // Accepting again changes nothing.
    ctx.now = new Date("2026-03-02T18:00:00Z");
    await t.api.post("/legal/accept", CURRENT);
    expect(await ctx.db.selectFrom("legalAcceptances").select("id").execute()).toHaveLength(2);
  });

  it("a new version asks again, and the earlier acceptance stays on record", async () => {
    const t = await createTenant(ctx, "Org A");
    // An acceptance of an older version, as if the terms changed after the owner agreed.
    await ctx.db.insertInto("legalAcceptances").values({ organizationId: t.org.id, userId: t.owner.id, document: "terms", version: "2025-01-01", acceptedAt: new Date("2026-01-01T00:00:00Z"), requestId: null }).execute();
    await ctx.db.insertInto("legalAcceptances").values({ organizationId: t.org.id, userId: t.owner.id, document: "privacy", version: CURRENT.privacy, acceptedAt: new Date("2026-01-01T00:00:00Z"), requestId: null }).execute();
    expect((await t.api.get("/auth/me")).json().legalDue).toEqual(["terms"]);
    expect((await t.api.get("/legal")).json().documents[0]).toMatchObject({ acceptedVersion: "2025-01-01", currentVersion: CURRENT.terms });

    // Accepting a version the owner was shown before the change is refused.
    const stale = await t.api.post("/legal/accept", { ...CURRENT, terms: "2025-01-01" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("legal_version_changed");

    await t.api.post("/legal/accept", CURRENT);
    expect((await t.api.get("/auth/me")).json().legalDue).toEqual([]);
    const terms = await ctx.db.selectFrom("legalAcceptances").select("version").where("document", "=", "terms").orderBy("acceptedAt").execute();
    expect(terms.map((r) => r.version)).toEqual(["2025-01-01", CURRENT.terms]);
  });

  it("acceptances can never be changed or removed", async () => {
    const t = await createTenant(ctx, "Org A");
    await t.api.post("/legal/accept", CURRENT);
    await expect(sql`update legal_acceptances set version = 'x'`.execute(ctx.db)).rejects.toThrow(/append-only/);
    await expect(sql`delete from legal_acceptances`.execute(ctx.db)).rejects.toThrow(/append-only/);
  });

  it("each owner accepts for themselves; other roles are never asked and cannot accept", async () => {
    const t = await createTenant(ctx, "Org A");
    await t.api.post("/legal/accept", CURRENT);
    const second = await createUser(ctx.db, t.org.id, "owner");
    const secondApi = client(ctx.app, await login(ctx.app, second.email));
    expect((await secondApi.get("/auth/me")).json().legalDue).toEqual(["terms", "privacy"]);

    const office = await createUser(ctx.db, t.org.id, "office");
    const officeApi = client(ctx.app, await login(ctx.app, office.email));
    expect((await officeApi.get("/auth/me")).json().legalDue).toEqual([]);
    expect((await officeApi.post("/legal/accept", CURRENT)).statusCode).toBe(403);
  });

  it("an owner of a read-only (lapsed) company can still accept", async () => {
    const t = await createTenant(ctx, "Org A");
    await ctx.db.updateTable("organizations").set({ subscriptionState: "read_only", subscriptionEndsOn: null }).where("id", "=", t.org.id).execute();
    expect((await t.api.post("/customers", { displayName: "Blocked" })).statusCode).toBe(403);
    expect((await t.api.post("/legal/accept", CURRENT)).statusCode).toBe(200);
  });

  it("acceptance in one organization says nothing about another", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    await a.api.post("/legal/accept", CURRENT);
    expect((await b.api.get("/auth/me")).json().legalDue).toEqual(["terms", "privacy"]);
    expect((await b.api.get("/legal")).json().documents.every((d: { acceptedVersion: unknown }) => d.acceptedVersion === null)).toBe(true);
    // The database refuses an acceptance for a user who is not a member of that organization.
    await expect(
      ctx.db.insertInto("legalAcceptances").values({ organizationId: b.org.id, userId: a.owner.id, document: "terms", version: CURRENT.terms, acceptedAt: ctx.now, requestId: null }).execute(),
    ).rejects.toThrow(/foreign key/);
  });
});
