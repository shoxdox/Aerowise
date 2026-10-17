import { bundledRulesets, loadCatalog, resolveSite, submitFiling, syncRulesets } from "@aerowise/compliance";
import { complianceContext, drainTasks } from "@aerowise/tasks";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { FakeMail } from "./fake-mail.ts";
import { client, createOrg, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";
import { completeValues, payload, setup, signAsProvider, uploadRequiredPhotos, type Setup } from "./inspection-helpers.ts";

const ctx = setupTestApp();

const mail = new FakeMail();
const runWorker = (c: TestContext) => drainTasks({ db: c.db, store: c.store, now: () => c.now, mail });
const later = (c: TestContext, ms: number) => (c.now = new Date(c.now.getTime() + ms));

/** A visit at a site in the fake county, done by a licensed technician. */
async function countySetup(c: TestContext, name = "Org A", opts: { county?: string | null; license?: string | null } = {}) {
  const s = await setup(c, name);
  const county = opts.county === undefined ? "Example County" : opts.county;
  if (county) expect((await s.api.patch(`/sites/${s.site.id}`, { county })).statusCode).toBe(200);
  const license = opts.license === undefined ? "MP-0001" : opts.license;
  await c.db.updateTable("memberships").set({ technicianLicense: license }).where("userId", "=", s.tech.id).execute();
  return s;
}

/** Completes the inspection with everything the county asks for. */
async function complete(s: Setup, values: Record<string, unknown> = { ...completeValues(), air_pressure: 4.5 }) {
  const p = payload(s);
  await s.techApi.put("/inspections/sync", p);
  await uploadRequiredPhotos(s, p.clientId);
  const res = await s.techApi.put("/inspections/sync", payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values }));
  return res.json() as { id: string; status: string; validationStatus: string; validationProblems: { key: string }[] };
}

/** The reports are made, the MP signs (30 TAC 285.7(b)(3): nothing goes out before), and the worker files it. */
async function signAndFile(s: Setup, inspectionId: string) {
  await runWorker(ctx);
  await signAsProvider(s, inspectionId);
  await runWorker(ctx);
}

const filingOf = async (s: Setup, view = "all") => {
  const res = await s.api.get(`/filings?view=${view}`);
  expect(res.statusCode).toBe(200);
  return res.json().items[0] as { id: string; status: string; [k: string]: unknown } | undefined;
};
const detailOf = async (s: Setup, id: string) => (await s.api.get(`/filings/${id}`)).json();
const events = async (s: Setup) => ((await s.api.get(`/sites/${s.site.id}/compliance-events`)).json().items as { eventType: string; filingId: string | null }[]).map((e) => e.eventType);

