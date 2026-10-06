import Stripe from "stripe";
import { BillingSignatureError, type BillingEvent, type BillingInvoiceInput, type BillingProvider, type PaymentMethodSummary } from "./provider.ts";

/**
 * Stripe Billing on Aerowise's own Stripe account (never a connected account). Aerowise
 * works out each month's amount itself (count × price, topped up to the minimum, founder
 * prices per organization) and issues it as a Stripe invoice that Stripe collects from the
 * customer's saved payment method. Lines are priced on one Aerowise product when
 * STRIPE_BILLING_PRODUCT_ID is set, and as plain amounts otherwise.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly kind = "stripe";
  private readonly stripe: Stripe;
  private readonly webhookSecrets: string[];
  private readonly productId: string | null;

  constructor(opts: { secretKey: string; webhookSecrets: string[]; productId?: string | null }) {
    this.stripe = new Stripe(opts.secretKey, { maxNetworkRetries: 2, appInfo: { name: "Aerowise Billing" } });
    this.webhookSecrets = opts.webhookSecrets;
    this.productId = opts.productId ?? null;
  }

  async createCustomer(input: { organizationId: string; name: string; email: string | null }) {
    const customer = await this.stripe.customers.create(
      { name: input.name, email: input.email ?? undefined, metadata: { organizationId: input.organizationId } },
      { idempotencyKey: `aerowise-customer-${input.organizationId}` },
    );
    return { customerId: customer.id };
  }

  async createInvoice(input: BillingInvoiceInput) {
    const invoice = await this.stripe.invoices.create(
      {
        customer: input.customerId,
        collection_method: "charge_automatically",
        auto_advance: true,
        // Only the lines added below, never stray pending items on the customer.
        pending_invoice_items_behavior: "exclude",
        description: input.description,
        metadata: input.metadata,
      },
      { idempotencyKey: `${input.idempotencyKey}-invoice` },
    );
    if (!invoice.id) throw new Error("Stripe returned an invoice without an id");
    for (const [i, line] of input.lines.entries()) {
      await this.stripe.invoiceItems.create(
        this.productId
          ? {
              customer: input.customerId,
              invoice: invoice.id,
              description: line.description,
              quantity: line.quantity,
              price_data: { currency: "usd", product: this.productId, unit_amount: line.unitAmountCents },
              metadata: input.metadata,
            }
          : {
              customer: input.customerId,
              invoice: invoice.id,
              description: line.description,
              amount: line.quantity * line.unitAmountCents,
              currency: "usd",
              metadata: input.metadata,
            },
        { idempotencyKey: `${input.idempotencyKey}-line-${i}` },
      );
    }
    const finalized = await this.stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: true }, { idempotencyKey: `${input.idempotencyKey}-finalize` });
    return { invoiceId: invoice.id, status: finalized.status === "paid" ? ("paid" as const) : ("open" as const), hostedUrl: finalized.hosted_invoice_url ?? null };
  }

  async retryInvoice(invoiceId: string) {
    try {
      const invoice = await this.stripe.invoices.pay(invoiceId);
      return { status: invoice.status === "paid" ? ("paid" as const) : ("open" as const) };
    } catch (err) {
      // A declined card (or an invoice Stripe will not retry) leaves it unpaid; anything else is a real error.
      if (err instanceof Stripe.errors.StripeCardError || err instanceof Stripe.errors.StripeInvalidRequestError) return { status: "open" as const };
      throw err;
    }
  }

  async paymentMethod(customerId: string): Promise<PaymentMethodSummary | null> {
    const customer = await this.stripe.customers.retrieve(customerId, { expand: ["invoice_settings.default_payment_method"] });
    if (customer.deleted) return null;
    const pm = customer.invoice_settings.default_payment_method;
    if (!pm || typeof pm === "string") return null;
    if (pm.card) {
      const brand = pm.card.brand === "amex" ? "American Express" : pm.card.brand.charAt(0).toUpperCase() + pm.card.brand.slice(1);
      return { label: brand, last4: pm.card.last4, expires: `${String(pm.card.exp_month).padStart(2, "0")}/${pm.card.exp_year}` };
    }
    if (pm.us_bank_account) return { label: pm.us_bank_account.bank_name ?? "Bank account", last4: pm.us_bank_account.last4 ?? "", expires: null };
    return { label: pm.type, last4: "", expires: null };
  }

  /**
   * Stripe's customer portal, opened straight on updating the payment method; it saves the
   * new method as the default for invoices. The portal must be turned on in Stripe's settings.
   */
  async managePaymentMethod(input: { customerId: string; returnUrl: string }) {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
      flow_data: { type: "payment_method_update" },
    });
    return { url: session.url };
  }

  parseWebhook(rawBody: Buffer | string, signature: string): BillingEvent {
    for (const secret of this.webhookSecrets) {
      try {
        return this.stripe.webhooks.constructEvent(rawBody, signature, secret) as unknown as BillingEvent;
      } catch {
        // Try the next secret (rotating a secret means two are valid for a while).
      }
    }
    throw new BillingSignatureError("Stripe signature did not verify");
  }
}

/** Stripe Billing from the environment, or null when its key is not set. */
export function billingFromEnv(env: Record<string, string | undefined>): StripeBillingProvider | null {
  const secretKey = env.STRIPE_BILLING_SECRET_KEY?.trim();
  if (!secretKey) return null;
  return new StripeBillingProvider({
    secretKey,
    webhookSecrets: (env.STRIPE_BILLING_WEBHOOK_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    productId: env.STRIPE_BILLING_PRODUCT_ID?.trim() || null,
  });
}
