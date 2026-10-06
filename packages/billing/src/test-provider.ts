import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { BillingSignatureError, type BillingEvent, type BillingInvoiceInput, type BillingProvider, type PaymentMethodSummary } from "./provider.ts";

const TEST_WEBHOOK_SECRET = "whsec_aerowise_test_billing";

const rid = (prefix: string) => `${prefix}_test_${randomBytes(12).toString("hex")}`;

/**
 * Stands in for Stripe Billing in development and tests: no network, no money. It keeps
 * the invoices it was asked for, answers a repeated idempotency key with the first answer
 * as Stripe does, and signs webhooks exactly as Stripe signs them. Never used in production.
 */
export class TestBillingProvider implements BillingProvider {
  readonly kind = "test";
  private readonly webhooks = new Stripe("sk_test_aerowise_offline").webhooks;
  readonly customers: { customerId: string; organizationId: string; name: string }[] = [];
  readonly invoices: (BillingInvoiceInput & { invoiceId: string; totalCents: number })[] = [];
  /** Saved payment methods by customer. */
  readonly paymentMethods = new Map<string, PaymentMethodSummary>();
  /** Set to make retried invoices decline, as a card that still does not work would. */
  declineRetries = false;
  /** Invoices collected again through retryInvoice. */
  readonly retried: string[] = [];
  /** Set to make the next calls fail, as a network error would. */
  failNext = 0;

  private maybeFail() {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("Stripe is unreachable (test)");
    }
  }

  async createCustomer(input: { organizationId: string; name: string }) {
    this.maybeFail();
    const existing = this.customers.find((c) => c.organizationId === input.organizationId);
    if (existing) return { customerId: existing.customerId };
    const customerId = rid("cus");
    this.customers.push({ customerId, organizationId: input.organizationId, name: input.name });
    return { customerId };
  }

  async createInvoice(input: BillingInvoiceInput) {
    this.maybeFail();
    const existing = this.invoices.find((i) => i.idempotencyKey === input.idempotencyKey);
    const invoice = existing ?? { ...input, invoiceId: rid("in"), totalCents: input.lines.reduce((sum, l) => sum + l.quantity * l.unitAmountCents, 0) };
    if (!existing) this.invoices.push(invoice);
    return { invoiceId: invoice.invoiceId, status: "open" as const, hostedUrl: `https://invoice.stripe.test/${invoice.invoiceId}` };
  }

  async retryInvoice(invoiceId: string) {
    this.maybeFail();
    this.retried.push(invoiceId);
    return { status: this.declineRetries ? ("open" as const) : ("paid" as const) };
  }

  async paymentMethod(customerId: string) {
    return this.paymentMethods.get(customerId) ?? null;
  }

  /** There is no Stripe page to visit: a test card is saved at once and the owner goes straight back. */
  async managePaymentMethod(input: { customerId: string; returnUrl: string }) {
    this.maybeFail();
    this.paymentMethods.set(input.customerId, { label: "Visa", last4: "4242", expires: "12/2034" });
    const url = new URL(input.returnUrl);
    url.searchParams.set("payment", "test");
    return { url: url.toString() };
  }

  parseWebhook(rawBody: Buffer | string, signature: string): BillingEvent {
    try {
      return this.webhooks.constructEvent(rawBody, signature, TEST_WEBHOOK_SECRET) as unknown as BillingEvent;
    } catch {
      throw new BillingSignatureError("Stripe signature did not verify");
    }
  }

  /** A webhook body and signature header as Stripe would send them. */
  signedEvent(type: string, object: Record<string, unknown>): { body: string; signature: string; event: BillingEvent } {
    const event: BillingEvent = { id: rid("evt"), type, livemode: false, created: Math.floor(Date.now() / 1000), data: { object } };
    const body = JSON.stringify({ ...event, object: "event" });
    return { body, signature: this.webhooks.generateTestHeaderString({ payload: body, secret: TEST_WEBHOOK_SECRET }), event };
  }
}