describe("filing with the county", () => {
  it("emails the authority report once it exists; sent is not confirmed until the authority says so", async () => {
    mail.delivered.clear();
    mail.mode = "ok";
    const s = await countySetup(ctx);
    const insp = await complete(s);
    expect(insp.status).toBe("completed");

    // Opened at completion, waiting for the report.
    const opened = await filingOf(s);
    expect(opened).toMatchObject({ status: "pending", deadlineOn: "2026-03-15", nextDueOn: "2026-07-01", jurisdiction: { key: "tx-example-county", rulesetVersion: 2 } });

    // The county's rules send by themselves, but never before the MP signs the report.
    await runWorker(ctx);
    expect(await detailOf(s, opened!.id)).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("Waiting for a licensed maintenance provider to sign the authority report (version 1)") });
    expect(mail.delivered.size).toBe(0);
    await signAsProvider(s, insp.id);
    expect((await detailOf(s, opened!.id)).status).toBe("queued");
    await runWorker(ctx);
    const sent = await detailOf(s, opened!.id);
    expect(sent).toMatchObject({ status: "sent", submissionMethod: "email", methodVersion: "email-manual@2", stateMachineVersion: 2, confirmedAt: null, confirmationReference: null });
    expect(sent.proof).toMatchObject({ kind: "email_message_id", reference: expect.stringContaining("@fake>") });
    expect(sent.attempts).toHaveLength(1);
    expect(sent.package).toMatchObject({ destination: "filings@tx-example-county.example", subject: "Aerobic maintenance report, permit not recorded" });
    // What went out is the signed copy.
    const signature = await ctx.db.selectFrom("reportSignatures").select("sha256").executeTakeFirstOrThrow();
    expect(sent.packages[0].documents.find((d: { role: string }) => d.role === "inspection_report").sha256).toBe(signature.sha256);

    const message = [...mail.delivered.values()][0]!;
    expect(message.to).toBe("filings@tx-example-county.example");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]!.content.subarray(0, 5).toString()).toBe("%PDF-");
    // The attachment is the authority copy, not the customer copy.
    const report = await ctx.db.selectFrom("reports").select(["id", "audience"]).where("id", "=", (await ctx.db.selectFrom("filings").select("reportId").executeTakeFirstOrThrow()).reportId!).executeTakeFirstOrThrow();
    expect(report.audience).toBe("authority");

    // Sent is still in "sent", not "confirmed".
    expect((await filingOf(s, "sent"))?.id).toBe(opened!.id);
    expect(await filingOf(s, "confirmed")).toBeUndefined();

    const confirmed = await s.api.post(`/filings/${opened!.id}/confirm`, { reference: "EC-2026-00042", note: "Clerk replied by email" });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: "confirmed", confirmationReference: "EC-2026-00042", confirmationNote: "Clerk replied by email", deadlineState: "met" });
    expect(await events(s)).toEqual(expect.arrayContaining(["filing_opened", "filing_ready", "filing_sent", "filing_confirmed"]));

    // Confirmed is final.
    expect((await s.api.post(`/filings/${opened!.id}/confirm`, { reference: "again" })).statusCode).toBe(409);
    // And the database refuses a confirmed filing without a reference.
    await expect(sql`update filings set confirmation_reference = null`.execute(ctx.db)).rejects.toThrow(/check/);
  });

  it("turns an email failure into an exception, then retries without sending twice", async () => {
    mail.delivered.clear();
    mail.mode = "lose_response_once";
    const s = await countySetup(ctx);
    await signAndFile(s, (await complete(s)).id);

    // The provider took the message but the answer never came back.
    const failed = await filingOf(s, "attention");
    expect(failed).toMatchObject({ status: "failed", lastError: expect.stringContaining("timed out") });
    expect(await events(s)).toContain("filing_failed");

    // The queue retries after a backoff; the retry reuses the idempotency key.
    expect(await runWorker(ctx)).toBe(0);
    later(ctx, 60_000);
    await runWorker(ctx);
    const sent = await detailOf(s, failed!.id);
    expect(sent.status).toBe("sent");
    expect(sent.attempts.map((a: { status: string }) => a.status)).toEqual(["succeeded", "failed"]);
    expect(mail.delivered.size).toBe(1);

    // Running the submission again, or queueing a duplicate, changes nothing.
    const calls = mail.calls;
    expect(await submitFiling(complianceContext({ db: ctx.db, store: ctx.store, now: () => ctx.now, mail }), s.org.id, failed!.id)).toBeNull();
    expect(mail.calls).toBe(calls);
    expect((await detailOf(s, failed!.id)).attempts).toHaveLength(2);
    expect((await filingOf(s, "attention"))).toBeUndefined();
  });

  it("records one failure on the timeline however many automatic retries fail, and the office can retry", async () => {
    mail.delivered.clear();
    mail.mode = "fail";
    const s = await countySetup(ctx);
    await signAndFile(s, (await complete(s)).id);
    for (let i = 0; i < 2; i++) {
      later(ctx, 3600_000);
      await runWorker(ctx);
    }
    const f = await detailOf(s, (await filingOf(s))!.id);
    expect(f.status).toBe("failed");
    expect(f.attempts).toHaveLength(3);
    expect((await events(s)).filter((e) => e === "filing_failed")).toHaveLength(1);

    mail.mode = "ok";
    const retried = await s.api.post(`/filings/${f.id}/retry`, {});
    expect(retried.json().status).toBe("queued");
    // Retrying pulls the waiting retry forward rather than queueing a second one.
    const waiting = await ctx.db.selectFrom("backgroundTasks").select("id").where("kind", "=", "filings.submit").where("completedAt", "is", null).execute();
    expect(waiting).toHaveLength(1);
    await runWorker(ctx);
    expect((await detailOf(s, f.id)).status).toBe("sent");
    expect(mail.delivered.size).toBe(1);
  });

  it("falls back to filing by hand, keeping the proof the office records", async () => {
    mail.mode = "fail";
    const s = await countySetup(ctx);
    await signAndFile(s, (await complete(s)).id);
    const f = (await filingOf(s))!;
    expect(f.status).toBe("failed");

    const manual = await s.api.post(`/filings/${f.id}/manual`, {});
    expect(manual.json()).toMatchObject({ status: "ready", submissionMethod: "manual_export" });
    expect(manual.json().package.reportUrl).toMatch(/^\/package-files\//);
    expect((await client(ctx.app).get(manual.json().package.reportUrl)).statusCode).toBe(200);

    const sent = await s.api.post(`/filings/${f.id}/mark-sent`, { reference: "PORTAL-881", note: "Uploaded on the county portal" });
    expect(sent.json()).toMatchObject({ status: "sent", proof: { kind: "manual_submission", reference: "PORTAL-881", by: "owner user" } });

    // The automatic retry that was still waiting finds the filing handled and does nothing.
    mail.mode = "ok";
    const calls = mail.calls;
    later(ctx, 3600_000);
    await runWorker(ctx);
    expect(mail.calls).toBe(calls);
    expect((await detailOf(s, f.id)).status).toBe("sent");
  });

  it("resubmits after a rejection as a new submission", async () => {
    mail.delivered.clear();
    mail.mode = "ok";
    const s = await countySetup(ctx);
    await signAndFile(s, (await complete(s)).id);
    const f = (await filingOf(s))!;
    const rejected = await s.api.post(`/filings/${f.id}/reject`, { reason: "Permit number missing" });
    expect(rejected.json()).toMatchObject({ status: "rejected", rejectionReason: "Permit number missing" });
    expect((await filingOf(s, "attention"))?.id).toBe(f.id);

    await s.api.patch(`/sites/${s.site.id}`, { permitNumber: "EX-1234" });
    expect((await s.api.post(`/filings/${f.id}/resubmit`, {})).json()).toMatchObject({ status: "queued", submissionNo: 2, proof: null });
    await runWorker(ctx);
    expect((await detailOf(s, f.id)).status).toBe("sent");
    expect([...mail.delivered.keys()]).toEqual([`filing-${f.id}-submission-1`, `filing-${f.id}-submission-2`]);
    expect([...mail.delivered.values()][1]!.subject).toBe("Aerobic maintenance report, permit EX-1234");
  });

  it("warns as the deadline approaches, at the ruleset's threshold", async () => {
    const s = await countySetup(ctx);
    await complete(s);
    // The worker has not run, so the filing is still open (pending). Deadline 2026-03-15, warning 5 days.
    ctx.now = new Date("2026-03-09T18:00:00Z");
    expect((await filingOf(s)) as unknown).toMatchObject({ deadlineState: "ok" });
    expect(await filingOf(s, "attention")).toBeUndefined();
    ctx.now = new Date("2026-03-10T18:00:00Z");
    expect(await filingOf(s, "attention")).toMatchObject({ deadlineState: "approaching" });
    ctx.now = new Date("2026-03-16T18:00:00Z");
    expect(await filingOf(s, "attention")).toMatchObject({ deadlineState: "overdue" });
  });
});

