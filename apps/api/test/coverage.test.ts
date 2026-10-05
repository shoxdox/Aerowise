import { fileURLToPath } from "node:url";
import { bundledRulesets, syncRulesets } from "@aerowise/compliance";
import type { RulesetCoverage } from "@aerowise/domain";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminLogin, client, createAdmin, createTenant, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();

// The bundled rulesets (the fictional example, LCRA and Harris drafts) plus the fixtures.
const FIXTURES = bundledRulesets(fileURLToPath(new URL("./fixtures/rulesets", import.meta.url)));

beforeEach(async () => {
  await syncRulesets(ctx.db);
  await syncRulesets(ctx.db, FIXTURES);
});

// Other test files list the authorities, so leave only the bundled ones behind.
afterAll(async () => {
  await sql`truncate jurisdiction_rulesets, jurisdictions cascade`.execute(ctx.db);
  await syncRulesets(ctx.db);
});

describe("the ruleset coverage page", () => {
  it("counts the sites each authority covers today across organizations, with its status and open questions", async () => {
    const a = await createTenant(ctx, "Org A");
    const b = await createTenant(ctx, "Org B");
    const site = async (t: typeof a, county: string | null) => {
      const s = (await t.api.post(`/customers/${t.customer.id}/sites`, { addressLine1: "2 Oak St", city: "Austin", county })).json();
      expect(s.id).toBeTruthy();
      return s;
    };
    await a.api.patch(`/sites/${a.site.id}`, { county: "Example County" });
    await site(a, "example county"); // matched case-insensitively
    await site(a, "Nowhere County");
    await site(a, "Travis"); // LCRA covers only part of Travis: a person decides
    await b.api.patch(`/sites/${b.site.id}`, { county: "Example County" });
    await site(b, "Verified Fixture County");
    const gone = await site(b, "Example County");
    await ctx.db.updateTable("sites").set({ active: false }).where("id", "=", gone.id).execute();

    const admin = client(ctx.app, (await createAdmin(ctx), await adminLogin(ctx)));
    const res = await admin.get("/admin/rulesets");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as RulesetCoverage;
    const byKey = Object.fromEntries(body.items.map((i) => [i.key, i]));

    expect(body.today).toBe("2026-03-01");
    expect(byKey["tx-example-county"]).toMatchObject({ profileStatus: "fictional", verified: null, sites: 3, organizations: 2, sitesToDecide: 0, rulesetVersion: 1 });
    expect(byKey["tx-fixture-verified"]).toMatchObject({
      profileStatus: "verified",
      verified: { authorityName: "Verified Fixture County (fictional)", confirmedOn: "2026-02-02" },
      sites: 1,
      organizations: 1,
      unresolved: [],
      sourcesCheckedOn: "2026-01-10",
      sourceCount: 1,
    });
    expect(byKey["tx-lcra-ossf"]).toMatchObject({ profileStatus: "draft", verified: null, sites: 0, sitesToDecide: 1 });
    expect(byKey["tx-lcra-ossf"]!.unresolved.length).toBeGreaterThan(0);
    expect(byKey["tx-fixture-draft"]).toMatchObject({ profileStatus: "draft", sites: 0, unresolved: ["FICTIONAL: whether the authority accepts reports by email"] });
    // "Nowhere County" has no authority; the inactive site is not counted anywhere.
    expect(body.sitesWithoutAuthority).toBe(1);
  });

  it("is for platform admins only", async () => {
    const t = await createTenant(ctx, "Org A");
    expect((await t.api.get("/admin/rulesets")).statusCode).toBe(401);
  });
});
