import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@aerowise/db";
import {
  QuickBooksError,
  type Changes,
  type CustomerPayload,
  type InvoicePayload,
  type PaymentChange,
  type QboAccount,
  type RefundReceiptPayload,
  type PaymentPayload,
  type QboCustomer,
  type QboInvoice,
  type QboItem,
  type QuickBooksCompany,
  type QuickBooksProvider,
  type Tokens,
} from "./types.ts";

/** The whole stand-in company, kept as one JSON document per realm. */
export interface TestCompanyData {
  name: string;
  next: number;
  customers: Record<string, QboCustomer>;
  items: Record<string, QboItem>;
  invoices: Record<string, QboInvoice & { lines: InvoicePayload["lines"]; discountCents: number }>;
  payments: Record<string, { id: string; syncToken: string; customerId: string; invoiceId: string; amountCents: number; txnDate: string }>;
  /** Missing in companies saved before refunds were synced. */
  accounts?: Record<string, QboAccount>;
  refundReceipts?: Record<string, RefundReceiptPayload & { id: string; syncToken: string }>;
  /** What a request id created, so a repeated create returns the same record. */
  requests: Record<string, string>;
  /** Changes in order, for change data capture. */
  log: { entity: "customer" | "invoice"; id: string; at: string; deleted?: boolean }[];
  /** Tests: fail this many of the next changes as if QuickBooks were down. */
  failNext?: number;
  /** What those failures look like: QuickBooks down, or QuickBooks refusing the record. */
  failKind?: "transient" | "validation";
}

const bump = (token: string) => String(Number(token) + 1);

/**
 * Stands in for QuickBooks Online in development and tests: no network, no Intuit keys.
 * Connecting is instant and lands on a small made-up company that already has a few of
 * the provider's customers (some exactly, some nearly), so the first-sync review has real
 * decisions to show. The company lives in the database, so the API and the worker see the
 * same one. Never used in production.
 */
export class TestQuickBooksProvider implements QuickBooksProvider {
  readonly kind = "test";
  readonly environment = "test";

  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * No consent page: straight back to the callback, as if the owner clicked Connect. Each
   * organization always gets the same test company, so reconnecting finds it again.
   */
  authorizeUrl({ state, redirectUri, organizationId }: { state: string; redirectUri: string; organizationId: string }) {
    const realmId = `test-${createHash("sha256").update(organizationId).digest("hex").slice(0, 12)}`;
    const q = new URLSearchParams({ code: "test-authorization", realmId, state });
    return `${redirectUri}?${q}`;
  }

  private tokens(): Tokens {
    const now = this.now().getTime();
    return {
      accessToken: `qbt_access_${randomBytes(12).toString("hex")}`,
      refreshToken: `qbt_refresh_${randomBytes(12).toString("hex")}`,
      accessExpiresAt: new Date(now + 3600_000),
      refreshExpiresAt: new Date(now + 100 * 24 * 3600_000),
    };
  }

  async exchangeCode({ code }: { code: string; realmId: string; redirectUri: string }) {
    if (code !== "test-authorization") throw new QuickBooksError("auth", "Unknown authorization code");
    return this.tokens();
  }

  async refresh(refreshToken: string) {
    if (!refreshToken.startsWith("qbt_refresh_")) throw new QuickBooksError("auth", "Refresh token is not valid", "invalid_grant");
    return this.tokens();
  }

  async revoke() {}

  company(realmId: string): QuickBooksCompany {
    return new TestCompany(new TestCompanies(this.db, this.now), realmId);
  }
}

/** Reads and changes stand-in companies. Tests use it to play what someone does in QuickBooks. */
export class TestCompanies {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(realmId: string): Promise<TestCompanyData> {
    const row = await this.db.selectFrom("quickbooksTestCompanies").select("data").where("realmId", "=", realmId).executeTakeFirst();
    if (!row) throw new QuickBooksError("auth", "No such QuickBooks company");
    return row.data as TestCompanyData;
  }

