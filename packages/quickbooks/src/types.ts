// What Aerowise needs from a QuickBooks Online company, in Aerowise's own terms. The
// Intuit client translates to and from QuickBooks' JSON; the test company keeps these
// shapes as they are.

export interface Address {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

export interface QboCustomer {
  id: string;
  /** QuickBooks' version of the record. It changes on every edit there. */
  syncToken: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: Address | null;
  active: boolean;
  updatedAt: string | null;
}

export interface CustomerPayload {
  displayName: string;
  email: string | null;
  phone: string | null;
  address: Address | null;
}

/** An account money can leave from for a refund: a bank account, or Undeposited Funds and other clearing accounts. */
export interface QboAccount {
  id: string;
  name: string;
  /** QuickBooks' AccountType, e.g. "Bank" or "Other Current Asset". */
  type: string;
  active: boolean;
}

/** A sales tax code: TAX and NON for lines, or a code (rate) an invoice is taxed at. */
export interface QboTaxCode {
  id: string;
  name: string;
  taxable: boolean;
  active: boolean;
}

export interface QboItem {
  id: string;
  name: string;
  type: string;
  active: boolean;
}

export interface QboInvoice {
  id: string;
  syncToken: string;
  docNumber: string | null;
  customerId: string;
  customerName: string | null;
  totalCents: number;
  /** TxnTaxDetail.TotalTax: the sales tax QuickBooks has on it. */
  taxCents: number;
  balanceCents: number;
  /** QuickBooks keeps a voided invoice, at zero, with "Voided" in its note. */
  voided: boolean;
  updatedAt: string | null;
}

export interface InvoicePayload {
  customerId: string;
  docNumber: string;
  txnDate: string;
  dueDate: string;
  /** `taxCodeRef` only with tax mode on: the line's TAX or NON code. Left out, the payload is what it was before tax mode. */
  lines: { itemId: string; description: string; quantity: number; unitPriceCents: number; amountCents: number; taxCodeRef?: string }[];
  discountCents: number;
  /** Only with tax mode on: the invoice's sales tax code and Aerowise's tax total (TxnTaxDetail). */
  txnTax?: { taxCodeRef: string; totalTaxCents: number };
  memo: string | null;
  privateNote: string;
  billEmail: string | null;
  shipAddress: Address | null;
}

export interface PaymentPayload {
  customerId: string;
  invoiceId: string;
  amountCents: number;
  txnDate: string;
  reference: string | null;
  privateNote: string;
}

export interface QboPayment {
  id: string;
  syncToken: string;
  amountCents: number;
  /** The invoices it pays, and how much of it goes to each. */
  applied: { invoiceId: string; amountCents: number }[];
}

/** A refund recorded on its own; the original payment stays as it is. */
export interface RefundReceiptPayload {
  customerId: string;
  /** The item whose income account the refund reduces. */
  itemId: string;
  amountCents: number;
  description: string;
  txnDate: string;
  /** Where the money leaves from. */
  accountId: string;
  paymentType: "CreditCard" | "Check" | "Cash" | "Other";
  reference: string | null;
  privateNote: string;
}

export interface PaymentChange {
  invoiceId: string;
  amountCents: number;
  privateNote: string;
}

export interface Changes {
  customers: QboCustomer[];
  /** Invoices changed since, with the ones deleted in QuickBooks marked. */
  invoices: { id: string; deleted: boolean }[];
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
}

/** One QuickBooks company, reached with a current access token. */
export interface QuickBooksCompany {
  companyName(): Promise<string | null>;
  /** Every active customer. */
  listCustomers(): Promise<QboCustomer[]>;
  /** Active customers that could be this one: names sharing a word, or the same email. */
  findCustomers(name: string, email: string | null): Promise<QboCustomer[]>;
  /** Null when there is no such customer. Inactive customers are returned with active false. */
  getCustomer(id: string): Promise<QboCustomer | null>;
  /** `requestId` makes a retried create return the first result instead of a duplicate. */
  createCustomer(payload: CustomerPayload, requestId: string): Promise<QboCustomer>;
  updateCustomer(id: string, syncToken: string, payload: CustomerPayload): Promise<QboCustomer>;
  /** Products and services, active and not. */
  listItems(): Promise<QboItem[]>;
  getItem(id: string): Promise<QboItem | null>;
  /** Sales tax codes, active and not. */
  listTaxCodes(): Promise<QboTaxCode[]>;
  findInvoiceByNumber(docNumber: string): Promise<QboInvoice | null>;
  /** Null when the invoice was deleted. */
  getInvoice(id: string): Promise<QboInvoice | null>;
  createInvoice(payload: InvoicePayload, requestId: string): Promise<QboInvoice>;
  voidInvoice(id: string, syncToken: string): Promise<QboInvoice>;
  createPayment(payload: PaymentPayload, requestId: string): Promise<{ id: string; syncToken: string }>;
  /** Null when the payment was deleted. */
  getPayment(id: string): Promise<QboPayment | null>;
  /** Changes what a payment applies to its invoice, as after a partial refund. */
  updatePayment(id: string, syncToken: string, change: PaymentChange): Promise<{ id: string; syncToken: string }>;
  deletePayment(id: string, syncToken: string): Promise<void>;
  /** Bank and other current asset accounts, active and not: where refunds can be paid from. */
  listAccounts(): Promise<QboAccount[]>;
  /** `requestId` makes a retried create return the first result instead of a duplicate. */
  createRefundReceipt(payload: RefundReceiptPayload, requestId: string): Promise<{ id: string; syncToken: string }>;
  /** What changed in QuickBooks since a moment (at most 30 days back). */
  changes(since: Date): Promise<Changes>;
}

export interface QuickBooksProvider {
  /** `intuit` is the real QuickBooks Online; `test` is the built-in stand-in company. */
  readonly kind: "intuit" | "test";
  readonly environment: "test" | "sandbox" | "production";
  /** Intuit's sign-in and consent page. QuickBooks sends the browser back to `redirectUri`. */
  authorizeUrl(input: { state: string; redirectUri: string; organizationId: string }): string;
  /** `organizationId` is the company from the signed state: who is connecting. */
  exchangeCode(input: { code: string; realmId: string; redirectUri: string; organizationId: string }): Promise<Tokens>;
  /** QuickBooks rotates the refresh token: always store the new one. */
  // `organizationId` on each call is the company whose connection it is: a demo company only ever reaches the stand-in.
  refresh(refreshToken: string, organizationId: string): Promise<Tokens>;
  revoke(refreshToken: string, organizationId: string): Promise<void>;
  company(realmId: string, accessToken: string, organizationId: string): QuickBooksCompany;
  /** Set on a gate in front of several providers (demo companies): the one this company actually uses. */
  forOrganization?(organizationId: string): Promise<QuickBooksProvider>;
}

export type QuickBooksErrorKind =
  /** The connection is no longer authorized; someone has to connect again. */
  | "auth"
  /** Worth retrying by itself: network trouble, throttling, QuickBooks having a bad moment. */
  | "transient"
  /** QuickBooks refused the record; a person has to change something. */
  | "validation"
  /** Another customer (or vendor or employee) already has this display name. */
  | "duplicate_name"
  /** The record was edited in QuickBooks since we read it. */
  | "stale";

export class QuickBooksError extends Error {
  constructor(
    readonly kind: QuickBooksErrorKind,
    message: string,
    readonly code?: string,
    /** Intuit's id for the request (the intuit_tid header), which Intuit support asks for. */
    readonly intuitTid?: string,
  ) {
    super(intuitTid ? `${message} (Intuit ref ${intuitTid})` : message);
  }
}