describe("jurisdiction requirements", () => {
  it("will not complete an inspection missing an answer the county requires", async () => {
    const s = await countySetup(ctx);
    const route = (await s.techApi.get("/route")).json();
    expect(route.items[0].requirements).toMatchObject({ jurisdictionKey: "tx-example-county", requiredFields: ["air_pressure"] });

    // Air pressure is optional in the template, but the county requires it.
    const insp = await complete(s, completeValues());
    expect(insp).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(insp.validationProblems.map((p) => p.key)).toEqual(["air_pressure"]);
    expect(await filingOf(s)).toBeUndefined();
  });

  it("never accepts anyway an inspection missing a reading the county requires", async () => {
    const s = await countySetup(ctx);
    const insp = await complete(s, completeValues());
    const refused = await s.api.post(`/inspections/${insp.id}/override`, { reason: "Gauge broken" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toContain("Air pressure is required");
    expect((await s.api.get(`/inspections/${insp.id}`)).json()).toMatchObject({ status: "draft", validationStatus: "invalid" });
    expect(await filingOf(s)).toBeUndefined();
  });

  it("takes a reading the county requires as a correction on a filing held for it, then waits for the MP to sign that version", async () => {
    mail.delivered.clear();
    mail.mode = "ok";
    // Done before the site's authority was known, so the phone did not ask for air pressure.
    const s = await countySetup(ctx, "Org A", { county: null });
    const insp = await complete(s, completeValues());
    expect(insp.status).toBe("completed");
    await runWorker(ctx);
    await s.api.patch(`/sites/${s.site.id}`, { county: "Example County" });
    const f = (await filingOf(s, "attention"))!;
    const held = (await s.api.post(`/filings/${f.id}/recheck`, {})).json();
    expect(held).toMatchObject({ status: "needs_review", reviewReason: "Air pressure is required", answersToCorrect: [{ key: "air_pressure", label: "Air pressure", problem: "missing" }] });

    // The technician read it out by phone; the office enters it as a correction that says so.
    const corrected = await s.api.post(`/filings/${f.id}/correct`, { reason: "Air pressure 4.2 psi, read by the technician on site and given by phone", amendments: { air_pressure: 4.2 } });
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(corrected.json()).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("(version 2)"), answersToCorrect: [] });
    expect(corrected.json().reports.map((r: { version: number }) => r.version)).toEqual([2, 1]);
    expect(mail.delivered.size).toBe(0);

    await signAsProvider(s, insp.id);
    await runWorker(ctx);
    const sent = await detailOf(s, f.id);
    expect(sent.status).toBe("sent");
    const v2 = await ctx.db.selectFrom("reports").select("id").where("inspectionId", "=", insp.id).where("audience", "=", "authority").where("version", "=", 2).executeTakeFirstOrThrow();
    expect(sent.packages[0].documents.find((d: { role: string }) => d.role === "inspection_report").sourceId).toBe(v2.id);
  });

  it("holds a filing whose technician has no license number until it is fixed", async () => {
    mail.mode = "ok";
    const s = await countySetup(ctx, "Org A", { license: null });
    const insp = await complete(s);
    await runWorker(ctx);
    const f = (await filingOf(s, "attention"))!;
    expect(f).toMatchObject({ status: "needs_review", reviewReason: "The technician's license number is missing" });

    await ctx.db.updateTable("memberships").set({ technicianLicense: "MP-0001" }).where("userId", "=", s.tech.id).execute();
    expect((await s.api.post(`/filings/${f.id}/recheck`, {})).json()).toMatchObject({ status: "needs_review", reviewReason: expect.stringContaining("sign") });
    await signAsProvider(s, insp.id);
    expect((await detailOf(s, f.id)).status).toBe("queued");
    await runWorker(ctx);
    expect((await detailOf(s, f.id)).status).toBe("sent");
  });

  it("asks the office to pick an authority when none matches, then files with the one chosen", async () => {
    mail.mode = "ok";
    const s = await countySetup(ctx, "Org A", { county: "Nowhere County" });
    expect((await s.api.get(`/sites/${s.site.id}/jurisdiction`)).json()).toMatchObject({ source: "none", jurisdiction: null, candidates: [], reviewReason: expect.stringContaining("No reporting authority") });
    const insp = await complete(s, { ...completeValues(), air_pressure: 4 });
    await runWorker(ctx);
    const f = (await filingOf(s, "attention"))!;
    expect(f).toMatchObject({ status: "needs_review", jurisdiction: null, deadlineOn: null });
    expect((await s.api.post(`/filings/${f.id}/confirm`, { reference: "x" })).statusCode).toBe(409);

    const list = (await s.api.get("/jurisdictions")).json().items;
    expect(list.map((j: { key: string }) => j.key).sort()).toEqual(["tx-bastrop-county", "tx-bell-county-phd", "tx-bexar-county", "tx-brazoria-county", "tx-city-of-denton", "tx-collin-county", "tx-comal-county", "tx-denton-county", "tx-ellis-county", "tx-example-county", "tx-grimes-county", "tx-harris-county-oce", "tx-hays-county", "tx-hill-county", "tx-johnson-county", "tx-kaufman-county", "tx-lcra-ossf", "tx-mclennan-county", "tx-montgomery-county", "tx-sjra-ossf", "tx-travis-county", "tx-williamson-county"]);
    const example = list.find((j: { key: string }) => j.key === "tx-example-county");
    expect(example).toMatchObject({ rulesetVersion: 2, counties: ["Example County"], assignment: "county", profileStatus: "fictional" });
    // An office override has to say what it rests on.
    expect((await s.api.put(`/sites/${s.site.id}/jurisdiction`, { jurisdictionId: example.id })).statusCode).toBe(400);
    const set = await s.api.put(`/sites/${s.site.id}/jurisdiction`, { jurisdictionId: example.id, evidenceKind: "permit_record", evidenceReference: "Permit file 2019-114" });
    expect(set.json()).toMatchObject({ source: "override", jurisdiction: { key: "tx-example-county" } });

    expect((await s.api.post(`/filings/${f.id}/recheck`, {})).json()).toMatchObject({ status: "needs_review", deadlineOn: "2026-03-15", reviewReason: expect.stringContaining("sign") });
    await signAsProvider(s, insp.id);
    await runWorker(ctx);
    expect((await detailOf(s, f.id)).status).toBe("sent");
  });

  it("resolves by county name loosely, and refuses to guess between overlapping authorities", async () => {
    const catalog = await loadCatalog(ctx.db);
    const resolve = (county: string | null, state = "TX") => resolveSite(catalog, { county, state, jurisdictionId: null }, "2026-03-01")?.key ?? null;
    expect(resolve("Example County")).toBe("tx-example-county");
    expect(resolve("  example  ")).toBe("tx-example-county");
    expect(resolve("Example County", "OK")).toBeNull();
    expect(resolve(null)).toBeNull();
    expect(resolve("Sample County")).toBeNull();

    const twin = structuredClone(catalog.find((r) => r.jurisdiction.key === "tx-example-county")!);
    twin.jurisdiction.id = crypto.randomUUID();
    expect(resolveSite([...catalog, twin], { county: "Example County", state: "TX", jurisdictionId: null }, "2026-03-01")).toBeNull();
    // Rules that had not taken effect yet do not apply.
    expect(resolveSite(catalog, { county: "Example County", state: "TX", jurisdictionId: null }, "2019-12-31")).toBeNull();
  });
});

