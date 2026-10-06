import { fileURLToPath } from "node:url";
import { bundledRulesets, syncRulesets } from "@aerowise/compliance";
import { profileStatus } from "@aerowise/domain";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();

const FIXTURES = bundledRulesets(fileURLToPath(new URL("./fixtures/rulesets", import.meta.url)));

// Other test files list the authorities, so leave only the bundled ones behind.
afterAll(async () => {
  await sql`truncate jurisdiction_rulesets, jurisdictions cascade`.execute(ctx.db);
  await syncRulesets(ctx.db);
});

const overview = async (app = ctx.app) => app.inject({ method: "GET", url: "/public/overview" });

describe("the marketing page's overview", () => {
  it("needs no sign-in and lists every real bundled authority, never the fictional one", async () => {
    const res = await overview();
    expect(res.statusCode).toBe(200);
    // One entry per authority, from its newest version.
    const real = [...new Map(bundledRulesets().filter((r) => profileStatus(r) !== "fictional").map((r) => [r.jurisdiction.key, r])).values()];
    const coverage = res.json().coverage as { key: string; status: string; verified: unknown; counties: string[] }[];
    expect(coverage.map((c) => c.key).sort()).toEqual(real.map((r) => r.jurisdiction.key).sort());
    expect(coverage.map((c) => c.key)).not.toContain("tx-example-county");
    for (const r of real) {
      expect(coverage.find((c) => c.key === r.jurisdiction.key)?.counties).toEqual(r.applicability.counties);
    }
  });

  it("marks verified authorities with the badge and lists them first; drafts show as in progress", async () => {
    await syncRulesets(ctx.db, FIXTURES);
    const coverage = (await overview()).json().coverage as { key: string; status: string; verified: unknown }[];
    expect(coverage[0]).toMatchObject({
      key: "tx-fixture-verified",
      status: "verified",
      verified: { authorityName: "Verified Fixture County (fictional)", confirmedOn: "2026-02-02", method: "email" },
    });
    expect(coverage.find((c) => c.key === "tx-fixture-draft")).toMatchObject({ status: "draft", verified: null });
    expect(coverage.filter((c) => c.status === "verified").map((c) => c.key)).toEqual(["tx-fixture-verified"]);
  });

  it("reads pricing from the deployment's subscription config, not fixed copy", async () => {
    expect((await overview()).json().pricing).toEqual({ designPartnerDays: 90, trialDays: 30, pricePerContractCents: 150, monthlyMinimumCents: 9900 });
    const app = await buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store, subscription: { designPartnerDays: 60, trialDays: 14, pricePerContractCents: 200, monthlyMinimumCents: 4900, pastDueGraceDays: 14 } });
    try {
      expect((await overview(app)).json().pricing).toEqual({ designPartnerDays: 60, trialDays: 14, pricePerContractCents: 200, monthlyMinimumCents: 4900 });
    } finally {
      await app.close();
    }
  });

  it("is rate-limited per address", async () => {
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await ctx.app.inject({ method: "GET", url: "/public/overview", remoteAddress: "203.0.113.9" })).statusCode;
    expect(last).toBe(429);
  });
});
