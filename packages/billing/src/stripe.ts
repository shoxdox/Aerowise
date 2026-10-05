import Stripe from "stripe";
import { BillingSignatureError, type BillingEvent, type BillingInvoiceInput, type BillingProvider } from "./provider.ts";

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
