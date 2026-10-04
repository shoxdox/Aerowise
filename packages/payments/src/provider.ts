import type { RefundStatus } from "@aerowise/domain";

/**
 * The parts of a Stripe webhook event Aerowise reads. Events arrive from the provider's
 * connected account (Stripe Connect), so `account` says whose money it is.
 */
export interface WebhookEvent {
  id: string;
  type: string;
  account?: string | null;
  livemode: boolean;
  created: number;
  data: { object: Record<string, unknown> };
}

export interface CheckoutInput {
  /** The provider's connected account; the charge is made on it directly. */
  accountId: string;
  /** Stripe replays the first answer for a repeated key, so a retried request opens one page. */
  idempotencyKey: string;
  amountCents: number;
  description: string;
  customerEmail: string | null;
  successUrl: string;
  /** Where "back" goes: the invoice's pay page. */
  cancelUrl: string;
  metadata: { organizationId: string; invoiceId: string };
}

export interface RefundInput {
  accountId: string;
  idempotencyKey: string;
  paymentIntentId: string;
  amountCents: number;
  metadata: Record<string, string>;
}

export interface PaymentProvider {
  /** `stripe` moves real (or Stripe test-mode) money; `test` is the built-in stand-in. */
  readonly kind: "stripe" | "test";
  createAccount(input: { organizationId: string; name: string; email: string | null }): Promise<{ accountId: string }>;
  /** Where the owner finishes setting up their Stripe account. */
  accountLink(input: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<{ url: string }>;
  getAccount(accountId: string): Promise<{ chargesEnabled: boolean; detailsSubmitted: boolean }>;
  createCheckout(input: CheckoutInput): Promise<{ sessionId: string; url: string; expiresAt: Date }>;
  /** Closes a payable page so it can no longer take money. Already closed is fine. */
  expireCheckout(input: { accountId: string; sessionId: string }): Promise<void>;
  createRefund(input: RefundInput): Promise<{ refundId: string; status: RefundStatus; failureReason: string | null }>;
  /** Checks the signature and returns the event; throws if it was not signed by Stripe. */
  parseWebhook(rawBody: Buffer | string, signature: string): WebhookEvent;
}

export class WebhookSignatureError extends Error {}

/** Stripe's refund statuses folded into ours: anything that will not pay out is a failure. */
export function refundStatusOf(status: string | null | undefined): RefundStatus {
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "canceled") return "failed";
  return "pending";
}