describe("rulesets", () => {
  it("never change once published", async () => {
    await expect(sql`update jurisdiction_rulesets set source_reference = 'x'`.execute(ctx.db)).rejects.toThrow(/immutable/);
    const [rules] = bundledRulesets();
    await syncRulesets(ctx.db, [rules!]);
    await expect(syncRulesets(ctx.db, [{ ...rules!, filing: { ...rules!.filing, deadlineDays: 30 } }])).rejects.toThrow(/changed after it was published/);
  });

  it("say whether they are fictional, drafts or verified", () => {
    for (const r of bundledRulesets()) {
      if (/FICTIONAL/.test(r.sourceReference)) expect(r.profile).toBeUndefined();
      else expect(r.profile?.status).toMatch(/^(draft|verified)$/);
    }
    // The real authorities are drafts with their open questions listed, so none files on its own.
    // Every version counts: a corrected draft adds one beside the one it replaces.
    const real = bundledRulesets().filter((r) => r.profile);
    expect([...new Set(real.map((r) => r.jurisdiction.key))].sort()).toEqual(["tx-bastrop-county", "tx-bell-county-phd", "tx-bexar-county", "tx-brazoria-county", "tx-city-of-denton", "tx-collin-county", "tx-comal-county", "tx-denton-county", "tx-ellis-county", "tx-grimes-county", "tx-harris-county-oce", "tx-hays-county", "tx-hill-county", "tx-johnson-county", "tx-kaufman-county", "tx-lcra-ossf", "tx-mclennan-county", "tx-montgomery-county", "tx-sjra-ossf", "tx-travis-county", "tx-williamson-county"]);
    for (const r of real) {
      expect(r.profile!.status).toBe("draft");
      expect(r.profile!.unresolved.length).toBeGreaterThan(0);
      expect(r.filing.autoSubmit).toBe(false);
    }
  });
});

