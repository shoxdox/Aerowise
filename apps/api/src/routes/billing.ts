import { applyBillingEvent, BillingSignatureError, type BillingProvider } from "@aerowise/billing";
import type { Database } from "@aerowise/db";
import type { SubscriptionConfig } from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { HttpError } from "../lib/errors.ts";

/**
 * Stripe Billing's webhook: what companies pay Aerowise. Its own endpoint and signing
 * secret, separate from /webhooks/stripe (Stripe Connect, homeowner payments).
 */
export const billingRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; provider: BillingProvider | null; config: SubscriptionConfig }> = async (
  app,
  { db, now, provider, config },
) => {
  // Stripe signs the exact bytes it sent, so this route reads the raw body.
  app.register(async (hook) => {
    hook.removeContentTypeParser("application/json");
    hook.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
    hook.post("/webhooks/stripe-billing", { config: { public: true }, schema: { hide: true } }, async (req, reply) => {
      if (!provider) throw new HttpError(404, "not_found", "Aerowise billing is not configured");
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string" || !Buffer.isBuffer(req.body)) throw new HttpError(400, "bad_signature", "Missing Stripe signature");
      let event;
      try {
        event = provider.parseWebhook(req.body, signature);
      } catch (err) {
        if (err instanceof BillingSignatureError) throw new HttpError(400, "bad_signature", "Stripe signature did not verify");
        throw err;
      }
      const outcome = await applyBillingEvent(db, event, now(), config);
      req.log.info({ stripeEvent: event.id, type: event.type, outcome }, "stripe billing webhook");
      return reply.send({ received: true, outcome });
    });
  });
};