  /** Changes a company under a row lock, so the API and the worker never lose each other's writes. */
  async update<T>(realmId: string, fn: (c: TestCompanyData, at: string) => T): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("quickbooksTestCompanies").select("data").where("realmId", "=", realmId).forUpdate().executeTakeFirst();
      if (!row) throw new QuickBooksError("auth", "No such QuickBooks company");
      const data = row.data as TestCompanyData;
      const out = fn(data, this.now().toISOString());
      await trx.updateTable("quickbooksTestCompanies").set({ data: JSON.stringify(data), updatedAt: this.now() }).where("realmId", "=", realmId).execute();
      return out;
    });
  }

  /**
   * Creates the company once. It starts with the usual products and services, some
   * strangers, and near-copies of the given customers: the first exactly (same name and
   * email), the second as "Last, First" with the same phone, the third twice (one with its
   * email, one with its phone, so it is ambiguous), the fourth with a misspelled name.
   */
  async seed(realmId: string, name: string, like: { name: string; email: string | null; phone: string | null }[]) {
    const at = this.now().toISOString();
    let n = 1;
    const id = () => String(n++);
    const customers: Record<string, QboCustomer> = {};
    const add = (c: Omit<QboCustomer, "id" | "syncToken" | "active" | "updatedAt" | "address">) => {
      const cid = id();
      customers[cid] = { ...c, id: cid, syncToken: "0", active: true, updatedAt: at, address: null };
    };
    const [a, b, c, d] = like;
    if (a) add({ name: a.name, email: a.email, phone: null });
    if (b) {
      const parts = b.name.split(" ");
      add({ name: parts.length > 1 ? `${parts.slice(1).join(" ")}, ${parts[0]}` : b.name, email: null, phone: b.phone });
    }
    if (c) {
      add({ name: c.name, email: c.email, phone: null });
      add({ name: c.name, email: null, phone: c.phone });
    }
    if (d) add({ name: `${d.name}${d.name.slice(-1)}`, email: null, phone: null });
    add({ name: "Hill Country Realty", email: "office@hcrealty.example", phone: "(512) 555-0199" });
    add({ name: "Lakeway HOA", email: null, phone: "(512) 555-0142" });
    const items: Record<string, QboItem> = {};
    for (const [itemName, type] of [
      ["Services", "Service"],
      ["Aerobic maintenance contract", "Service"],
      ["Septic repair", "Service"],
      ["Chlorine tablets", "NonInventory"],
    ] as const) {
      const iid = id();
      items[iid] = { id: iid, name: itemName, type, active: true };
    }
    const accounts: Record<string, QboAccount> = {};
    for (const [accountName, type] of [
      ["Checking", "Bank"],
      ["Undeposited Funds", "Other Current Asset"],
      ["Stripe Clearing", "Other Current Asset"],
    ] as const) {
      const aid = id();
      accounts[aid] = { id: aid, name: accountName, type, active: true };
    }
    const data: TestCompanyData = { name, next: n, customers, items, accounts, invoices: {}, payments: {}, refundReceipts: {}, requests: {}, log: [] };
    await this.db
      .insertInto("quickbooksTestCompanies")
      .values({ realmId, data: JSON.stringify(data), updatedAt: this.now() })
      .onConflict((oc) => oc.column("realmId").doNothing())
      .execute();
  }

  /** As if someone edited the customer in QuickBooks. */
  editCustomer(realmId: string, id: string, changes: Partial<Pick<QboCustomer, "name" | "email" | "phone" | "active">>) {
    return this.update(realmId, (c, at) => {
      const cur = c.customers[id];
      if (!cur) throw new Error(`no customer ${id}`);
      c.customers[id] = { ...cur, ...changes, syncToken: bump(cur.syncToken), updatedAt: at };
      c.log.push({ entity: "customer", id, at });
    });
  }

  deleteInvoice(realmId: string, id: string) {
    return this.update(realmId, (c, at) => {
      delete c.invoices[id];
      c.log.push({ entity: "invoice", id, at, deleted: true });
    });
  }

  setItemActive(realmId: string, id: string, active: boolean) {
    return this.update(realmId, (c) => {
      c.items[id] = { ...c.items[id]!, active };
    });
  }

  /** As if someone recorded a payment straight in QuickBooks. */
  payInvoice(realmId: string, id: string, amountCents: number) {
    return this.update(realmId, (c, at) => {
      const inv = c.invoices[id]!;
      c.invoices[id] = { ...inv, balanceCents: inv.balanceCents - amountCents, syncToken: bump(inv.syncToken), updatedAt: at };
    });
  }

  /** As if someone edited a payment in QuickBooks: its amount, or the invoice it pays. */
  editPayment(realmId: string, id: string, change: { amountCents?: number; invoiceId?: string }) {
    return this.update(realmId, (c, at) => {
      const pay = c.payments[id]!;
      const next = { ...pay, ...change, syncToken: bump(pay.syncToken) };
      const was = c.invoices[pay.invoiceId]!;
      c.invoices[pay.invoiceId] = { ...was, balanceCents: was.balanceCents + pay.amountCents, syncToken: bump(was.syncToken), updatedAt: at };
      const now = c.invoices[next.invoiceId]!;
      c.invoices[next.invoiceId] = { ...now, balanceCents: now.balanceCents - next.amountCents, syncToken: bump(now.syncToken), updatedAt: at };
      c.payments[id] = next;
    });
  }

  failNext(realmId: string, calls: number, kind: "transient" | "validation" = "transient") {
    return this.update(realmId, (c) => {
      c.failNext = calls;
      c.failKind = kind;
    });
  }
}

