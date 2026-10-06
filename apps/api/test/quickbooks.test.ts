import { TestCompanies, TestQuickBooksProvider, TokenCipher } from "@aerowise/quickbooks";
import { drainTasks } from "@aerowise/tasks";
import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp, type TestContext } from "./helpers.ts";

const ctx = setupTestApp();
const companies = () => new TestCompanies(ctx.db, () => ctx.now);
const runWorker = (c: TestContext) =>
  drainTasks({ db: c.db, store: c.store, now: () => c.now, appUrl: "https://app.example.test", quickbooks: { provider: new TestQuickBooksProvider(c.db, () => c.now), cipher: new TokenCipher() } });
const later = (minutes: number) => {
  ctx.now = new Date(ctx.now.getTime() + minutes * 60_000);
};

type Tenant = Awaited<ReturnType<typeof createTenant>>;

/**
 * Customers the test company will have near-copies of (see TestCompanies.seed): the
 * tenant's own "<org> customer" (same name only), Dana (as "Reyes, Dana", same phone),
 * Sam (twice) and Lee (misspelled). Nora is new to QuickBooks.
 */
async function customers(t: Tenant) {
  const add = async (displayName: string, email: string | null, phone: string | null) => {
    const c = (await t.api.post("/customers", { displayName, billingLine1: "1 Oak Ln", billingCity: "Austin", billingState: "TX", billingPostalCode: "78701" })).json();
    await t.api.post(`/customers/${c.id}/contacts`, { name: displayName, email, phone });
    return c as { id: string };
  };
  return {
    dana: await add("Dana Reyes", "dana@example.com", "(512) 555-0101"),
    sam: await add("Sam Ortiz", "sam@example.com", "(512) 555-0102"),
    lee: await add("Lee Chen", "lee@example.com", "(512) 555-0103"),
    nora: await add("Nora Quinn", "nora@example.com", "(512) 555-0104"),
  };
}

/** Connects the test company the way a browser would: start, then the callback. */
async function connect(t: Tenant) {
  const start = await t.api.post("/quickbooks/connect", {});
  expect(start.statusCode).toBe(200);
  const url = new URL(start.json().url);
  expect(url.pathname).toBe("/api/quickbooks/callback");
  const back = await t.api.get(`/quickbooks/callback${url.search}`);
  expect(back.statusCode).toBe(302);
  expect(back.headers.location).toBe("http://localhost:3000/quickbooks?connected=1");
  return url.searchParams.get("realmId")!;
}

/** Connected, reviewed with Aerowise's suggestions (ambiguous ones created), items mapped. */
async function synced(t: Tenant) {
  const cs = await customers(t);
  const realm = await connect(t);
  await t.api.post("/quickbooks/review/refresh", {});
  const items = (await t.api.get("/quickbooks/items")).json() as { id: string; name: string }[];
  const services = items.find((i) => i.name === "Services")!;
  expect((await t.api.put("/quickbooks/mapping", { defaultItemId: services.id })).statusCode).toBe(200);
  for (const id of [t.customer.id, cs.sam.id, cs.lee.id]) expect((await t.api.put(`/quickbooks/review/${id}`, { decision: "skip" })).statusCode).toBe(204);
  expect((await t.api.post("/quickbooks/review/commit", {})).statusCode).toBe(200);
  await runWorker(ctx);
  return { cs, realm, items };
}

async function issue(t: Tenant, customerId: string, lines: object[] = [{ description: "Aerator repair", quantity: 1, unitPriceCents: 30000 }]) {
  const draft = (await t.api.post("/invoices", { customerId, lines })).json();
  const res = await t.api.post(`/invoices/${draft.id}/issue`, { send: false });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; number: number; totalCents: number };
}

const link = (type: string, entityId: string) => ctx.db.selectFrom("quickbooksLinks").selectAll().where("entityType", "=", type as never).where("entityId", "=", entityId).executeTakeFirst();

