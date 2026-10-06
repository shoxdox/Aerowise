import { describe, expect, it } from "vitest";
import { TokenCipher } from "./crypto.ts";
import { IntuitQuickBooksProvider, qboDisplayName } from "./intuit.ts";
import { QuickBooksError } from "./types.ts";

type Call = { url: URL; init: RequestInit };

/** A fetch that records requests and answers from a list. */
function fakeFetch(...answers: { status?: number; body: unknown; headers?: Record<string, string> }[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(url)), init: init ?? {} });
    const a = answers.shift() ?? { body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json", ...a.headers } });
  }) as typeof fetch;
  return { fn, calls };
}

const config = { clientId: "client", clientSecret: "secret", environment: "sandbox" as const };

describe("Intuit OAuth", () => {
  it("sends the owner to Intuit's consent page with the accounting scope", () => {
    const url = new URL(new IntuitQuickBooksProvider(config).authorizeUrl({ state: "s1", redirectUri: "https://app.example/api/quickbooks/callback", organizationId: "o" }));
    expect(url.origin + url.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client",
      response_type: "code",
      scope: "com.intuit.quickbooks.accounting",
      redirect_uri: "https://app.example/api/quickbooks/callback",
      state: "s1",
    });
  });

  it("exchanges a code with basic auth and reads both expiries", async () => {
    const f = fakeFetch({ body: { access_token: "at", refresh_token: "rt", expires_in: 3600, x_refresh_token_expires_in: 8_640_000 } });
    const t = await new IntuitQuickBooksProvider(config, f.fn).exchangeCode({ code: "c", realmId: "r", redirectUri: "https://x/cb" });
    expect(t).toMatchObject({ accessToken: "at", refreshToken: "rt" });
    expect(t.refreshExpiresAt!.getTime() - t.accessExpiresAt.getTime()).toBeGreaterThan(80 * 86_400_000);
    expect(f.calls[0]!.url.href).toBe("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("client:secret").toString("base64")}`);
    expect(String(f.calls[0]!.init.body)).toBe("grant_type=authorization_code&code=c&redirect_uri=https%3A%2F%2Fx%2Fcb");
  });

  it("treats a refused refresh as needing to connect again", async () => {
    const f = fakeFetch({ status: 400, body: { error: "invalid_grant" } });
    await expect(new IntuitQuickBooksProvider(config, f.fn).refresh("old")).rejects.toMatchObject({ kind: "auth", code: "invalid_grant" });
  });
});