class TestCompany implements QuickBooksCompany {
  constructor(
    private readonly store: TestCompanies,
    private readonly realmId: string,
  ) {}

  private async read<T>(fn: (c: TestCompanyData) => T): Promise<T> {
    return fn(await this.store.get(this.realmId));
  }

  /** Every change goes through here, so a test can make QuickBooks "go down" for the next few. */
  private async write<T>(fn: (c: TestCompanyData, at: string, newId: () => string) => T): Promise<T> {
    const down = await this.store.update(this.realmId, (c) => {
      if (!c.failNext) return null;
      c.failNext--;
      return c.failKind ?? "transient";
    });
    if (down === "transient") throw new QuickBooksError("transient", "QuickBooks is busy or unavailable (503)");
    if (down) throw new QuickBooksError("validation", "Business Validation Error: Transaction date is in a closed period", "6140");
    return this.store.update(this.realmId, (c, at) => fn(c, at, () => String(c.next++)));
  }

  companyName() {
    return this.read((c) => c.name);
  }

  listCustomers() {
    return this.read((c) => Object.values(c.customers).filter((x) => x.active));
  }

  findCustomers(name: string, email: string | null) {
    const words = name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3);
    return this.read((c) =>
      Object.values(c.customers).filter(
        (x) => x.active && (words.some((w) => x.name.toLowerCase().includes(w)) || (email && x.email?.toLowerCase() === email.toLowerCase())),
      ),
    );
  }

  getCustomer(id: string) {
    return this.read((c) => c.customers[id] ?? null);
  }

  createCustomer(p: CustomerPayload, requestId: string) {
    return this.write((c, at, newId) => {
      const done = c.requests[requestId];
      if (done) return c.customers[done]!;
      if (Object.values(c.customers).some((x) => x.name.toLowerCase() === p.displayName.toLowerCase())) {
        throw new QuickBooksError("duplicate_name", "Duplicate Name Exists Error: The name supplied already exists.", "6240");
      }
      const id = newId();
      c.customers[id] = { id, syncToken: "0", name: p.displayName, email: p.email, phone: p.phone, address: p.address, active: true, updatedAt: at };
      c.requests[requestId] = id;
      c.log.push({ entity: "customer", id, at });
      return c.customers[id]!;
    });
  }

  updateCustomer(id: string, syncToken: string, p: CustomerPayload) {
    return this.write((c, at) => {
      const cur = c.customers[id];
      if (!cur) throw new QuickBooksError("validation", "Not found in QuickBooks", "610");
      if (cur.syncToken !== syncToken) throw new QuickBooksError("stale", "Stale Object Error: You and someone else were editing the same thing.", "5010");
      c.customers[id] = { ...cur, name: p.displayName, email: p.email, phone: p.phone, address: p.address, syncToken: bump(cur.syncToken), updatedAt: at };
      c.log.push({ entity: "customer", id, at });
      return c.customers[id]!;
    });
  }

  listItems() {
    return this.read((c) => Object.values(c.items));
  }

  getItem(id: string) {
    return this.read((c) => c.items[id] ?? null);
  }

  findInvoiceByNumber(docNumber: string) {
    return this.read((c) => Object.values(c.invoices).find((i) => i.docNumber === docNumber) ?? null);
  }

  getInvoice(id: string) {
    return this.read((c) => c.invoices[id] ?? null);
  }

  createInvoice(p: InvoicePayload, requestId: string) {
    return this.write((c, at, newId) => {
      const done = c.requests[requestId];
      if (done && c.invoices[done]) return c.invoices[done];
      const cust = c.customers[p.customerId];
      if (!cust?.active) throw new QuickBooksError("validation", "Invalid Reference Id: the customer is inactive or missing", "2500");
      for (const l of p.lines) {
        if (!c.items[l.itemId]?.active) throw new QuickBooksError("validation", `Invalid Reference Id: item ${l.itemId} is inactive or missing`, "2500");
      }
      const id = newId();
      const total = p.lines.reduce((s, l) => s + l.amountCents, 0) - p.discountCents;
      c.invoices[id] = {
        id,
        syncToken: "0",
        docNumber: p.docNumber,
        customerId: p.customerId,
        customerName: cust.name,
        totalCents: total,
        balanceCents: total,
        voided: false,
        updatedAt: at,
        lines: p.lines,
        discountCents: p.discountCents,
      };
      c.requests[requestId] = id;
      c.log.push({ entity: "invoice", id, at });
      return c.invoices[id];
    });
  }

  voidInvoice(id: string, syncToken: string) {
    return this.write((c, at) => {
      const inv = c.invoices[id];
      if (!inv) throw new QuickBooksError("validation", "Not found in QuickBooks", "610");
      if (inv.syncToken !== syncToken) throw new QuickBooksError("stale", "Stale Object Error", "5010");
      c.invoices[id] = { ...inv, totalCents: 0, balanceCents: 0, voided: true, syncToken: bump(inv.syncToken), updatedAt: at };
      c.log.push({ entity: "invoice", id, at });
      return c.invoices[id];
    });
  }

  createPayment(p: PaymentPayload, requestId: string) {
    return this.write((c, at, newId) => {
      const done = c.requests[requestId];
      if (done && c.payments[done]) return { id: done, syncToken: c.payments[done].syncToken };
      const inv = c.invoices[p.invoiceId];
      if (!inv) throw new QuickBooksError("validation", "Invalid Reference Id: the invoice is missing", "2500");
      const id = newId();
      c.payments[id] = { id, syncToken: "0", customerId: p.customerId, invoiceId: p.invoiceId, amountCents: p.amountCents, txnDate: p.txnDate };
      c.invoices[p.invoiceId] = { ...inv, balanceCents: inv.balanceCents - p.amountCents, syncToken: bump(inv.syncToken), updatedAt: at };
      c.requests[requestId] = id;
      return { id, syncToken: "0" };
    });
  }

  getPayment(id: string) {
    return this.read((c) => {
      const pay = c.payments[id];
      return pay ? { id, syncToken: pay.syncToken, amountCents: pay.amountCents, applied: [{ invoiceId: pay.invoiceId, amountCents: pay.amountCents }] } : null;
    });
  }

  updatePayment(id: string, syncToken: string, change: PaymentChange) {
    return this.write((c, at) => {
      const pay = c.payments[id];
      if (!pay) throw new QuickBooksError("validation", "Object Not Found", "610");
      if (pay.syncToken !== syncToken) throw new QuickBooksError("stale", "Stale Object Error", "5010");
      const was = c.invoices[pay.invoiceId];
      if (was) c.invoices[pay.invoiceId] = { ...was, balanceCents: was.balanceCents + pay.amountCents, syncToken: bump(was.syncToken), updatedAt: at };
      const inv = c.invoices[change.invoiceId];
      if (!inv) throw new QuickBooksError("validation", "Invalid Reference Id: the invoice is missing", "2500");
      c.invoices[change.invoiceId] = { ...inv, balanceCents: inv.balanceCents - change.amountCents, syncToken: bump(inv.syncToken), updatedAt: at };
      c.payments[id] = { ...pay, invoiceId: change.invoiceId, amountCents: change.amountCents, syncToken: bump(pay.syncToken) };
      return { id, syncToken: c.payments[id].syncToken };
    });
  }

  deletePayment(id: string, syncToken: string) {
    return this.write((c, at) => {
      const pay = c.payments[id];
      if (!pay) throw new QuickBooksError("validation", "Object Not Found", "610");
      if (pay.syncToken !== syncToken) throw new QuickBooksError("stale", "Stale Object Error", "5010");
      const inv = c.invoices[pay.invoiceId];
      if (inv) c.invoices[pay.invoiceId] = { ...inv, balanceCents: inv.balanceCents + pay.amountCents, syncToken: bump(inv.syncToken), updatedAt: at };
      delete c.payments[id];
    });
  }

  listAccounts() {
    return this.read((c) => Object.values(c.accounts ?? {}));
  }

  createRefundReceipt(p: RefundReceiptPayload, requestId: string) {
    return this.write((c, _at, newId) => {
      const done = c.requests[requestId];
      if (done && c.refundReceipts?.[done]) return { id: done, syncToken: c.refundReceipts[done].syncToken };
      if (!c.items[p.itemId]?.active) throw new QuickBooksError("validation", `Invalid Reference Id: item ${p.itemId} is inactive or missing`, "2500");
      if (!c.accounts?.[p.accountId]?.active) throw new QuickBooksError("validation", `Invalid Reference Id: account ${p.accountId} is inactive or missing`, "2500");
      if (!c.customers[p.customerId]) throw new QuickBooksError("validation", "Invalid Reference Id: the customer is missing", "2500");
      const id = newId();
      c.refundReceipts = { ...(c.refundReceipts ?? {}), [id]: { ...p, id, syncToken: "0" } };
      c.requests[requestId] = id;
      return { id, syncToken: "0" };
    });
  }

  changes(since: Date): Promise<Changes> {
    const from = since.toISOString();
    return this.read((c) => {
      const recent = c.log.filter((e) => e.at >= from);
      const customerIds = new Set(recent.filter((e) => e.entity === "customer").map((e) => e.id));
      return {
        customers: [...customerIds].map((id) => c.customers[id]).filter((x): x is QboCustomer => !!x),
        invoices: recent.filter((e) => e.entity === "invoice").map((e) => ({ id: e.id, deleted: !!e.deleted })),
      };
    });
  }
}