describe("connecting", () => {
  it("connects the owner's company with encrypted tokens and starts in review", async () => {
    const t = await createTenant(ctx, "Org A");
    expect((await t.api.get("/quickbooks")).json()).toMatchObject({ provider: "test", connection: null });
    await connect(t);
    const s = (await t.api.get("/quickbooks")).json();
    expect(s.connection).toMatchObject({ environment: "test", status: "connected", setupState: "review", companyName: "Org A (test company)", syncFrom: "2026-03-01" });
    const row = await ctx.db.selectFrom("quickbooksConnections").selectAll().executeTakeFirstOrThrow();
    expect(row.accessTokenEnc).toMatch(/^v1\./);
    expect(row.accessTokenEnc).not.toContain("qbt_");
    expect(new TokenCipher().decrypt(row.refreshTokenEnc!)).toMatch(/^qbt_refresh_/);
  });

  it("refuses a callback that someone else started, or that was tampered with", async () => {
    const t = await createTenant(ctx, "Org A");
    const url = new URL((await t.api.post("/quickbooks/connect", {})).json().url);
    const other = await createUser(ctx.db, t.org.id, "owner");
    const otherApi = client(ctx.app, await login(ctx.app, other.email));
    expect((await otherApi.get(`/quickbooks/callback${url.search}`)).headers.location).toBe("http://localhost:3000/quickbooks?error=state");
    const [payload, mac] = url.searchParams.get("state")!.split(".");
    url.searchParams.set("state", `${payload}.${mac!.startsWith("A") ? "B" : "A"}${mac!.slice(1)}`);
    expect((await t.api.get(`/quickbooks/callback${url.search}`)).headers.location).toBe("http://localhost:3000/quickbooks?error=state");
    expect((await t.api.get("/quickbooks")).json().connection).toBeNull();
  });

  it("lets only the owner connect, and office staff work the sync", async () => {
    const t = await createTenant(ctx, "Org A");
    const office = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, t.org.id, "office")).email));
    const readOnly = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, t.org.id, "read_only")).email));
    const tech = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, t.org.id, "technician")).email));
    expect((await office.post("/quickbooks/connect", {})).statusCode).toBe(403);
    expect((await tech.get("/quickbooks")).statusCode).toBe(403);
    await connect(t);
    expect((await office.post("/quickbooks/review/refresh", {})).statusCode).toBe(200);
    expect((await readOnly.get("/quickbooks/review")).statusCode).toBe(200);
    expect((await readOnly.post("/quickbooks/review/commit", {})).statusCode).toBe(403);
  });
});

