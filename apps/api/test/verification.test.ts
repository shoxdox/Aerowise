import { fileURLToPath } from "node:url";
import { bundledRulesets, syncRulesets } from "@aerowise/compliance";
import { drainTasks } from "@aerowise/tasks";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FakeMail } from "./fake-mail.ts";
import { setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, payload, setup, signAsProvider, uploadRequiredPhotos } from "./inspection-helpers.ts";

// Today is 2026-03-01 (setupTestApp's clock).
const ctx = setupTestApp();
const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });

const FIXTURES = bundledRulesets(fileURLToPath(new URL("./fixtures/rulesets", import.meta.url)));
const VERIFIED = "Verified Fixture County";
const DRAFT = "Draft Fixture County";
const BADGE = { authorityName: "Verified Fixture County (fictional)", confirmedOn: "2026-02-02", confirmedWith: "OSSF program staff, Verified Fixture County (fictional)", method: "email" };

beforeEach(async () => {
  mail.mode = "ok";
  mail.delivered.clear();
  await syncRulesets(ctx.db, FIXTURES);
});

// Other test files list the authorities, so leave only the bundled ones behind.
afterAll(async () => {
  await sql`truncate jurisdiction_rulesets, jurisdictions cascade`.execute(ctx.db);
  await syncRulesets(ctx.db);
});

/** A signed (unless `sign` is false), completed inspection at a site in `county`, with the worker run. */
async function filed(c: TestContext, county: string, name = "Org A", sign = true) {
  const s = await setup(c, name);
  expect((await s.api.patch(`/sites/${s.site.id}`, { county })).statusCode).toBe(200);
  await c.db.updateTable("memberships").set({ technicianLicense: "MT-0001" }).where("userId", "=", s.tech.id).execute();
  const p = payload(s);
  await s.techApi.put("/inspections/sync", p);
  await uploadRequiredPhotos(s, p.clientId);
  const done = (await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: { ...completeValues(), air_pressure: 4.5 } }))).json();
  await runWorker(c);
  if (sign) await signAsProvider(s, done.id);
  await runWorker(c);
  const f = (await s.api.get("/filings?view=all")).json().items[0];
  return { ...s, filing: (await s.api.get(`/filings/${f.id}`)).json() };
}

describe("the verified badge", () => {
  it("shows on a site and its filings only when the ruleset was confirmed with the authority", async () => {
    const v = await filed(ctx, VERIFIED);
    expect((await v.api.get(`/sites/${v.site.id}/jurisdiction`)).json()).toMatchObject({ jurisdiction: { profileStatus: "verified", verified: BADGE }, profile: { status: "verified" } });
    expect(v.filing.profile).toMatchObject({ status: "verified", verified: BADGE });

    const d = await filed(ctx, DRAFT, "Org B");
    expect((await d.api.get(`/sites/${d.site.id}/jurisdiction`)).json().jurisdiction).toMatchObject({ profileStatus: "draft", verified: null });
    expect(d.filing.profile).toMatchObject({ status: "draft", verified: null });

    const items = (await v.api.get("/jurisdictions")).json().items as { key: string; verified: unknown }[];
    expect(items.filter((j) => j.verified).map((j) => j.key)).toEqual(["tx-fixture-verified"]);
    // The fictional example and the drafts never show it.
    expect(items.find((j) => j.key === "tx-example-county")).toMatchObject({ verified: null });
  });
});

describe("sending", () => {
  it("is automatic for a verified ruleset", async () => {
    const v = await filed(ctx, VERIFIED);
    expect(v.filing).toMatchObject({ status: "sent" });
    expect([...mail.delivered.values()].map((m) => m.to)).toEqual(["filings@tx-fixture-verified.example"]);
  });

  it("never sends a report on its own before the maintenance provider signs it, even for a verified ruleset", async () => {
    const v = await filed(ctx, VERIFIED, "Org A", false);
    expect(v.filing).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("sign the authority report (version 1)") });
    expect(mail.delivered.size).toBe(0);
    // Queued anyway (a sweep, a retry): the last check before sending puts it back to wait for the signature.
    await ctx.db.updateTable("filings").set({ status: "queued" }).where("id", "=", v.filing.id).execute();
    await ctx.db.insertInto("backgroundTasks").values({ kind: "filings.submit", organizationId: v.org.id, payload: JSON.stringify({ filingId: v.filing.id }), runAt: ctx.now }).execute();
    await runWorker(ctx);
    expect(mail.delivered.size).toBe(0);
    expect((await v.api.get(`/filings/${v.filing.id}`)).json()).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("sign") });
  });

  it("never happens on its own for a draft, even when the ruleset asks for automatic submission", async () => {
    const d = await filed(ctx, DRAFT);
    expect(d.filing).toMatchObject({ status: "ready" });
    expect(mail.delivered.size).toBe(0);
    // A sweep or retry that queues it anyway is held back to Ready.
    await ctx.db.updateTable("filings").set({ status: "queued" }).where("id", "=", d.filing.id).execute();
    await ctx.db
      .insertInto("backgroundTasks")
      .values({ kind: "filings.submit", organizationId: d.org.id, payload: JSON.stringify({ filingId: d.filing.id }), runAt: ctx.now })
      .execute();
    await runWorker(ctx);
    expect((await d.api.get(`/filings/${d.filing.id}`)).json().status).toBe("ready");
    expect(mail.delivered.size).toBe(0);
    // A person pressing Send is what sends it.
    expect((await d.api.post(`/filings/${d.filing.id}/submit`, {})).statusCode).toBe(200);
    await runWorker(ctx);
    expect((await d.api.get(`/filings/${d.filing.id}`)).json().status).toBe("sent");
  });
});
