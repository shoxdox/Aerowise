import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import type { RefundStatus } from "@aerowise/domain";
import { WebhookSignatureError, type CheckoutInput, type PaymentProvider, type RefundInput, type WebhookEvent } from "./provider.ts";

const TEST_WEBHOOK_SECRET = "whsec_aerowise_test_provider";

const rid = (prefix: string) => `${prefix}_test_${randomBytes(12).toString("hex")}`;

/**
 * Stands in for Stripe in development and tests: no network, no money. Accounts are ready
 * at once, checkout opens Aerowise's own test page, refunds succeed. Webhooks are signed
 * exactly as Stripe signs them, so they go through the same verification and handling.
 * Never used in production.
 */
export class TestPaymentProvider implements PaymentProvider {
  readonly kind = "test";
  private readonly webhooks = new Stripe("sk_test_aerowise_offline").webhooks;
  /** Every checkout page asked for, as Stripe would have been asked. */
  readonly checkouts: CheckoutInput[] = [];

  async createAccount() {
    return { accountId: rid("acct") };
  }

  async accountLink(input: { returnUrl: string }) {
    return { url: input.returnUrl };
  }

  async getAccount() {
    return { chargesEnabled: true, detailsSubmitted: true };
  }

  /** The test checkout page lives under the invoice's pay page, and returns where Stripe would. */
  async createCheckout(input: CheckoutInput) {
    this.checkouts.push(input);
    const sessionId = rid("cs");
    const done = new URL(input.successUrl);
    return {
      sessionId,
      url: `${input.cancelUrl}/test-checkout?session=${sessionId}&done=${encodeURIComponent(done.pathname + done.search)}`,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    };
  }

  /** Checkout pages Aerowise asked to close (a payment recorded by the office, a void). */
  readonly expiredSessions: string[] = [];
  async expireCheckout(input: { sessionId: string }) {
    this.expiredSessions.push(input.sessionId);
  }

  /** Every refund asked for, retries included. */
  readonly refunds: RefundInput[] = [];
  /** What a new refund does: Stripe's answer for card refunds is usually `succeeded`. */
  refundOutcome: RefundStatus = "succeeded";
  /** The next this many refund calls are made, but their answer is lost on the way back. */
  dropRefundResponses = 0;
  private readonly refundByKey = new Map<string, { refundId: string; status: RefundStatus }>();

  /** As Stripe does, a repeated idempotency key returns the refund the first call made. */
  async createRefund(input: RefundInput) {
    this.refunds.push(input);
    let made = this.refundByKey.get(input.idempotencyKey);
    if (!made) {
      made = { refundId: rid("re"), status: this.refundOutcome };
      this.refundByKey.set(input.idempotencyKey, made);
    }
    if (this.dropRefundResponses > 0) {
      this.dropRefundResponses--;
      throw new Error("test payment provider: the refund was made but its answer was lost");
    }
    return { refundId: made.refundId, status: made.status, failureReason: made.status === "failed" ? "Declined by the test provider" : null };
  }

  /** The refund a key made, as Stripe would have it. */
  refundIdFor(idempotencyKey: string) {
    return this.refundByKey.get(idempotencyKey)?.refundId ?? null;
  }

  parseWebhook(rawBody: Buffer | string, signature: string): WebhookEvent {
    try {
      return this.webhooks.constructEvent(rawBody, signature, TEST_WEBHOOK_SECRET) as unknown as WebhookEvent;
    } catch {
      throw new WebhookSignatureError("Stripe signature did not verify");
    }
  }

  /** A webhook body and signature header as Stripe would send them. */
  signedEvent(type: string, object: Record<string, unknown>, account: string): { body: string; signature: string; event: WebhookEvent } {
    const event: WebhookEvent = { id: rid("evt"), type, account, livemode: false, created: Math.floor(Date.now() / 1000), data: { object } };
    const body = JSON.stringify({ ...event, object: "event" });
    return { body, signature: this.webhooks.generateTestHeaderString({ payload: body, secret: TEST_WEBHOOK_SECRET }), event };
  }

  static paymentIntentFor(sessionId: string) {
    return sessionId.replace(/^cs_/, "pi_");
  }
}