describe("first sync", () => {
  it("links exact matches, asks about ambiguous ones, and creates the rest", async () => {
    const t = await createTenant(ctx, "Org A");
    const cs = await customers(t);
    await connect(t);
    const review = (await t.api.post("/quickbooks/review/refresh", {})).json();
    const row = (id: string) => review.rows.find((r: { customer: { id: string } }) => r.customer.id === id);
    expect(row(cs.dana.id)).toMatchObject({ found: "exact", decision: "match", match: { name: "Reyes, Dana", reasons: ["same_name", "same_phone"] } });
    expect(row(t.customer.id)).toMatchObject({ found: "review", decision: null, candidates: [{ name: "Org A customer", reasons: ["same_name"] }] });
    expect(row(cs.sam.id)).toMatchObject({ found: "review", decision: null });
    expect(row(cs.sam.id).candidates).toHaveLength(2);
    expect(row(cs.lee.id)).toMatchObject({ found: "review", candidates: [{ name: "Lee Chenn", reasons: ["similar_name"] }] });
    expect(row(cs.nora.id)).toMatchObject({ found: "none", decision: "create" });
    expect(review.remoteCustomers).toBe(7);
    expect(review.counts).toEqual({ exact: 1, review: 3, none: 1, undecided: 3 });
    // Possible matches come first.
    expect(review.rows[0].found).toBe("review");

    const pick = row(cs.sam.id).candidates[0].id;
    expect((await t.api.put(`/quickbooks/review/${cs.sam.id}`, { decision: "match", externalId: pick })).statusCode).toBe(204);
    // One QuickBooks customer is one Aerowise customer, and only offered ones can be picked.
    expect((await t.api.put(`/quickbooks/review/${cs.nora.id}`, { decision: "match", externalId: pick })).statusCode).toBe(422);
    expect((await t.api.put(`/quickbooks/review/${cs.lee.id}`, { decision: "match", externalId: pick })).statusCode).toBe(422);
    expect((await t.api.put(`/quickbooks/review/${cs.lee.id}`, { decision: "skip" })).statusCode).toBe(204);
    // A refresh keeps what a person chose.
    const again = (await t.api.post("/quickbooks/review/refresh", {})).json();
    expect(again.rows.find((r: { customer: { id: string } }) => r.customer.id === cs.sam.id)).toMatchObject({ decision: "match", match: { id: pick } });

    const counts = (await t.api.post("/quickbooks/review/commit", {})).json();
    expect(counts).toEqual({ matched: 2, create: 1, skipped: 1, undecided: 1 });
    expect((await t.api.post("/quickbooks/review/commit", {})).statusCode).toBe(422);
    await runWorker(ctx);

    const company = await companies().get((await ctx.db.selectFrom("quickbooksConnections").select("realmId").executeTakeFirstOrThrow()).realmId);
    // Only Nora was new: matched customers are not added again and keep their QuickBooks details.
    expect(Object.values(company.customers).map((c) => c.name).sort()).toEqual(["Hill Country Realty", "Lakeway HOA", "Lee Chenn", "Nora Quinn", "Org A customer", "Reyes, Dana", "Sam Ortiz", "Sam Ortiz"]);
    expect(await link("customer", cs.nora.id)).toMatchObject({ status: "synced" });
    expect(await link("customer", cs.lee.id)).toMatchObject({ status: "ignored" });
    const attention = (await t.api.get("/quickbooks/records")).json();
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ entityType: "customer", label: "Org A customer", status: "conflict", conflictKind: "ambiguous_match", actions: ["match", "create", "ignore"] });
  });
});

