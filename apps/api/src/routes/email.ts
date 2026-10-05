import { applyEmailEvent, EmailWebhookSignatureError, type EmailProvider } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import type { FastifyPluginAsync } from "fastify";
import { HttpError } from "../lib/errors.ts";

/**
 * The mail provider's delivery webhooks (sent, delivered, bounced, complained...). Each
 * is verified against its signature, then recorded on the send it is about.
 */
export const emailRoutes: FastifyPluginAsync<{ db: Database; now: () => Date; provider: EmailProvider | null }> = async (app, { db, now, provider }) => {
  // The signature covers the exact bytes sent, so this route keeps the raw body.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));
  app.post("/webhooks/email", { config: { public: true }, schema: { hide: true } }, async (req, reply) => {
    if (!provider) throw new HttpError(404, "not_found", "No mail provider is configured");
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "bad_signature", "Missing body");
    let event;
    try {
      event = provider.parseWebhook(req.body, req.headers, now());
    } catch (err) {
      if (err instanceof EmailWebhookSignatureError) throw new HttpError(400, "bad_signature", err.message);
      throw err;
    }
    const outcome = await applyEmailEvent(db, provider.name, event, now());
    req.log.info({ emailEvent: event.id, type: event.type, outcome }, "email webhook");
    return reply.send({ received: true, outcome });
  });
};