describe("Intuit company API", () => {
  const company = (f: ReturnType<typeof fakeFetch>) => new IntuitQuickBooksProvider(config, f.fn).company("123", "token");

  it("lowers a payment with a full update that keeps its other fields, and deletes one", async () => {
    const current = { Id: "77", SyncToken: "2", TxnDate: "2026-03-01", PaymentRefNum: "1042", CustomerRef: { value: "9" }, TotalAmt: 10, MetaData: { CreateTime: "x" }, Line: [] };
    const f = fakeFetch({ body: { Payment: current } }, { body: { Payment: { ...current, SyncToken: "3", TotalAmt: 8 } } }, { body: { Payment: { Id: "77", status: "Deleted" } } });
    const c = company(f);
    expect(await c.updatePayment("77", "2", { invoiceId: "41", amountCents: 800, privateNote: "refunded" })).toEqual({ id: "77", syncToken: "3" });
    const sent = JSON.parse(String(f.calls[1]!.init.body));
    expect(sent).toEqual({
      Id: "77",
      SyncToken: "2",
      TxnDate: "2026-03-01",
      PaymentRefNum: "1042",
      CustomerRef: { value: "9" },
      TotalAmt: 8,
      PrivateNote: "refunded",
      Line: [{ Amount: 8, LinkedTxn: [{ TxnId: "41", TxnType: "Invoice" }] }],
    });
    const read = fakeFetch({ body: { Payment: { Id: "77", SyncToken: "4", TotalAmt: 10, Line: [{ Amount: 6, LinkedTxn: [{ TxnId: "41", TxnType: "Invoice" }] }, { Amount: 4, LinkedTxn: [{ TxnId: "42", TxnType: "Invoice" }] }] } } });
    expect(await company(read).getPayment("77")).toEqual({ id: "77", syncToken: "4", amountCents: 1000, applied: [{ invoiceId: "41", amountCents: 600 }, { invoiceId: "42", amountCents: 400 }] });
    await c.deletePayment("77", "3");
    expect(f.calls[2]!.url.searchParams.get("operation")).toBe("delete");
    expect(JSON.parse(String(f.calls[2]!.init.body))).toEqual({ Id: "77", SyncToken: "3" });
  });

  it("queries with escaped quotes and pages through results", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i), DisplayName: `C${i}`, SyncToken: "0" }));
    const f = fakeFetch({ body: { QueryResponse: { Customer: page } } }, { body: { QueryResponse: { Customer: [{ Id: "1000", DisplayName: "O'Brien", Active: true }] } } });
    const all = await company(f).listCustomers();
    expect(all).toHaveLength(1001);
    expect(f.calls[1]!.url.searchParams.get("query")).toBe("select * from Customer startposition 1001 maxresults 1000");
    expect(f.calls[0]!.url.searchParams.get("minorversion")).toBe("75");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer token");

    const g = fakeFetch({ body: { QueryResponse: {} } });
    await company(g).findInvoiceByNumber("INV-1'1");
    expect(g.calls[0]!.url.searchParams.get("query")).toBe("select * from Invoice where DocNumber = 'INV-1\\'1'");
  });

  it("builds an invoice with item lines, a discount and a request id", async () => {
    const f = fakeFetch({ body: { Invoice: { Id: "9", SyncToken: "0", DocNumber: "INV-1001", CustomerRef: { value: "5" }, TotalAmt: 290, Balance: 290 } } });
    const inv = await company(f).createInvoice(
      {
        customerId: "5",
        docNumber: "INV-1001",
        txnDate: "2026-03-01",
        dueDate: "2026-03-31",
        lines: [{ itemId: "1", description: "Repair", quantity: 2, unitPriceCents: 15000, amountCents: 30000 }],
        discountCents: 1000,
        memo: null,
        privateNote: "Aerowise invoice INV-1001",
        billEmail: "a@b.c",
        shipAddress: { line1: "1 Main", line2: null, city: "Austin", state: "TX", postalCode: "78701" },
      },
      "aw-1-1",
    );
    expect(inv).toMatchObject({ id: "9", totalCents: 29000, balanceCents: 29000, customerId: "5" });
    expect(f.calls[0]!.url.pathname).toBe("/v3/company/123/invoice");
    expect(f.calls[0]!.url.searchParams.get("requestid")).toBe("aw-1-1");
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body.Line).toEqual([
      { DetailType: "SalesItemLineDetail", Amount: 300, Description: "Repair", SalesItemLineDetail: { ItemRef: { value: "1" }, Qty: 2, UnitPrice: 150 } },
      { DetailType: "DiscountLineDetail", Amount: 10, DiscountLineDetail: { PercentBased: false } },
    ]);
    expect(body.ShipAddr).toMatchObject({ Line1: "1 Main", City: "Austin", CountrySubDivisionCode: "TX", PostalCode: "78701" });
  });

  it("maps QuickBooks faults to what the sync does with them", async () => {
    const fault = (code: string) => ({ status: 400, body: { Fault: { Error: [{ Message: "Msg", Detail: "Detail", code }], type: "ValidationFault" } } });
    const p = { displayName: "A", email: null, phone: null, address: null };
    await expect(company(fakeFetch(fault("6240"))).createCustomer(p, "r")).rejects.toMatchObject({ kind: "duplicate_name" });
    await expect(company(fakeFetch(fault("5010"))).updateCustomer("1", "0", p)).rejects.toMatchObject({ kind: "stale" });
    await expect(company(fakeFetch(fault("6000"))).createCustomer(p, "r")).rejects.toMatchObject({ kind: "validation", message: "Msg: Detail" });
    await expect(company(fakeFetch({ status: 401, body: {} })).listItems()).rejects.toMatchObject({ kind: "auth" });
    await expect(company(fakeFetch({ status: 503, body: {} })).listItems()).rejects.toMatchObject({ kind: "transient" });
    expect(await company(fakeFetch(fault("610"))).getInvoice("1")).toBeNull();
    // Intuit's request id rides along on every failure, for Intuit support.
    await expect(company(fakeFetch({ ...fault("6000"), headers: { intuit_tid: "1-abc-2" } })).createCustomer(p, "r")).rejects.toMatchObject({
      kind: "validation",
      intuitTid: "1-abc-2",
      message: "Msg: Detail (Intuit ref 1-abc-2)",
    });
    await expect(company(fakeFetch({ status: 401, body: {}, headers: { intuit_tid: "1-def-3" } })).listItems()).rejects.toMatchObject({ kind: "auth", intuitTid: "1-def-3" });
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(new IntuitQuickBooksProvider(config, down).company("1", "t").listItems()).rejects.toBeInstanceOf(QuickBooksError);
  });

  it("reads change data capture, deletions included", async () => {
    const f = fakeFetch({
      body: { CDCResponse: [{ QueryResponse: [{ Customer: [{ Id: "1", DisplayName: "A", SyncToken: "3", Active: false }] }, { Invoice: [{ Id: "7", status: "Deleted" }, { Id: "8", TotalAmt: 1 }] }] }] },
    });
    const c = await company(f).changes(new Date());
    expect(c.customers).toMatchObject([{ id: "1", syncToken: "3", active: false }]);
    expect(c.invoices).toEqual([
      { id: "7", deleted: true },
      { id: "8", deleted: false },
    ]);
    expect(f.calls[0]!.url.searchParams.get("entities")).toBe("Customer,Invoice");
  });

  it("keeps display names to what QuickBooks allows", () => {
    expect(qboDisplayName("Smith: Ranch")).toBe("Smith - Ranch");
    expect(qboDisplayName("Two\nLines\tHere")).toBe("Two - Lines - Here");
    expect(qboDisplayName("x".repeat(600))).toHaveLength(500);
  });
});

describe("TokenCipher", () => {
  it("round-trips tokens and refuses tampering", () => {
    const c = new TokenCipher("k".repeat(64).replace(/k/g, "a"));
    const sealed = c.encrypt("secret-token");
    expect(sealed).not.toContain("secret");
    expect(c.decrypt(sealed)).toBe("secret-token");
    expect(() => new TokenCipher("other").decrypt(sealed)).toThrow();
  });

  it("signs OAuth state that expires", () => {
    const c = new TokenCipher();
    const now = new Date("2026-03-01T00:00:00Z");
    const s = c.signState({ organizationId: "o1", userId: "u1" }, now);
    expect(c.verifyState(s, now)).toEqual({ organizationId: "o1", userId: "u1" });
    expect(c.verifyState(s, new Date(now.getTime() + 16 * 60_000))).toBeNull();
    expect(c.verifyState(`${s.split(".")[0]}x.${s.split(".")[1]}`, now)).toBeNull();
    expect(new TokenCipher("other").verifyState(s, now)).toBeNull();
  });
});