describe("sending invoices and payments", () => {
  it("sends an issued invoice and its payment once, with the customer first", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const inv = await issue(t, cs.nora.id);
    const pay = await t.api.post(`/invoices/${inv.id}/payments`, { amountCents: 10000, method: "check", reference: "1042", receivedOn: "2026-03-01" });
    expect(pay.statusCode).toBe(200);
    await runWorker(ctx);
    await runWorker(ctx);
    const company = await companies().get(realm);
    const sent = Object.values(company.invoices);
    expect(sent).toHaveLength(1);
    const custLink = await link("customer", cs.nora.id);
    expect(sent[0]).toMatchObject({ docNumber: "INV-1001", customerId: custLink!.externalId, totalCents: 30000, balanceCents: 20000 });
    expect(Object.values(company.payments)).toEqual([expect.objectContaining({ amountCents: 10000, invoiceId: sent[0]!.id, txnDate: "2026-03-01" })]);
    expect(await link("invoice", inv.id)).toMatchObject({ status: "synced", remoteState: "open" });
    const s = (await t.api.get("/quickbooks")).json();
    expect(s.counts.invoice).toEqual({ synced: 1 });
    expect(s.counts.payment).toEqual({ synced: 1 });
    expect(s.connection.lastSyncError).toBeNull();
  });

  it("lowers a refunded payment in QuickBooks, and deletes it once nothing is kept", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const inv = await issue(t, cs.nora.id);
    const paid = (await t.api.post(`/invoices/${inv.id}/payments`, { amountCents: 10000, method: "check", reference: "1042", receivedOn: "2026-03-01" })).json();
    await runWorker(ctx);
    const remoteInvoice = async () => Object.values((await companies().get(realm)).invoices)[0]!;
    expect((await remoteInvoice()).balanceCents).toBe(20000);

    // A partial refund: QuickBooks keeps the payment at what the customer kept paying.
    expect((await t.api.post(`/payments/${paid.payments[0].id}/refund`, { amountCents: 200, reason: "Overcharged" })).statusCode).toBe(200);
    await runWorker(ctx);
    expect(Object.values((await companies().get(realm)).payments)).toEqual([expect.objectContaining({ amountCents: 9800 })]);
    expect((await remoteInvoice()).balanceCents).toBe(20200);
    expect((await t.api.get(`/invoices/${inv.id}`)).json()).toMatchObject({ paidCents: 9800 });
    expect(await link("payment", paid.payments[0].id)).toMatchObject({ status: "synced", pushedHash: "9800" });

    // Nothing more to send until the next refund.
    await runWorker(ctx);
    expect(Object.values((await companies().get(realm)).payments)).toHaveLength(1);

    // The rest refunded: the payment comes off the QuickBooks invoice entirely.
    expect((await t.api.post(`/payments/${paid.payments[0].id}/refund`, { amountCents: 9800, reason: "Job cancelled" })).statusCode).toBe(200);
    await runWorker(ctx);
    expect(Object.values((await companies().get(realm)).payments)).toHaveLength(0);
    expect((await remoteInvoice()).balanceCents).toBe(30000);
    expect(await link("payment", paid.payments[0].id)).toMatchObject({ status: "synced", remoteState: "deleted" });
  });

  it("sends a payment refunded before it reached QuickBooks at what was kept, or not at all", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const a = await issue(t, cs.nora.id);
    const b = await issue(t, cs.dana.id);
    const pa = (await t.api.post(`/invoices/${a.id}/payments`, { amountCents: 10000, method: "cash", receivedOn: "2026-03-01" })).json();
    const pb = (await t.api.post(`/invoices/${b.id}/payments`, { amountCents: 5000, method: "cash", receivedOn: "2026-03-01" })).json();
    await t.api.post(`/payments/${pa.payments[0].id}/refund`, { amountCents: 2500, reason: "Overcharged" });
    await t.api.post(`/payments/${pb.payments[0].id}/refund`, { amountCents: 5000, reason: "Paid twice" });
    await runWorker(ctx);
    await runWorker(ctx);
    expect(Object.values((await companies().get(realm)).payments)).toEqual([expect.objectContaining({ amountCents: 7500 })]);
    expect(await link("payment", pb.payments[0].id)).toMatchObject({ status: "ignored", syncError: "Refunded in full before it reached QuickBooks" });
  });

  it("voids in QuickBooks what was voided here", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const inv = await issue(t, cs.nora.id);
    await runWorker(ctx);
    expect((await t.api.post(`/invoices/${inv.id}/void`, { reason: "Wrong customer" })).statusCode).toBe(200);
    await runWorker(ctx);
    const remote = Object.values((await companies().get(realm)).invoices)[0]!;
    expect(remote).toMatchObject({ voided: true, totalCents: 0 });
    expect(await link("invoice", inv.id)).toMatchObject({ status: "synced", remoteState: "void" });
  });

  it("does not send invoices issued before the sync start date", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs } = await synced(t);
    await t.api.put("/quickbooks/mapping", { syncFrom: "2026-03-05" });
    const inv = await issue(t, cs.nora.id);
    await runWorker(ctx);
    expect(await link("invoice", inv.id)).toBeUndefined();
  });

  it("asks before linking a new customer that QuickBooks may already have", async () => {
    const t = await createTenant(ctx, "Org A");
    const { realm } = await synced(t);
    const smith = (await t.api.post("/customers", { displayName: "Hill Country Realty LLC" })).json();
    const inv = await issue(t, smith.id);
    await runWorker(ctx);
    const rec = (await t.api.get("/quickbooks/records")).json().find((r: { entityId: string }) => r.entityId === smith.id);
    expect(rec).toMatchObject({ conflictKind: "ambiguous_match", candidates: [{ name: "Hill Country Realty", reasons: ["similar_name"] }] });
    expect(await link("invoice", inv.id)).toMatchObject({ status: "queued", syncError: "Waiting for the customer to reach QuickBooks" });
    // Not in the conflict center: it is waiting, not stuck.
    expect((await t.api.get("/quickbooks/records")).json().some((r: { entityId: string }) => r.entityId === inv.id)).toBe(false);

    const res = await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "match", externalId: rec.candidates[0].id });
    expect(res.json()).toMatchObject({ status: "synced", externalId: rec.candidates[0].id });
    await runWorker(ctx);
    const company = await companies().get(realm);
    expect(Object.values(company.invoices)[0]).toMatchObject({ customerId: rec.candidates[0].id });
    expect(Object.values(company.customers).filter((c) => c.name.startsWith("Hill Country"))).toHaveLength(1);
  });

  it("creates a customer with a clashing name only when told to", async () => {
    const t = await createTenant(ctx, "Org A");
    const { realm } = await synced(t);
    const lakeway = (await t.api.post("/customers", { displayName: "Lakeway HOA" })).json();
    await issue(t, lakeway.id);
    await runWorker(ctx);
    const rec = (await t.api.get("/quickbooks/records")).json()[0];
    expect(rec).toMatchObject({ entityId: lakeway.id, conflictKind: "ambiguous_match" });
    await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "create" });
    await runWorker(ctx);
    const names = Object.values((await companies().get(realm)).customers).map((c) => c.name);
    expect(names.filter((n) => n.startsWith("Lakeway HOA"))).toEqual(["Lakeway HOA", "Lakeway HOA (2)"]);
  });
});