describe("filing access", () => {
  it("keeps filings inside their organization", async () => {
    mail.mode = "ok";
    const a = await countySetup(ctx, "Org A");
    const b = await countySetup(ctx, "Org B");
    await complete(a);
    await runWorker(ctx);
    const f = (await filingOf(a))!;
    expect(await filingOf(b)).toBeUndefined();
    expect((await b.api.get(`/filings/${f.id}`)).statusCode).toBe(404);
    expect((await b.api.post(`/filings/${f.id}/confirm`, { reference: "x" })).statusCode).toBe(404);
    expect((await b.api.put(`/sites/${a.site.id}/jurisdiction`, { jurisdictionId: null })).statusCode).toBe(404);
    expect((await b.api.get(`/sites/${a.site.id}/jurisdiction`)).statusCode).toBe(404);
  });

  it("lets office staff act on filings, read-only users look, and technicians neither", async () => {
    mail.mode = "ok";
    const s = await countySetup(ctx);
    await signAndFile(s, (await complete(s)).id);
    const f = (await filingOf(s))!;
    const as = async (role: "office" | "read_only" | "technician") => client(ctx.app, await login(ctx.app, (await createUser(ctx.db, s.org.id, role)).email));
    const ro = await as("read_only");
    expect((await ro.get(`/filings/${f.id}`)).statusCode).toBe(200);
    expect((await ro.post(`/filings/${f.id}/confirm`, { reference: "x" })).statusCode).toBe(403);
    expect((await (await as("technician")).get("/filings")).statusCode).toBe(403);
    expect((await (await as("office")).post(`/filings/${f.id}/confirm`, { reference: "EC-1" })).statusCode).toBe(200);
  });
});

