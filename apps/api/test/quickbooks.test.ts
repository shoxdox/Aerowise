import { recheckInvoice, resolveLink, TestCompanies, TestQuickBooksProvider, TokenCipher, type QuickBooksCompany } from "@aerowise/quickbooks";
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

  it("sends an ordinary refund as a Refund Receipt once its item and account are chosen, leaving the payment alone", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm, items } = await synced(t);
    const inv = await issue(t, cs.nora.id);
    const paid = (await t.api.post(`/invoices/${inv.id}/payments`, { amountCents: 10000, method: "check", reference: "1042", receivedOn: "2026-03-01" })).json();
    await runWorker(ctx);
    const refunded = (await t.api.post(`/payments/${paid.payments[0].id}/refund`, { amountCents: 200, reason: "Overcharged" })).json();
    expect(refunded).toMatchObject({ paidCents: 9800, creditedCents: 200, amountDueCents: 20000 });
    const refundId = refunded.payments[0].refunds[0].id as string;

    // Nothing is assumed about the company's books: it waits for the refund item and account.
    await runWorker(ctx);
    expect(await link("refund", refundId)).toMatchObject({ status: "queued", syncError: "Choose the refund item on the QuickBooks page" });
    const accounts = (await t.api.get("/quickbooks/accounts")).json() as { id: string; name: string }[];
    const checking = accounts.find((a) => a.name === "Checking")!;
    const clearing = accounts.find((a) => a.name === "Stripe Clearing")!;
    const services = items.find((i) => i.name === "Services")!;
    expect((await t.api.put("/quickbooks/mapping", { refundItemId: services.id, stripeRefundAccountId: clearing.id })).statusCode).toBe(200);
    await runWorker(ctx);
    expect(await link("refund", refundId)).toMatchObject({ status: "queued", syncError: "Choose the account check and cash refunds are paid from on the QuickBooks page" });
    const mapped = (await t.api.put("/quickbooks/mapping", { manualRefundAccountId: checking.id })).json();
    expect(mapped).toMatchObject({ refundItem: { id: services.id, name: "Services" }, stripeRefundAccount: { name: "Stripe Clearing" }, manualRefundAccount: { name: "Checking" } });
    expect((await t.api.put("/quickbooks/mapping", { manualRefundAccountId: services.id })).statusCode).toBe(422);
    await runWorker(ctx);

    const company = await companies().get(realm);
    const custLink = await link("customer", cs.nora.id);
    expect(Object.values(company.refundReceipts ?? {})).toEqual([
      expect.objectContaining({
        customerId: custLink!.externalId,
        itemId: services.id,
        accountId: checking.id,
        amountCents: 200,
        paymentType: "Check",
        reference: "1042",
        description: "Refund on INV-1001: Overcharged",
      }),
    ]);
    // The payment and the invoice's balance stay as they were.
    expect(Object.values(company.payments)).toEqual([expect.objectContaining({ amountCents: 10000 })]);
    expect(Object.values(company.invoices)[0]!.balanceCents).toBe(20000);
    expect(await link("refund", refundId)).toMatchObject({ status: "synced" });
    expect(await link("payment", paid.payments[0].id)).toMatchObject({ status: "synced" });
    expect((await t.api.get("/quickbooks/records?view=all&entityType=refund")).json().map((r: { label: string }) => r.label)).toContain("Refund of $2.00 on INV-1001");

    // Later runs don't send it again.
    await runWorker(ctx);
    expect(Object.values((await companies().get(realm)).refundReceipts ?? {})).toHaveLength(1);
  });

  it("sends a Stripe refund from the Stripe account, and a payment refunded before it was sent at its full amount", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm, items } = await synced(t);
    const accounts = (await t.api.get("/quickbooks/accounts")).json() as { id: string; name: string }[];
    const clearing = accounts.find((a) => a.name === "Stripe Clearing")!;
    const services = items.find((i) => i.name === "Services")!;
    await t.api.put("/quickbooks/mapping", { refundItemId: services.id, stripeRefundAccountId: clearing.id });
    const inv = await issue(t, cs.nora.id);
    // A card payment taken online and part-refunded in Stripe's dashboard, both before the next sync.
    const pay = await ctx.db
      .insertInto("payments")
      .values({ organizationId: t.org.id, invoiceId: inv.id, amountCents: 10000, method: "card", source: "stripe", status: "succeeded", providerPaymentId: "pi_test_qb", succeededAt: ctx.now, createdAt: ctx.now, updatedAt: ctx.now })
      .returning("id")
      .executeTakeFirstOrThrow();
    const refund = await ctx.db
      .insertInto("refunds")
      .values({ organizationId: t.org.id, paymentId: pay.id, amountCents: 300, status: "succeeded", providerRefundId: "re_test_qb", reason: "Refunded in Stripe", createdAt: ctx.now, updatedAt: ctx.now })
      .returning("id")
      .executeTakeFirstOrThrow();
    await runWorker(ctx);
    await runWorker(ctx);
    const company = await companies().get(realm);
    expect(Object.values(company.payments)).toEqual([expect.objectContaining({ amountCents: 10000 })]);
    expect(Object.values(company.refundReceipts ?? {})).toEqual([
      expect.objectContaining({ accountId: clearing.id, amountCents: 300, paymentType: "CreditCard", reference: "re_test_qb", privateNote: "Aerowise refund on INV-1001 (Stripe re_test_qb, payment pi_test_qb)" }),
    ]);
    expect(await link("refund", refund.id)).toMatchObject({ status: "synced" });
  });

  it("lowers a payment reversed by a refund in QuickBooks, and deletes it once nothing is kept", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const inv = await issue(t, cs.nora.id);
    const paid = (await t.api.post(`/invoices/${inv.id}/payments`, { amountCents: 10000, method: "check", reference: "1042", receivedOn: "2026-03-01" })).json();
    await runWorker(ctx);
    const remoteInvoice = async () => Object.values((await companies().get(realm)).invoices)[0]!;
    expect((await remoteInvoice()).balanceCents).toBe(20000);

    // Part of the payment reversed: QuickBooks keeps the payment at what the customer kept paying.
    expect((await t.api.post(`/payments/${paid.payments[0].id}/refund`, { amountCents: 200, reason: "Overcharged", intent: "reverse" })).statusCode).toBe(200);
    await runWorker(ctx);
    expect(Object.values((await companies().get(realm)).payments)).toEqual([expect.objectContaining({ amountCents: 9800 })]);
    expect((await remoteInvoice()).balanceCents).toBe(20200);
    expect((await t.api.get(`/invoices/${inv.id}`)).json()).toMatchObject({ paidCents: 9800 });
    expect(await link("payment", paid.payments[0].id)).toMatchObject({ status: "synced", pushedHash: "9800" });

    // Nothing more to send until the next refund.
    await runWorker(ctx);
    expect(Object.values((await companies().get(realm)).payments)).toHaveLength(1);

    // The rest reversed: the payment comes off the QuickBooks invoice entirely.
    expect((await t.api.post(`/payments/${paid.payments[0].id}/refund`, { amountCents: 9800, reason: "Job cancelled", intent: "reverse" })).statusCode).toBe(200);
    await runWorker(ctx);
    expect(Object.values((await companies().get(realm)).payments)).toHaveLength(0);
    expect((await remoteInvoice()).balanceCents).toBe(30000);
    expect(await link("payment", paid.payments[0].id)).toMatchObject({ status: "synced", remoteState: "deleted" });
  });

  it("asks before reversing a payment that was deleted in QuickBooks", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const inv = await issue(t, cs.nora.id);
    const paid = (await t.api.post(`/invoices/${inv.id}/payments`, { amountCents: 10000, method: "check", receivedOn: "2026-03-01" })).json();
    await runWorker(ctx);
    const sent = (await link("payment", paid.payments[0].id))!;
    await new TestQuickBooksProvider(ctx.db, () => ctx.now).company(realm).deletePayment(sent.externalId!, sent.syncToken!);
    await t.api.post(`/payments/${paid.payments[0].id}/refund`, { amountCents: 200, reason: "Overcharged", intent: "reverse" });
    await runWorker(ctx);
    expect(await link("payment", paid.payments[0].id)).toMatchObject({ status: "conflict", conflictKind: "deleted_in_quickbooks" });
    expect(Object.values((await companies().get(realm)).payments)).toHaveLength(0);
    expect(Object.values((await companies().get(realm)).invoices)[0]!.balanceCents).toBe(30000);
  });

  it("asks before reversing a payment someone changed in QuickBooks, and keeps their version if told to", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const inv = await issue(t, cs.nora.id);
    const paid = (await t.api.post(`/invoices/${inv.id}/payments`, { amountCents: 10000, method: "check", receivedOn: "2026-03-01" })).json();
    await runWorker(ctx);
    const paymentId = paid.payments[0].id as string;
    const sent = (await link("payment", paymentId))!;
    // The bookkeeper changes the amount in QuickBooks, then the office reverses $2 of it in Aerowise.
    await companies().editPayment(realm, sent.externalId!, { amountCents: 9500 });
    await t.api.post(`/payments/${paymentId}/refund`, { amountCents: 200, reason: "Overcharged", intent: "reverse" });
    await runWorker(ctx);
    const rec = (await t.api.get("/quickbooks/records")).json()[0];
    expect(rec).toMatchObject({ entityType: "payment", conflictKind: "changed_in_both", actions: ["keep_quickbooks", "use_aerowise"] });
    expect(rec.details.fields).toEqual([
      { field: "Amount", aerowise: "$98.00 ($100.00 less $2.00 reversed by refund)", quickbooks: "$95.00" },
      { field: "Applied to", aerowise: "$98.00 to INV-1001", quickbooks: "$95.00 to INV-1001" },
    ]);
    expect(Object.values((await companies().get(realm)).payments)).toEqual([expect.objectContaining({ amountCents: 9500 })]);

    // Keeping the QuickBooks version leaves it alone, and later syncs don't send it again.
    expect((await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "keep_quickbooks" })).statusCode).toBe(200);
    await runWorker(ctx);
    expect(await link("payment", paymentId)).toMatchObject({ status: "synced" });
    expect(Object.values((await companies().get(realm)).payments)).toEqual([expect.objectContaining({ amountCents: 9500 })]);

    // The next reversal asks again, since QuickBooks still has their version.
    await t.api.post(`/payments/${paymentId}/refund`, { amountCents: 800, reason: "Discount", intent: "reverse" });
    await runWorker(ctx);
    expect(await link("payment", paymentId)).toMatchObject({ status: "conflict", conflictKind: "changed_in_both" });
  });

  it("asks before reversing a payment moved to another invoice in QuickBooks, and sends the Aerowise version if told to", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const a = await issue(t, cs.nora.id);
    await issue(t, cs.nora.id);
    const paid = (await t.api.post(`/invoices/${a.id}/payments`, { amountCents: 10000, method: "check", receivedOn: "2026-03-01" })).json();
    await runWorker(ctx);
    await runWorker(ctx);
    const paymentId = paid.payments[0].id as string;
    const sent = (await link("payment", paymentId))!;
    const invA = (await link("invoice", a.id))!.externalId!;
    const invB = Object.keys((await companies().get(realm)).invoices).find((id) => id !== invA)!;
    await companies().editPayment(realm, sent.externalId!, { invoiceId: invB });
    await t.api.post(`/payments/${paymentId}/refund`, { amountCents: 200, reason: "Overcharged", intent: "reverse" });
    await runWorker(ctx);
    const rec = (await t.api.get("/quickbooks/records")).json()[0];
    expect(rec.details.fields[1]).toEqual({ field: "Applied to", aerowise: "$98.00 to INV-1001", quickbooks: `$100.00 to another invoice (QuickBooks id ${invB})` });

    expect((await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "use_aerowise" })).statusCode).toBe(200);
    await runWorker(ctx);
    const company = await companies().get(realm);
    expect(Object.values(company.payments)).toEqual([expect.objectContaining({ amountCents: 9800, invoiceId: invA })]);
    expect(company.invoices[invA]!.balanceCents).toBe(20200);
    expect(company.invoices[invB]!.balanceCents).toBe(30000);
    expect(await link("payment", paymentId)).toMatchObject({ status: "synced", pushedHash: "9800" });
  });

  it("sends a payment reversed before it reached QuickBooks at what was kept, or not at all", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await synced(t);
    const a = await issue(t, cs.nora.id);
    const b = await issue(t, cs.dana.id);
    const pa = (await t.api.post(`/invoices/${a.id}/payments`, { amountCents: 10000, method: "cash", receivedOn: "2026-03-01" })).json();
    const pb = (await t.api.post(`/invoices/${b.id}/payments`, { amountCents: 5000, method: "cash", receivedOn: "2026-03-01" })).json();
    await t.api.post(`/payments/${pa.payments[0].id}/refund`, { amountCents: 2500, reason: "Overcharged", intent: "reverse" });
    await t.api.post(`/payments/${pb.payments[0].id}/refund`, { amountCents: 5000, reason: "Paid twice", intent: "reverse" });
    await runWorker(ctx);
    await runWorker(ctx);
    expect(Object.values((await companies().get(realm)).payments)).toEqual([expect.objectContaining({ amountCents: 7500 })]);
    expect(await link("payment", pb.payments[0].id)).toMatchObject({ status: "ignored", syncError: "Reversed in full before it reached QuickBooks" });
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
  it("keeps an estimate deposit, and a final invoice with deposit money applied, out of QuickBooks", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs } = await synced(t);
    const site = (await t.api.post(`/customers/${cs.nora.id}/sites`, { addressLine1: "9 Oak St", city: "Austin" })).json();
    const est = await ctx.db.insertInto("estimates").values({ organizationId: t.org.id, number: 1, customerId: cs.nora.id, siteId: site.id, title: "Estimate" }).returning("id").executeTakeFirstOrThrow();
    const deposit = await issue(t, cs.nora.id);
    // Deposit money comes off a final invoice as it is issued.
    const draft = (await t.api.post("/invoices", { customerId: cs.nora.id, lines: [{ description: "Aerator repair", quantity: 1, unitPriceCents: 30000 }] })).json();
    await ctx.db.updateTable("invoices").set({ depositAppliedCents: 5000, totalCents: 25000 }).where("id", "=", draft.id).execute();
    expect((await t.api.post(`/invoices/${draft.id}/issue`, { send: false })).statusCode).toBe(200);
    const applied = { id: draft.id as string };
    const none = await issue(t, cs.nora.id);
    // Linked the way acceptance and the final invoice link them (plan §3.6).
    await ctx.db
      .insertInto("estimateInvoices")
      .values([
        { organizationId: t.org.id, estimateId: est.id, invoiceId: deposit.id, role: "deposit", replacesInvoiceId: null, voidedAt: null },
        { organizationId: t.org.id, estimateId: est.id, invoiceId: applied.id, role: "final", replacesInvoiceId: null, voidedAt: new Date() },
        { organizationId: t.org.id, estimateId: est.id, invoiceId: none.id, role: "final", replacesInvoiceId: applied.id, voidedAt: null },
      ])
      .execute();
    await runWorker(ctx);
    expect(await link("invoice", deposit.id)).toMatchObject({ status: "conflict", conflictKind: "deposit_mapping_missing" });
    expect(await link("invoice", applied.id)).toMatchObject({ status: "conflict", conflictKind: "deposit_mapping_missing" });
    // A final invoice with nothing applied is an ordinary invoice.
    expect(await link("invoice", none.id)).toMatchObject({ status: "synced" });
    const recs = (await t.api.get("/quickbooks/records")).json() as { conflictKind: string; actions: string[] }[];
    expect(recs.filter((r) => r.conflictKind === "deposit_mapping_missing").map((r) => r.actions)).toEqual([["ignore"], ["ignore"]]);
  });
});

