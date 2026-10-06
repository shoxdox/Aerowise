import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { WebhookSignatureError } from "./provider.ts";
import { CHECKOUT_LIFETIME_SECONDS, StripeProvider } from "./stripe.ts";

type Call = { url: string; headers: Headers; body: URLSearchParams };

/** A StripeProvider whose requests are answered here instead of by Stripe. */
function fakeStripe(answer: (call: Call) => object, webhookSecrets: string[] = []) {
  const calls: Call[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), headers: new Headers(init?.headers), body: new URLSearchParams(String(init?.body ?? "")) };
    calls.push(call);
    return new Response(JSON.stringify(answer(call)), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
  };
  const provider = new StripeProvider({ secretKey: "sk_test_fake", webhookSecrets, httpClient: Stripe.createFetchHttpClient(fetchFn as typeof fetch) });
  return { provider, calls };
}

const checkoutInput = {
  accountId: "acct_123",
  idempotencyKey: "checkout-inv1-1",
  amountCents: 32500,
  applicationFeeCents: 0,
  description: "Invoice 1001",
  customerEmail: "billing@example.test",
  successUrl: "https://staging.example.test/pay/t/done",
  cancelUrl: "https://staging.example.test/pay/t",
  metadata: { organizationId: "org1", invoiceId: "inv1" },
};

describe("StripeProvider checkout", () => {
  it("opens checkout on the connected account, within Stripe's 24-hour limit, with our idempotency key", async () => {
    const { provider, calls } = fakeStripe((c) => ({ id: "cs_test_1", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test_1", expires_at: Number(c.body.get("expires_at")) }));
    const before = Math.floor(Date.now() / 1000);
    const session = await provider.createCheckout(checkoutInput);

    const call = calls[0]!;
    expect(call.url).toMatch(/\/v1\/checkout\/sessions$/);
    expect(call.headers.get("stripe-account")).toBe("acct_123");
    expect(call.headers.get("idempotency-key")).toBe("checkout-inv1-1");
    const expiresAt = Number(call.body.get("expires_at"));
    // Stripe refuses more than 24 hours on its own clock, so leave room for ours running ahead.
    expect(expiresAt - before).toBeLessThanOrEqual(24 * 3600 - 30 * 60);
    expect(expiresAt - before).toBeGreaterThanOrEqual(CHECKOUT_LIFETIME_SECONDS - 5);
    expect(call.body.get("line_items[0][price_data][unit_amount]")).toBe("32500");
    expect(call.body.get("metadata[invoiceId]")).toBe("inv1");
    expect(call.body.get("payment_intent_data[metadata][invoiceId]")).toBe("inv1");
    expect(session).toEqual({ sessionId: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", expiresAt: new Date(expiresAt * 1000) });
  });

  it("sends no application fee by default, and the platform fee when one is set, for card and bank payments alike", async () => {
    const { provider, calls } = fakeStripe((c) => ({ id: "cs_test_1", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test_1", expires_at: Number(c.body.get("expires_at")) }));
    await provider.createCheckout(checkoutInput);
    expect([...calls[0]!.body.keys()].filter((k) => k.includes("application_fee"))).toEqual([]);
    await provider.createCheckout({ ...checkoutInput, idempotencyKey: "checkout-inv1-2", applicationFeeCents: 812 });
    // On the payment intent, so it applies whichever method the homeowner picks on the page.
    expect(calls[1]!.body.get("payment_intent_data[application_fee_amount]")).toBe("812");
    expect(calls[1]!.headers.get("stripe-account")).toBe("acct_123");
  });

  it("refunds on the connected account with our idempotency key", async () => {
    const { provider, calls } = fakeStripe(() => ({ id: "re_1", object: "refund", status: "pending", failure_reason: null }));
    const refund = await provider.createRefund({ organizationId: "org-1", accountId: "acct_123", idempotencyKey: "refund-1", paymentIntentId: "pi_1", amountCents: 1000, metadata: { refundId: "r1" } });
    expect(refund).toEqual({ refundId: "re_1", status: "pending", failureReason: null });
    expect(calls[0]!.headers.get("stripe-account")).toBe("acct_123");
    expect(calls[0]!.headers.get("idempotency-key")).toBe("refund-1");
    expect(calls[0]!.body.get("payment_intent")).toBe("pi_1");
  });
});

describe("StripeProvider webhooks", () => {
  const stripe = new Stripe("sk_test_fake");
  const payload = JSON.stringify({ id: "evt_1", type: "account.updated", account: "acct_123", livemode: false, created: 1, data: { object: {} } });

  it("accepts an event signed with any configured secret (the platform and Connect endpoints each have one)", () => {
    const { provider } = fakeStripe(() => ({}), ["whsec_platform", "whsec_connect"]);
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_connect" });
    expect(provider.parseWebhook(payload, signature)).toMatchObject({ id: "evt_1", account: "acct_123" });
  });

  it("refuses an event signed with anything else", () => {
    const { provider } = fakeStripe(() => ({}), ["whsec_platform"]);
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_other" });
    expect(() => provider.parseWebhook(payload, signature)).toThrow(WebhookSignatureError);
  });
});