describe("startup", () => {
  it("loads the bundled rulesets idempotently", async () => {
    const app = await buildApp({ db: ctx.db, now: () => ctx.now, store: ctx.store });
    await app.close();
    const n = await ctx.db.selectFrom("jurisdictionRulesets").select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(bundledRulesets().length);
  });
});

describe("the fictional example authority in production", () => {
  it("is hidden from and refused for real companies, and kept for demo companies", async () => {
    // As the hosted demo runs: production, with demo companies and real trial companies in one database.
    const app = await buildApp({ db: ctx.db, production: true, fileSigningSecret: "fictional-guard", loginRateLimit: 1000, now: () => ctx.now, store: ctx.store });
    try {
      const example = (await loadCatalog(ctx.db)).find((e) => e.jurisdiction.key === "tx-example-county")!.jurisdiction;
      const company = async (name: string, demo: boolean) => {
        const org = demo ? await ctx.db.insertInto("organizations").values({ name, demo: true } as never).returning("id").executeTakeFirstOrThrow() : await createOrg(ctx.db, name);
        const owner = await createUser(ctx.db, org.id, "owner");
        const api = client(app, await login(app, owner.email));
        const customer = (await api.post("/customers", { displayName: `${name} customer` })).json();
        const site = (await api.post(`/customers/${customer.id}/sites`, { addressLine1: "1 Main St", city: "Austin" })).json();
        return { api, site };
      };
      const assign = (c: Awaited<ReturnType<typeof company>>) => c.api.put(`/sites/${c.site.id}/jurisdiction`, { jurisdictionId: example.id, evidenceKind: "permit_record", evidenceReference: "Permit file 2019-114" });

      const real = await company("Real Co", false);
      const keys = (await real.api.get("/jurisdictions")).json().items.map((j: { key: string }) => j.key);
      expect(keys).not.toContain("tx-example-county");
      expect(keys).toContain("tx-hays-county");
      const refused = await assign(real);
      expect(refused.statusCode).toBe(422);
      expect(refused.json().message).toMatch(/fictional/);

      const demo = await company("Demo Co (demo)", true);
      expect((await demo.api.get("/jurisdictions")).json().items.map((j: { key: string }) => j.key)).toContain("tx-example-county");
      expect((await assign(demo)).json()).toMatchObject({ source: "override", jurisdiction: { key: "tx-example-county" } });
    } finally {
      await app.close();
    }
  });
});