describe("sales tax", () => {
  const taxed = [
    { description: "Aerator repair", quantity: 1, unitPriceCents: 30000 },
    { description: "Chlorine", quantity: 2, unitPriceCents: 1250, taxable: true },
  ];
  /** Synced, with the 8.25% rate in Aerowise and, unless `on` is false, sales tax sync on. */
  async function withTax(t: Tenant, on = true) {
    const s = await synced(t);
    await t.api.patch("/billing/settings", { defaultTaxRateBps: 825 });
    if (on) {
      const res = await t.api.put("/quickbooks/mapping", { taxMode: "taxcode", taxableCodeRef: "TAX", nontaxableCodeRef: "NON", taxRateRef: "TX825" });
      expect(res.statusCode).toBe(200);
      expect(res.json().tax).toEqual({ mode: "taxcode", taxableCode: { id: "TAX", name: "TAX" }, nontaxableCode: { id: "NON", name: "NON" }, taxRate: { id: "TX825", name: "Travis County 8.25%" }, allowed: true });
    }
    return s;
  }
  const remoteInvoices = async (realm: string) => Object.values((await companies().get(realm)).invoices);

  it("is off by default and leaves the invoice payload as it was", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await withTax(t, false);
    expect((await t.api.get("/quickbooks/mapping")).json().tax).toEqual({ mode: "off", taxableCode: null, nontaxableCode: null, taxRate: null, allowed: true });
    const plain = await issue(t, cs.nora.id);
    const withTaxLine = await issue(t, cs.nora.id, taxed);
    await runWorker(ctx);
    expect(await link("invoice", plain.id)).toMatchObject({ status: "synced" });
    expect(await link("invoice", withTaxLine.id)).toMatchObject({ status: "conflict", conflictKind: "tax_mapping_missing" });
    const [sent] = await remoteInvoices(realm);
    expect(sent!.txnTax).toBeUndefined();
    expect(sent!.lines).toEqual([{ itemId: expect.any(String), description: "Aerator repair", quantity: 1, unitPriceCents: 30000, amountCents: 30000 }]);
  });

  it("is turned on only with all three codes of the right kind, and never for a live QuickBooks company", async () => {
    const t = await createTenant(ctx, "Org A");
    await withTax(t, false);
    const codes = (await t.api.get("/quickbooks/tax-codes")).json();
    expect(codes.map((c: { id: string }) => c.id).sort()).toEqual(["NON", "TAX", "TX825"]);
    expect((await t.api.put("/quickbooks/mapping", { taxMode: "taxcode", taxableCodeRef: "TAX" })).json().message).toMatch(/all three/);
    expect((await t.api.put("/quickbooks/mapping", { nontaxableCodeRef: "TAX" })).statusCode).toBe(422);
    expect((await t.api.put("/quickbooks/mapping", { taxRateRef: "NOPE" })).statusCode).toBe(422);
    expect((await t.api.put("/quickbooks/mapping", { taxableCodeRef: "TAX", nontaxableCodeRef: "NON", taxRateRef: "TX825" })).json().tax.mode).toBe("off");
    // Office staff cannot change it.
    const office = client(ctx.app, await login(ctx.app, (await createUser(ctx.db, t.org.id, "office")).email));
    expect((await office.put("/quickbooks/mapping", { taxMode: "taxcode" })).statusCode).toBe(403);
    // A live company: refused until G-QBO-TAX.
    await ctx.db.updateTable("quickbooksConnections").set({ environment: "production" }).execute();
    expect((await t.api.get("/quickbooks/mapping")).json().tax.allowed).toBe(false);
    const refused = await t.api.put("/quickbooks/mapping", { taxMode: "taxcode" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toMatch(/live QuickBooks companies/);
    expect((await ctx.db.selectFrom("quickbooksConnections").select("taxMode").executeTakeFirstOrThrow()).taxMode).toBe("off");
  });

  it("sends mixed taxable lines with tax codes and the tax total when QuickBooks agrees", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await withTax(t);
    const inv = await issue(t, cs.nora.id, taxed);
    expect(inv.totalCents).toBe(32706);
    await t.api.post(`/invoices/${inv.id}/payments`, { amountCents: 32706, method: "cash", receivedOn: "2026-03-01" });
    await runWorker(ctx);
    expect(await link("invoice", inv.id)).toMatchObject({ status: "synced", remoteState: "open" });
    const [sent] = await remoteInvoices(realm);
    expect(sent).toMatchObject({ totalCents: 32706, taxCents: 206, balanceCents: 0, txnTax: { taxCodeRef: "TX825", totalTaxCents: 206 } });
    expect(sent!.lines.map((l) => l.taxCodeRef)).toEqual(["NON", "TAX"]);
    expect(Object.values((await companies().get(realm)).payments)).toHaveLength(1);
  });

  it("sends the taxed invoices that waited once tax sync is turned on", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await withTax(t, false);
    const inv = await issue(t, cs.nora.id, taxed);
    await runWorker(ctx);
    expect(await link("invoice", inv.id)).toMatchObject({ conflictKind: "tax_mapping_missing" });
    await t.api.put("/quickbooks/mapping", { taxMode: "taxcode", taxableCodeRef: "TAX", nontaxableCodeRef: "NON", taxRateRef: "TX825" });
    await runWorker(ctx);
    expect(await link("invoice", inv.id)).toMatchObject({ status: "synced" });
    expect(await remoteInvoices(realm)).toHaveLength(1);
  });

  it("quarantines an invoice QuickBooks taxed differently, holds its payments and refunds, and releases them once corrected", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm, items } = await withTax(t);
    const services = items.find((i) => i.name === "Services")!;
    const checking = ((await t.api.get("/quickbooks/accounts")).json() as { id: string; name: string }[]).find((a) => a.name === "Checking")!;
    await t.api.put("/quickbooks/mapping", { refundItemId: services.id, manualRefundAccountId: checking.id });
    await companies().setAutomatedTax(realm, 900);
    const inv = await issue(t, cs.nora.id, taxed);
    await runWorker(ctx);
    const held = (await link("invoice", inv.id))!;
    expect(held).toMatchObject({ status: "quarantined", conflictKind: "tax_total_mismatch" });
    expect(held.externalId).toBeTruthy();
    expect(held.conflict).toMatchObject({ aerowise: { totalCents: 32706, taxCents: 206 }, quickbooks: { totalCents: 32725, taxCents: 225 }, matches: false });

    // The person sees both totals and the two choices; it is in the inbox too.
    const rec = (await t.api.get("/quickbooks/records")).json().find((r: { entityId: string }) => r.entityId === inv.id);
    expect(rec).toMatchObject({ status: "quarantined", title: "QuickBooks totals differ", actions: ["recheck", "keep_remote"], details: { aerowise: { taxCents: 206 }, quickbooks: { taxCents: 225 } } });
    expect((await t.api.get("/quickbooks")).json().attention).toBe(1);
    expect((await t.api.get("/inbox")).json().items.find((e: { kind: string }) => e.kind === "quickbooks_conflict")).toMatchObject({ title: "QuickBooks: QuickBooks totals differ" });

    // A payment and a refund are held; nothing more reaches QuickBooks for this invoice.
    const paid = (await t.api.post(`/invoices/${inv.id}/payments`, { amountCents: 20000, method: "check", reference: "1", receivedOn: "2026-03-01" })).json();
    const refunded = (await t.api.post(`/payments/${paid.payments[0].id}/refund`, { amountCents: 500, reason: "Overcharged" })).json();
    const refundId = refunded.payments[0].refunds[0].id as string;
    await runWorker(ctx);
    expect(await link("payment", paid.payments[0].id)).toMatchObject({ status: "queued", syncError: "Held: the invoice's totals in QuickBooks differ from Aerowise's. Settle the invoice first." });
    expect(await link("refund", refundId)).toMatchObject({ status: "queued", syncError: "Held: the invoice's totals in QuickBooks differ from Aerowise's. Settle the invoice first." });
    const before = await companies().get(realm);
    expect(Object.keys(before.payments)).toHaveLength(0);
    expect(before.refundReceipts).toEqual({});
    // Checking again before it is corrected keeps it held, with fresh totals.
    const again = (await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "recheck" })).json();
    expect(again).toMatchObject({ status: "quarantined", details: { quickbooks: { taxCents: 225 } } });
    // Corrected in QuickBooks: checking again releases the hold, and the payment and refund go.
    await companies().setInvoiceTax(realm, held.externalId!, 206);
    expect((await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "recheck" })).json()).toMatchObject({ status: "synced" });
    await runWorker(ctx);
    await runWorker(ctx);
    expect(await link("payment", paid.payments[0].id)).toMatchObject({ status: "synced" });
    expect(await link("refund", refundId)).toMatchObject({ status: "synced" });
    const after = await companies().get(realm);
    expect(Object.keys(after.invoices)).toEqual([held.externalId]);
    expect(Object.values(after.payments)).toMatchObject([{ amountCents: 20000 }]);
    expect(Object.values(after.refundReceipts ?? {})).toMatchObject([{ amountCents: 500 }]);
  });

  it("keeps a mismatched invoice as it is only with a reason, and then sends nothing for it", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await withTax(t);
    await companies().setAutomatedTax(realm, 900);
    const inv = await issue(t, cs.nora.id, taxed);
    await runWorker(ctx);
    const rec = (await t.api.get("/quickbooks/records")).json()[0];
    expect((await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "keep_remote" })).statusCode).toBe(422);
    expect((await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "keep_remote", reason: "   " })).statusCode).toBe(422);
    expect((await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "ignore" })).statusCode).toBe(422);
    const kept = (await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "keep_remote", reason: "Accountant fixes tax by hand" })).json();
    expect(kept).toMatchObject({ status: "ignored", actions: ["recheck"], syncError: "Kept as it is in QuickBooks: Accountant fixes tax by hand" });
    const audit = await ctx.db.selectFrom("auditEvents").select("changes").where("action", "=", "quickbooks.record_resolved").executeTakeFirstOrThrow();
    expect(audit.changes).toMatchObject({ action: "keep_remote", reason: "Accountant fixes tax by hand" });
    // A plain retry cannot sneak it back without a comparison.
    expect((await t.api.post(`/quickbooks/records/${rec.id}/resolve`, { action: "retry" })).statusCode).toBe(422);
    const paid = (await t.api.post(`/invoices/${inv.id}/payments`, { amountCents: 1000, method: "cash", receivedOn: "2026-03-01" })).json();
    await runWorker(ctx);
    // Its payments are not sent either: the office records them in QuickBooks itself.
    expect(await link("payment", paid.payments[0].id)).toBeUndefined();
    const company = await companies().get(realm);
    expect(Object.keys(company.invoices)).toEqual([kept.externalId]);
    expect(company.payments).toEqual({});
  });

  it("sends nothing for an already-sent payment or its refunds while its invoice is kept as is, and sends it once on release", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm, items } = await withTax(t);
    const services = items.find((i) => i.name === "Services")!;
    const checking = ((await t.api.get("/quickbooks/accounts")).json() as { id: string; name: string }[]).find((a) => a.name === "Checking")!;
    await t.api.put("/quickbooks/mapping", { refundItemId: services.id, manualRefundAccountId: checking.id });
    const inv = await issue(t, cs.nora.id, taxed);
    const paid = (await t.api.post(`/invoices/${inv.id}/payments`, { amountCents: 20000, method: "check", reference: "7", receivedOn: "2026-03-01" })).json();
    const paymentId = paid.payments[0].id as string;
    await runWorker(ctx);
    const sentPayment = (await link("payment", paymentId))!;
    expect(sentPayment).toMatchObject({ status: "synced" });
    // Today an invoice is only quarantined before its payments go, so this state is built
    // directly: the guard must hold whatever path leads here (an already-sent payment on an
    // invoice that is then quarantined and kept as is).
    const invLink = (await link("invoice", inv.id))!;
    await ctx.db
      .updateTable("quickbooksLinks")
      .set({ status: "quarantined", conflictKind: "tax_total_mismatch", conflict: JSON.stringify({ aerowise: { totalCents: 32706, taxCents: 206 }, quickbooks: { totalCents: 32725, taxCents: 225 } }) })
      .where("id", "=", invLink.id)
      .execute();
    expect((await t.api.post(`/quickbooks/records/${invLink.id}/resolve`, { action: "keep_remote", reason: "Checking with the accountant" })).statusCode).toBe(200);

    // A refund reversing part of the payment, and a credit refund, while the invoice is kept.
    expect((await t.api.post(`/payments/${paymentId}/refund`, { amountCents: 500, reason: "Overcharged", intent: "reverse" })).statusCode).toBe(200);
    const credited = (await t.api.post(`/payments/${paymentId}/refund`, { amountCents: 300, reason: "Goodwill" })).json();
    const creditId = credited.payments[0].refunds.find((r: { intent: string }) => r.intent === "credit").id as string;
    const before = await companies().get(realm);
    await runWorker(ctx);
    await runWorker(ctx);
    // Nothing was created, changed or deleted in QuickBooks.
    const held = await companies().get(realm);
    expect({ payments: held.payments, refundReceipts: held.refundReceipts, invoices: held.invoices, requests: held.requests }).toEqual({
      payments: before.payments,
      refundReceipts: before.refundReceipts,
      invoices: before.invoices,
      requests: before.requests,
    });
    const kept = "Not sent: the invoice is kept as it is in QuickBooks. Record this there yourself, or check the invoice again.";
    expect(await link("payment", paymentId)).toMatchObject({ status: "queued", syncError: kept, externalId: sentPayment.externalId, syncToken: sentPayment.syncToken });
    expect(await link("refund", creditId)).toMatchObject({ status: "queued", syncError: kept, externalId: null });

    // QuickBooks' totals match, so checking again releases both, each sent exactly once.
    expect((await t.api.post(`/quickbooks/records/${invLink.id}/resolve`, { action: "recheck" })).json()).toMatchObject({ status: "synced" });
    await runWorker(ctx);
    await runWorker(ctx);
    const after = await companies().get(realm);
    expect(Object.values(after.payments)).toMatchObject([{ id: sentPayment.externalId, amountCents: 19500 }]);
    expect(Object.values(after.refundReceipts ?? {})).toMatchObject([{ amountCents: 300 }]);
    await t.api.post("/quickbooks/sync", {});
    await runWorker(ctx);
    const again = await companies().get(realm);
    expect(again.payments).toEqual(after.payments);
    expect(again.refundReceipts).toEqual(after.refundReceipts);
    expect(await link("payment", paymentId)).toMatchObject({ status: "synced", pushedHash: "19500" });
    expect(await link("refund", creditId)).toMatchObject({ status: "synced" });
  });

  it("never lets a check again overwrite a decision made while QuickBooks was being read", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await withTax(t);
    await companies().setAutomatedTax(realm, 900);
    const inv = await issue(t, cs.nora.id, taxed);
    await runWorker(ctx);
    const held = (await link("invoice", inv.id))!;
    await companies().setInvoiceTax(realm, held.externalId!, 206);
    const base = new TestQuickBooksProvider(ctx.db, () => ctx.now);
    // Another person keeps it as it is while this check is reading QuickBooks.
    const racing = Object.assign(Object.create(base), {
      company(realmId: string): QuickBooksCompany {
        const company = base.company(realmId);
        return Object.assign(Object.create(company), {
          async getInvoice(id: string) {
            const read = await company.getInvoice(id);
            await resolveLink(qbCtx, t.org.id, held.id, { action: "keep_remote", reason: "Decided meanwhile" });
            return read;
          },
        });
      },
    });
    const qbCtx = { db: ctx.db, now: () => ctx.now, provider: racing, cipher: new TokenCipher() };
    await expect(recheckInvoice(qbCtx, t.org.id, held.id)).rejects.toThrow(/changed meanwhile/);
    expect(await link("invoice", inv.id)).toMatchObject({ status: "ignored", remoteState: "kept_mismatch", syncError: "Kept as it is in QuickBooks: Decided meanwhile" });
  });

  it("never creates a second invoice when QuickBooks' answer is lost, matching or not", async () => {
    for (const automated of [null, 900]) {
      const t = await createTenant(ctx, `Org ${automated ?? "plain"}`);
      const { cs, realm } = await withTax(t);
      await companies().setAutomatedTax(realm, automated);
      const inv = await issue(t, cs.nora.id, taxed);
      await companies().loseNext(realm, 1);
      await runWorker(ctx);
      // QuickBooks made it, but Aerowise never heard: it retries on its own.
      const failed = (await link("invoice", inv.id))!;
      expect(failed).toMatchObject({ status: "failed", externalId: null });
      expect(await remoteInvoices(realm)).toHaveLength(1);
      later(2);
      await t.api.post("/quickbooks/sync", {});
      await runWorker(ctx);
      const settled = (await link("invoice", inv.id))!;
      expect(settled.status).toBe(automated ? "quarantined" : "synced");
      const remote = await remoteInvoices(realm);
      expect(remote).toHaveLength(1);
      expect(settled.externalId).toBe(remote[0]!.id);
    }
  });

  it("returns the first invoice when the same create request is replayed", async () => {
    const t = await createTenant(ctx, "Org A");
    const { cs, realm } = await withTax(t);
    const customer = (await link("customer", cs.dana.id))!;
    const company = new TestQuickBooksProvider(ctx.db, () => ctx.now).company(realm);
    const payload = {
      customerId: customer.externalId!,
      docNumber: "INV-9001",
      txnDate: "2026-03-01",
      dueDate: "2026-03-31",
      lines: [{ itemId: Object.keys((await companies().get(realm)).items)[0]!, description: "Chlorine", quantity: 1, unitPriceCents: 1000, amountCents: 1000, taxCodeRef: "TAX" }],
      discountCents: 0,
      txnTax: { taxCodeRef: "TX825", totalTaxCents: 83 },
      memo: null,
      privateNote: "Aerowise invoice INV-9001",
      billEmail: null,
      shipAddress: null,
    };
    const first = await company.createInvoice(payload, "aw-replay-1");
    const second = await company.createInvoice(payload, "aw-replay-1");
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ totalCents: 1083, taxCents: 83 });
    await expect(company.createInvoice({ ...payload, txnTax: { taxCodeRef: "GONE", totalTaxCents: 0 } }, "aw-replay-2")).rejects.toMatchObject({ kind: "validation" });
    expect(await remoteInvoices(realm)).toHaveLength(1);
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
