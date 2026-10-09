// Stripe Billing: Aerowise charging maintenance companies for Aerowise. This is a separate
// relationship from Stripe Connect (packages/payments), where companies charge homeowners;
// the two never share customers, keys, webhooks or tables.

/** The parts of a Stripe Billing webhook event Aerowise reads. */
export interface BillingEvent {
  id: string;
  type: string;
  livemode: boolean;
  created: number;
  data: { object: Record<string, unknown> };
}

export interface BillingLine {
  description: string;
  quantity: number;
  unitAmountCents: number;
}

export interface BillingInvoiceInput {
  customerId: string;
  /** Stripe replays the first answer for a repeated key, so a retried run invoices once. */
  idempotencyKey: string;
  /** What the invoice says it covers, such as "Aerowise, March 2026". */
  description: string;
  lines: BillingLine[];
  metadata: { organizationId: string; billingPeriodId: string };
  /**
   * The draft an earlier run made for this key before it died (its id was saved through
   * `onCreated`). The provider carries on with that draft instead of making another, which
   * matters once Stripe has forgotten the idempotency keys (after 24 hours).
   */
  existingInvoiceId?: string | null;
  /** Called with the draft's id as soon as it exists and before any line is added, so the caller can save it. */
  onCreated?: (invoiceId: string) => Promise<void>;
}

export type BillingInvoiceStatus = "open" | "paid";

export interface BillingProvider {
  /** `stripe` charges real (or Stripe test-mode) cards; `test` is the built-in stand-in. */
  readonly kind: "stripe" | "test";
  /** One customer per organization, made once (the organization id is the idempotency key). */
  createCustomer(input: { organizationId: string; name: string; email: string | null }): Promise<{ customerId: string }>;
  /** Issues the month's invoice and starts collecting it from the saved payment method. */
  createInvoice(input: BillingInvoiceInput): Promise<{ invoiceId: string; status: BillingInvoiceStatus; hostedUrl: string | null }>;
  /** The card or bank account invoices are charged to, or null when none is saved. */
  paymentMethod(customerId: string, organizationId: string): Promise<PaymentMethodSummary | null>;
  /**
   * Tries to collect a failed invoice again now, from the current payment method. A
   * decline is not an error: the invoice simply stays unpaid.
   */
  retryInvoice(invoiceId: string, organizationId: string): Promise<{ status: "paid" | "open" }>;
  /** A Stripe page where the owner adds or changes the payment method, returning to `returnUrl`. */
  managePaymentMethod(input: { organizationId: string; customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Checks the signature and returns the event; throws if it was not signed by Stripe. */
  parseWebhook(rawBody: Buffer | string, signature: string): BillingEvent;
}

export interface PaymentMethodSummary {
  /** "Visa", "Mastercard", or the bank's name for a US bank account. */
  label: string;
  last4: string;
  /** "MM/YYYY" for a card; null for a bank account. */
  expires: string | null;
}

export class BillingSignatureError extends Error {}