describe("conflicts and retries", () => {
  it("stops on a deleted QuickBooks item until it is mapped again", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm, items } = await synced(t);
    const services = items.find((i) => i.name === "Services")!;
    await companies().setItemActive(realm, services.id, false);
    const inv = await issue(t, cs.nora.id);
    await runWorker(ctx);
    const rec = (await t.api.get("/quickbooks/records")).json()[0];
    expect(rec).toMatchObject({ entityId: inv.id, label: "INV-1001", conflictKind: "item_missing", title: "QuickBooks item missing", details: { reason: "inactive", itemName: "Services" } });
    // A mapping change puts waiting invoices back in line.
    const repair = items.find((i) => i.name === "Septic repair")!;
    expect((await t.api.put("/quickbooks/mapping", { defaultItemId: services.id })).statusCode).toBe(422);
    expect((await t.api.put("/quickbooks/mapping", { defaultItemId: repair.id })).statusCode).toBe(200);
    await runWorker(ctx);
    expect(await link("invoice", inv.id)).toMatchObject({ status: "synced" });
    expect(Object.values((await companies().get(realm)).invoices)[0]!.lines[0]).toMatchObject({ itemId: repair.id });
  });

  it("retries temporary failures on a schedule, then hands them to a person", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const inv = await issue(t, cs.nora.id);
    // QuickBooks refuses the next change.
    await companies().failNext(realm, 1);
    await runWorker(ctx);
    const failed = await link("invoice", inv.id);
    expect(failed).toMatchObject({ status: "failed", retryCount: 1, syncError: "QuickBooks is busy or unavailable (503)" });
    expect(failed!.nextAttemptAt).toEqual(new Date(ctx.now.getTime() + 60_000));
    expect((await t.api.get("/quickbooks/records")).json()).toHaveLength(0);
    later(2);
    await t.api.post("/quickbooks/sync", {});
    await runWorker(ctx);
    expect(await link("invoice", inv.id)).toMatchObject({ status: "synced", retryCount: 0 });
  });

  it("shows a failure QuickBooks will not accept, and retries it on request", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    await companies().failNext(realm, 1, "validation");
    const inv = await issue(t, cs.nora.id);
    await runWorker(ctx);
    const rec = (await t.api.get("/quickbooks/records")).json()[0];
    expect(rec).toMatchObject({ entityId: inv.id, status: "failed", nextAttemptAt: null, title: "Could not send to QuickBooks", actions: ["retry", "ignore"] });
    expect(rec.syncError).toMatch(/closed period/);
    await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "retry" });
    await runWorker(ctx);
    expect(await link("invoice", inv.id)).toMatchObject({ status: "synced" });
  });

  it("flags a customer made inactive in QuickBooks", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const custLink = (await link("customer", cs.nora.id))!;
    later(1);
    await companies().editCustomer(realm, custLink.externalId!, { active: false });
    await t.api.post("/quickbooks/sync", {});
    await runWorker(ctx);
    expect((await t.api.get("/quickbooks/records")).json()[0]).toMatchObject({ entityId: cs.nora.id, conflictKind: "deleted_in_quickbooks", title: "Deleted or made inactive in QuickBooks" });
  });

  it("asks which version wins when a customer changed in both places", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const custLink = (await link("customer", cs.nora.id))!;
    later(1);
    await companies().editCustomer(realm, custLink.externalId!, { phone: "(512) 555-9999" });
    await t.api.patch(`/customers/${cs.nora.id}`, { displayName: "Nora Quinn-Baker" });
    await t.api.post("/quickbooks/sync", {});
    await runWorker(ctx);
    const rec = (await t.api.get("/quickbooks/records")).json()[0];
    expect(rec).toMatchObject({ entityId: cs.nora.id, conflictKind: "changed_in_both", actions: ["keep_quickbooks", "use_aerowise"] });
    expect(rec.details.fields).toEqual([
      { field: "Name", aerowise: "Nora Quinn-Baker", quickbooks: "Nora Quinn" },
      { field: "Phone", aerowise: "(512) 555-0104", quickbooks: "(512) 555-9999" },
    ]);
    await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "use_aerowise" });
    later(1);
    await runWorker(ctx);
    expect((await companies().get(realm)).customers[custLink.externalId!]).toMatchObject({ name: "Nora Quinn-Baker", phone: "(512) 555-0104" });
    expect(await link("customer", cs.nora.id)).toMatchObject({ status: "synced", force: false });
  });

  it("takes a QuickBooks-only edit as the new starting point without asking", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const custLink = (await link("customer", cs.nora.id))!;
    later(1);
    await companies().editCustomer(realm, custLink.externalId!, { email: "nq@example.com" });
    await t.api.post("/quickbooks/sync", {});
    await runWorker(ctx);
    expect(await link("customer", cs.nora.id)).toMatchObject({ status: "synced", syncToken: "1" });
    expect((await companies().get(realm)).customers[custLink.externalId!]!.email).toBe("nq@example.com");
  });

  it("notices an invoice deleted in QuickBooks and sends it again only if asked", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const inv = await issue(t, cs.nora.id);
    await runWorker(ctx);
    const first = (await link("invoice", inv.id))!;
    later(1);
    await companies().deleteInvoice(realm, first.externalId!);
    await t.api.post("/quickbooks/sync", {});
    await runWorker(ctx);
    const rec = (await t.api.get("/quickbooks/records")).json()[0];
    expect(rec).toMatchObject({ entityId: inv.id, conflictKind: "deleted_in_quickbooks", actions: ["ignore", "recreate"] });
    await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "recreate" });
    await runWorker(ctx);
    const again = (await link("invoice", inv.id))!;
    expect(again).toMatchObject({ status: "synced", generation: 2 });
    expect(again.externalId).not.toBe(first.externalId);
    expect(Object.keys((await companies().get(realm)).invoices)).toEqual([again.externalId]);
  });

  it("holds a payment QuickBooks may already have", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const inv = await issue(t, cs.nora.id);
    await runWorker(ctx);
    await companies().payInvoice(realm, (await link("invoice", inv.id))!.externalId!, 30000);
    await t.api.post(`/invoices/${inv.id}/payments`, { amountCents: 30000, method: "cash", receivedOn: "2026-03-01" });
    await runWorker(ctx);
    const rec = (await t.api.get("/quickbooks/records")).json()[0];
    expect(rec).toMatchObject({ entityType: "payment", label: "$300.00 on INV-1001", conflictKind: "payment_mismatch", details: { paymentCents: 30000, balanceCents: 0 } });
    await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "ignore" });
    expect((await t.api.get("/quickbooks/records")).json()).toHaveLength(0);
    expect(Object.values((await companies().get(realm)).payments)).toHaveLength(0);
  });

  it("does not send sales tax it cannot map", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs } = await synced(t);
    await t.api.patch("/billing/settings", { defaultTaxRateBps: 825 });
    await issue(t, cs.nora.id, [{ description: "Chlorine", quantity: 2, unitPriceCents: 1250, taxable: true }]);
    await runWorker(ctx);
    expect((await t.api.get("/quickbooks/records")).json()[0]).toMatchObject({ conflictKind: "tax_mapping_missing", actions: ["ignore"], details: { taxCents: 206 } });
  });

  it("puts records that need a person in the inbox", async () => {
    const t = await createTenant(ctx, "Org A");
    await synced(t);
    const inbox = (await t.api.get("/inbox")).json();
    expect(inbox.quickbooks).toEqual({ status: "connected", setupState: "active", attention: 0 });
    const lakeway = (await t.api.post("/customers", { displayName: "Lakeway HOA" })).json();
    await issue(t, lakeway.id);
    await runWorker(ctx);
    const after = (await t.api.get("/inbox")).json();
    expect(after.quickbooks.attention).toBe(1);
    expect(after.items.find((e: { kind: string }) => e.kind === "quickbooks_conflict")).toMatchObject({ title: "QuickBooks: Possible match in QuickBooks", customer: { id: lakeway.id }, target: { type: "quickbooks" } });
  });

  it("marks the connection for reconnecting when QuickBooks stops accepting it", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs } = await synced(t);
    await ctx.db.updateTable("quickbooksConnections").set({ refreshTokenEnc: new TokenCipher().encrypt("revoked"), accessExpiresAt: ctx.now }).execute();
    const inv = await issue(t, cs.nora.id);
    await runWorker(ctx);
    const s = (await t.api.get("/quickbooks")).json();
    expect(s.connection).toMatchObject({ status: "needs_reauth" });
    expect(s.connection.lastSyncError).toMatch(/not valid/);
    // Reconnecting the same company keeps every link, and the invoice goes out.
    await connect(t);
    expect((await t.api.get("/quickbooks")).json().connection).toMatchObject({ status: "connected", setupState: "active" });
    await t.api.post("/quickbooks/sync", {});
    await runWorker(ctx);
    expect(await link("invoice", inv.id)).toMatchObject({ status: "synced" });
    expect(await link("customer", cs.dana.id)).toMatchObject({ status: "synced" });
  });
});

describe("tenancy", () => {
  it("keeps sync records to their organization", async () => {
    const a = await createTenant(ctx, "Org A");
    await synced(a);
    const lakeway = (await a.api.post("/customers", { displayName: "Lakeway HOA" })).json();
    await issue(a, lakeway.id);
    await runWorker(ctx);
    const rec = (await a.api.get("/quickbooks/records")).json()[0];
    const b = await createTenant(ctx, "Org B");
    expect((await b.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "ignore" })).statusCode).toBe(404);
    expect((await b.api.get("/quickbooks/records")).json()).toEqual([]);
    expect((await b.api.get("/quickbooks")).json().connection).toBeNull();
  });
});
