import {
  QuickBooksError,
  type Address,
  type Changes,
  type CustomerPayload,
  type InvoicePayload,
  type PaymentChange,
  type PaymentPayload,
  type QboCustomer,
  type QboInvoice,
  type QboItem,
  type QuickBooksCompany,
  type QuickBooksProvider,
  type Tokens,
} from "./types.ts";

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const API_BASE = { sandbox: "https://sandbox-quickbooks.api.intuit.com", production: "https://quickbooks.api.intuit.com" } as const;
const MINOR_VERSION = "75";
const SCOPE = "com.intuit.quickbooks.accounting";
/** QuickBooks returns at most 1000 rows per query. */
const PAGE = 1000;

type Fetch = typeof fetch;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const toCents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
const toAmount = (cents: number) => Math.round(cents) / 100;
/** QuickBooks query strings quote with single quotes and escape with a backslash. */
const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
/** Display names cannot contain a colon (it separates sub-customers) or line breaks. */
export const qboDisplayName = (s: string) => s.replace(/[:\t\r\n]+/g, " - ").replace(/\s+/g, " ").trim().slice(0, 500);

function address(a: Json | undefined): Address | null {
  if (!a) return null;
  const out = { line1: a.Line1 ?? null, line2: a.Line2 ?? null, city: a.City ?? null, state: a.CountrySubDivisionCode ?? null, postalCode: a.PostalCode ?? null };
  return Object.values(out).some(Boolean) ? out : null;
}
function qboAddress(a: Address | null) {
  if (!a) return undefined;
  return { Line1: a.line1 ?? undefined, Line2: a.line2 ?? undefined, City: a.city ?? undefined, CountrySubDivisionCode: a.state ?? undefined, PostalCode: a.postalCode ?? undefined, Country: "USA" };
}

function customer(c: Json): QboCustomer {
  return {
    id: String(c.Id),
    syncToken: String(c.SyncToken ?? "0"),
    name: c.DisplayName ?? "",
    email: c.PrimaryEmailAddr?.Address ?? null,
    phone: c.PrimaryPhone?.FreeFormNumber ?? null,
    address: address(c.BillAddr),
    active: c.Active !== false,
    updatedAt: c.MetaData?.LastUpdatedTime ?? null,
  };
}
function invoice(i: Json): QboInvoice {
  return {
    id: String(i.Id),
    syncToken: String(i.SyncToken ?? "0"),
    docNumber: i.DocNumber ?? null,
    customerId: String(i.CustomerRef?.value ?? ""),
    customerName: i.CustomerRef?.name ?? null,
    totalCents: toCents(i.TotalAmt),
    balanceCents: toCents(i.Balance),
    voided: /^voided/i.test(String(i.PrivateNote ?? "")) && toCents(i.TotalAmt) === 0,
    updatedAt: i.MetaData?.LastUpdatedTime ?? null,
  };
}
function customerBody(p: CustomerPayload) {
  return {
    DisplayName: qboDisplayName(p.displayName),
    PrimaryEmailAddr: p.email ? { Address: p.email } : undefined,
    PrimaryPhone: p.phone ? { FreeFormNumber: p.phone } : undefined,
    BillAddr: qboAddress(p.address),
  };
}

/**
 * QuickBooks Online through Intuit's REST API (v3) and OAuth 2.0. Needs an Intuit app's
 * client id and secret (QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET).
 */
export class IntuitQuickBooksProvider implements QuickBooksProvider {
  readonly kind = "intuit";

