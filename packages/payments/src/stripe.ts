import Stripe from "stripe";
import { refundStatusOf, WebhookSignatureError, type CheckoutInput, type PaymentProvider, type RefundInput, type WebhookEvent } from "./provider.ts";

/** Checkout pages stay payable for a day, Stripe's longest. */
const CHECKOUT_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * Stripe Connect with direct charges: each provider has its own Stripe account (Express),
 * customers pay on it, and the money settles to the provider. Aerowise takes no fee.
 */
export class StripeProvider implements PaymentProvider {
  readonly kind = "stripe";
  private readonly stripe: Stripe;
  private readonly webhookSecrets: string[];

  constructor(opts: { secretKey: string; webhookSecrets: string[] }) {
    this.stripe = new Stripe(opts.secretKey, { maxNetworkRetries: 2, appInfo: { name: "Aerowise" } });
    this.webhookSecrets = opts.webhookSecrets;
  }

  async createAccount(input: { organizationId: string; name: string; email: string | null }) {
    const account = await this.stripe.accounts.create(
      {
        type: "express",
        country: "US",
        email: input.email ?? undefined,
        business_profile: { name: input.name },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true }, us_bank_account_ach_payments: { requested: true } },
        metadata: { organizationId: input.organizationId },
      },
      { idempotencyKey: `account-${input.organizationId}` },
    );
    return { accountId: account.id };
  }

  async accountLink(input: { accountId: string; refreshUrl: string; returnUrl: string }) {
    const link = await this.stripe.accountLinks.create({ account: input.accountId, refresh_url: input.refreshUrl, return_url: input.returnUrl, type: "account_onboarding" });
    return { url: link.url };
  }

  async getAccount(accountId: string) {
    const a = await this.stripe.accounts.retrieve(accountId);
    return { chargesEnabled: a.charges_enabled ?? false, detailsSubmitted: a.details_submitted ?? false };
  }

  async createCheckout(input: CheckoutInput) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        // Which methods appear (card, ACH, wallets) follows the account's payment method settings in Stripe.
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: input.amountCents, product_data: { name: input.description } } }],
        customer_email: input.customerEmail ?? undefined,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_SECONDS,
        metadata: input.metadata,
        payment_intent_data: { description: input.description, metadata: input.metadata },
      },
      { stripeAccount: input.accountId, idempotencyKey: input.idempotencyKey },
    );
    if (!session.url) throw new Error("Stripe returned a checkout session without a URL");
    return { sessionId: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000) };
  }

  async expireCheckout(input: { accountId: string; sessionId: string }) {
    try {
      await this.stripe.checkout.sessions.expire(input.sessionId, {}, { stripeAccount: input.accountId });
    } catch (err) {
      // Already completed or expired: nothing left to close.
      if (err instanceof Stripe.errors.StripeInvalidRequestError) return;
      throw err;
    }
  }

  async createRefund(input: RefundInput) {
    const refund = await this.stripe.refunds.create(
      { payment_intent: input.paymentIntentId, amount: input.amountCents, metadata: input.metadata },
      { stripeAccount: input.accountId, idempotencyKey: input.idempotencyKey },
    );
    return { refundId: refund.id, status: refundStatusOf(refund.status), failureReason: refund.failure_reason ?? null };
  }

  parseWebhook(rawBody: Buffer | string, signature: string): WebhookEvent {
    for (const secret of this.webhookSecrets) {
      try {
        return this.stripe.webhooks.constructEvent(rawBody, signature, secret) as unknown as WebhookEvent;
      } catch {
        // Try the next secret (the platform and Connect endpoints each have their own).
      }
    }
    throw new WebhookSignatureError("Stripe signature did not verify");
  }
}