  constructor(
    private readonly config: { clientId: string; clientSecret: string; environment: "sandbox" | "production" },
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  get environment() {
    return this.config.environment;
  }

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string; organizationId: string }) {
    const q = new URLSearchParams({ client_id: this.config.clientId, response_type: "code", scope: SCOPE, redirect_uri: redirectUri, state });
    return `${AUTHORIZE_URL}?${q}`;
  }

  private async token(form: Record<string, string>): Promise<Tokens> {
    let res: Response;
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams(form),
      });
    } catch (err) {
      throw new QuickBooksError("transient", `Could not reach QuickBooks: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      const tid = res.headers.get("intuit_tid") ?? undefined;
      if (res.status >= 500 || res.status === 429) throw new QuickBooksError("transient", `QuickBooks sign-in is unavailable (${res.status})`, undefined, tid);
      throw new QuickBooksError("auth", `QuickBooks refused the connection: ${body.error_description ?? body.error ?? res.status}`, body.error, tid);
    }
    const now = Date.now();
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      accessExpiresAt: new Date(now + Number(body.expires_in ?? 3600) * 1000),
      refreshExpiresAt: body.x_refresh_token_expires_in ? new Date(now + Number(body.x_refresh_token_expires_in) * 1000) : null,
    };
  }

  exchangeCode({ code, redirectUri }: { code: string; realmId: string; redirectUri: string }) {
    return this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  refresh(refreshToken: string) {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async revoke(refreshToken: string) {
    await this.fetchImpl(REVOKE_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({ token: refreshToken }),
    }).catch(() => undefined);
  }

  company(realmId: string, accessToken: string): QuickBooksCompany {
    return new IntuitCompany(`${API_BASE[this.config.environment]}/v3/company/${encodeURIComponent(realmId)}`, realmId, accessToken, this.fetchImpl);
  }
}

class IntuitCompany implements QuickBooksCompany {
  constructor(
    private readonly base: string,
    private readonly realmId: string,
    private readonly accessToken: string,
    private readonly fetchImpl: Fetch,
  ) {}

  private async call(method: "GET" | "POST", path: string, params: Record<string, string> = {}, body?: unknown): Promise<Json> {
    const q = new URLSearchParams({ ...params, minorversion: MINOR_VERSION });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}?${q}`, {
        method,
        headers: { accept: "application/json", authorization: `Bearer ${this.accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new QuickBooksError("transient", `Could not reach QuickBooks: ${(err as Error).message}`);
    }
    const data = (await res.json().catch(() => ({}))) as Json;
    if (res.ok && !data.Fault) return data;
    // Every failure carries Intuit's request id, so a stored sync error can be traced with Intuit support.
    const tid = res.headers.get("intuit_tid") ?? undefined;
    if (res.status === 401 || res.status === 403) throw new QuickBooksError("auth", "QuickBooks no longer accepts this connection. Connect again.", undefined, tid);
    if (res.status === 429 || res.status >= 500) throw new QuickBooksError("transient", `QuickBooks is busy or unavailable (${res.status})`, undefined, tid);
    const e = (data.Fault?.Error?.[0] ?? {}) as Json;
    const code = e.code != null ? String(e.code) : undefined;
    const message = [e.Message, e.Detail].filter(Boolean).join(": ") || `QuickBooks returned ${res.status}`;
    if (code === "6240") throw new QuickBooksError("duplicate_name", message, code, tid);
    if (code === "5010") throw new QuickBooksError("stale", message, code, tid);
    if (code === "610") throw new QuickBooksError("validation", "Not found in QuickBooks", code, tid);
    throw new QuickBooksError("validation", message, code, tid);
  }

  private async query(statement: string): Promise<Json> {
    return (await this.call("GET", "/query", { query: statement })).QueryResponse ?? {};
  }

  private async queryAll(entity: string, where: string): Promise<Json[]> {
    const rows: Json[] = [];
    for (let start = 1; ; start += PAGE) {
      const page = ((await this.query(`select * from ${entity}${where ? ` where ${where}` : ""} startposition ${start} maxresults ${PAGE}`))[entity] ?? []) as Json[];
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  }

  /** A read that answers null for a record QuickBooks no longer has. */
  private async read(entity: string, id: string): Promise<Json | null> {
    try {
      return (await this.call("GET", `/${entity.toLowerCase()}/${encodeURIComponent(id)}`))[entity] ?? null;
    } catch (err) {
      if (err instanceof QuickBooksError && err.code === "610") return null;
      throw err;
    }
  }

  async companyName() {
    const info = (await this.call("GET", `/companyinfo/${encodeURIComponent(this.realmId)}`)).CompanyInfo as Json | undefined;
    return info?.CompanyName ?? null;
  }

  async listCustomers() {
    return (await this.queryAll("Customer", "")).map(customer);
  }

  async findCustomers(name: string, email: string | null) {
    const words = [...new Set(name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3))]
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);
    const found = new Map<string, QboCustomer>();
    for (const w of words) {
      for (const c of ((await this.query(`select * from Customer where DisplayName like ${quote(`%${w}%`)} maxresults 100`)).Customer ?? []) as Json[]) found.set(String(c.Id), customer(c));
    }
    if (email) {
      try {
        for (const c of ((await this.query(`select * from Customer where PrimaryEmailAddr = ${quote(email)} maxresults 100`)).Customer ?? []) as Json[]) found.set(String(c.Id), customer(c));
      } catch {
        // Not every QuickBooks version filters on email; names are enough to go on.
      }
    }
    return [...found.values()];
  }

  async getCustomer(id: string) {
    const c = await this.read("Customer", id);
    return c ? customer(c) : null;
  }

  async createCustomer(payload: CustomerPayload, requestId: string) {
    return customer((await this.call("POST", "/customer", { requestid: requestId }, customerBody(payload))).Customer);
  }

  async updateCustomer(id: string, syncToken: string, payload: CustomerPayload) {
    return customer((await this.call("POST", "/customer", {}, { Id: id, SyncToken: syncToken, sparse: true, ...customerBody(payload) })).Customer);
  }

  async listItems(): Promise<QboItem[]> {
    return (await this.queryAll("Item", "Active in (true, false)")).map((i) => ({ id: String(i.Id), name: i.FullyQualifiedName ?? i.Name, type: i.Type ?? "Service", active: i.Active !== false }));
  }

  async getItem(id: string) {
    const i = await this.read("Item", id);
    return i ? { id: String(i.Id), name: i.FullyQualifiedName ?? i.Name, type: i.Type ?? "Service", active: i.Active !== false } : null;
  }

  async findInvoiceByNumber(docNumber: string) {
    const rows = ((await this.query(`select * from Invoice where DocNumber = ${quote(docNumber)}`)).Invoice ?? []) as Json[];
    return rows[0] ? invoice(rows[0]) : null;
  }

  async getInvoice(id: string) {
    const i = await this.read("Invoice", id);
    return i ? invoice(i) : null;
  }

  async createInvoice(p: InvoicePayload, requestId: string) {
    const body = {
      CustomerRef: { value: p.customerId },
      DocNumber: p.docNumber,
      TxnDate: p.txnDate,
      DueDate: p.dueDate,
      Line: [
        ...p.lines.map((l) => ({
          DetailType: "SalesItemLineDetail",
          Amount: toAmount(l.amountCents),
          Description: l.description,
          SalesItemLineDetail: { ItemRef: { value: l.itemId }, Qty: l.quantity, UnitPrice: toAmount(l.unitPriceCents) },
        })),
        ...(p.discountCents > 0 ? [{ DetailType: "DiscountLineDetail", Amount: toAmount(p.discountCents), DiscountLineDetail: { PercentBased: false } }] : []),
      ],
      CustomerMemo: p.memo ? { value: p.memo.slice(0, 1000) } : undefined,
      PrivateNote: p.privateNote,
      BillEmail: p.billEmail ? { Address: p.billEmail } : undefined,
      ShipAddr: qboAddress(p.shipAddress),
    };
    return invoice((await this.call("POST", "/invoice", { requestid: requestId }, body)).Invoice);
  }

  async voidInvoice(id: string, syncToken: string) {
    return invoice((await this.call("POST", "/invoice", { operation: "void" }, { Id: id, SyncToken: syncToken })).Invoice);
  }

  async createPayment(p: PaymentPayload, requestId: string) {
    const body = {
      CustomerRef: { value: p.customerId },
      TotalAmt: toAmount(p.amountCents),
      TxnDate: p.txnDate,
      PaymentRefNum: p.reference ? p.reference.slice(0, 21) : undefined,
      PrivateNote: p.privateNote,
      Line: [{ Amount: toAmount(p.amountCents), LinkedTxn: [{ TxnId: p.invoiceId, TxnType: "Invoice" }] }],
    };
    const pay = (await this.call("POST", "/payment", { requestid: requestId }, body)).Payment as Json;
    return { id: String(pay.Id), syncToken: String(pay.SyncToken ?? "0") };
  }

  async getPayment(id: string) {
    const pay = await this.read("Payment", id);
    return pay ? { id: String(pay.Id), syncToken: String(pay.SyncToken ?? "0"), amountCents: Math.round(Number(pay.TotalAmt ?? 0) * 100) } : null;
  }

  /** A full update: QuickBooks clears what a payment update leaves out, so send the rest back as it is. */
  async updatePayment(id: string, syncToken: string, c: PaymentChange) {
    const current = await this.read("Payment", id);
    if (!current) throw new QuickBooksError("validation", "Object Not Found: the payment was deleted in QuickBooks", "610");
    const body = {
      ...current,
      MetaData: undefined,
      SyncToken: syncToken,
      TotalAmt: toAmount(c.amountCents),
      PrivateNote: c.privateNote,
      Line: [{ Amount: toAmount(c.amountCents), LinkedTxn: [{ TxnId: c.invoiceId, TxnType: "Invoice" }] }],
    };
    const pay = (await this.call("POST", "/payment", {}, body)).Payment as Json;
    return { id: String(pay.Id), syncToken: String(pay.SyncToken ?? "0") };
  }

  async deletePayment(id: string, syncToken: string) {
    await this.call("POST", "/payment", { operation: "delete" }, { Id: id, SyncToken: syncToken });
  }

  async changes(since: Date): Promise<Changes> {
    const floor = new Date(Date.now() - 29 * 24 * 3600_000);
    const from = since < floor ? floor : since;
    const data = await this.call("GET", "/cdc", { entities: "Customer,Invoice", changedSince: from.toISOString() });
    const out: Changes = { customers: [], invoices: [] };
    for (const r of (data.CDCResponse?.[0]?.QueryResponse ?? []) as Json[]) {
      for (const c of (r.Customer ?? []) as Json[]) if (c.status !== "Deleted") out.customers.push(customer(c));
      for (const i of (r.Invoice ?? []) as Json[]) out.invoices.push({ id: String(i.Id), deleted: i.status === "Deleted" });
    }
    return out;
  }
}
