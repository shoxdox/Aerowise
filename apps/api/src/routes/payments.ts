import type { Database } from "@aerowise/db";
import { amountDue, billingSettings, billingSettingsInput, invoiceSnapshot, publicInvoice, type BillingSettings, type PublicInvoice } from "@aerowise/domain";
import { applyStripeEvent, TestPaymentProvider, WebhookSignatureError } from "@aerowise/payments";
import { queueQuickBooksSync } from "@aerowise/tasks";
import type { ObjectStore } from "@aerowise/storage";
import { activatePaidRenewals } from "@aerowise/renewals";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { canPayOnline, invoiceByToken, notFoundLink, openCheckout } from "../lib/checkout.ts";
import type { PaymentsConfig } from "../lib/invoices.ts";

const token = z.object({ token: z.string().min(20).max(64).regex(/^[A-Za-z0-9_-]+$/) });
const publicLimit = { max: 30, timeWindow: "1 minute" };

/**
 * Billing settings and Stripe Connect for the office, plus the routes customers and
 * Stripe reach without signing in: the pay page, checkout, and the webhook.
 */
export const paymentRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; store: ObjectStore; payments: PaymentsConfig; testCheckout: boolean }> = async (
  app,
  { db, now, store, payments, testCheckout },
) => {
  const { provider, appUrl } = payments;
  const providerKind = (): BillingSettings["provider"] => (provider ? (provider.kind === "test" ? "test" : "stripe") : "none");

  async function settings(organizationId: string): Promise<BillingSettings> {
    const o = await db
      .selectFrom("organizations")
      .select(["invoiceTermsDays", "defaultTaxRateBps", "stripeAccountId", "stripeChargesEnabled", "stripeDetailsSubmitted"])
      .where("id", "=", organizationId)
      .executeTakeFirstOrThrow();
    return {
      invoiceTermsDays: o.invoiceTermsDays,
      defaultTaxRateBps: o.defaultTaxRateBps,
      provider: providerKind(),
      stripe: { accountId: o.stripeAccountId, chargesEnabled: o.stripeChargesEnabled, detailsSubmitted: o.stripeDetailsSubmitted },
    };
  }

  app.get(
    "/billing/settings",
    { config: { permission: "invoices:read" }, schema: { tags: ["billing"], summary: "Invoice defaults and whether online payments are set up", response: { 200: billingSettings } } },
    async (req) => settings(req.requireAuth().organizationId),
  );

  app.patch(
    "/billing/settings",
    {
      config: { permission: "billing:manage" },
      schema: { tags: ["billing"], summary: "Change payment terms and the default sales tax rate for new invoices", body: billingSettingsInput.partial(), response: { 200: billingSettings } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("organizations").set(req.body).where("id", "=", organizationId).execute();
        await audit(trx, req, { action: "billing.settings_changed", entityType: "organization", entityId: organizationId, changes: req.body });
      });
      return settings(organizationId);
    },
  );

  app.post(
    "/billing/stripe/connect",
    {
      config: { permission: "billing:manage" },
      schema: {
        tags: ["billing"],
        summary: "Start or continue setting up the provider's Stripe account",
        description: "Returns the Stripe page to open. Customers' payments settle to this account.",
        body: z.object({}).optional(),
        response: { 200: z.object({ url: z.string() }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      if (!provider) throw unprocessable("Online payments are not configured on this server (STRIPE_SECRET_KEY)");
      const org = await db.selectFrom("organizations").select(["name", "email", "stripeAccountId"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
      let accountId = org.stripeAccountId;
      if (!accountId) {
        accountId = (await provider.createAccount({ organizationId, name: org.name, email: org.email })).accountId;
        await db.transaction().execute(async (trx) => {
          await trx.updateTable("organizations").set({ stripeAccountId: accountId }).where("id", "=", organizationId).where("stripeAccountId", "is", null).execute();
          await audit(trx, req, { action: "billing.stripe_account_created", entityType: "organization", entityId: organizationId, changes: { accountId } });
        });
        accountId = (await db.selectFrom("organizations").select("stripeAccountId").where("id", "=", organizationId).executeTakeFirstOrThrow()).stripeAccountId!;
      }
      const back = `${appUrl.replace(/\/$/, "")}/settings/billing`;
      return provider.accountLink({ accountId, refreshUrl: `${back}?stripe=retry`, returnUrl: `${back}?stripe=done` });
    },
  );

  app.post(
    "/billing/stripe/refresh",
    {
      config: { permission: "billing:manage" },
      schema: { tags: ["billing"], summary: "Ask Stripe whether the account can take payments yet", body: z.object({}).optional(), response: { 200: billingSettings } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const org = await db.selectFrom("organizations").select("stripeAccountId").where("id", "=", organizationId).executeTakeFirstOrThrow();
      if (provider && org.stripeAccountId) {
        const a = await provider.getAccount(org.stripeAccountId);
        await db.updateTable("organizations").set({ stripeChargesEnabled: a.chargesEnabled, stripeDetailsSubmitted: a.detailsSubmitted }).where("id", "=", organizationId).execute();
      }
      return settings(organizationId);
    },
  );

  // ---- Customer pay page (no sign-in; the link is the key) ----

  const byToken = (t: string) => invoiceByToken(db, t);

  app.get(
    "/pay/:token",
    {
      config: { public: true, rateLimit: publicLimit },
      schema: { tags: ["pay"], summary: "What the customer sees from their pay link", params: token, response: { 200: publicInvoice } },
    },
    async (req): Promise<PublicInvoice> => {
      const inv = await byToken(req.params.token);
      const s = invoiceSnapshot.parse(inv.snapshot);
      const verify = await db
        .selectFrom("payments")
        .select("bankVerificationUrl")
        .where("organizationId", "=", inv.organizationId)
        .where("invoiceId", "=", inv.id)
        .where("status", "=", "pending")
        .where("bankVerificationUrl", "is not", null)
        .orderBy("createdAt", "desc")
        .executeTakeFirst();
      return {
        number: s.number,
        status: inv.status,
        paymentStatus: inv.paymentStatus,
        issuedOn: s.issuedOn,
        dueOn: s.dueOn,
        provider: { name: s.provider.name, phone: s.provider.phone, email: s.provider.email },
        customerName: s.billTo.name,
        serviceAddress: s.serviceAddress,
        memo: s.memo,
        lines: s.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents })),
        subtotalCents: s.subtotalCents,
        discountCents: s.discountCents,
        taxCents: s.taxCents,
        totalCents: s.totalCents,
        paidCents: inv.paidCents,
        pendingCents: inv.pendingCents,
        creditedCents: inv.creditedCents,
        amountDueCents: amountDue(inv),
        canPayOnline: canPayOnline(provider, inv),
        bankVerificationUrl: verify?.bankVerificationUrl ?? null,
        pdfReady: !!inv.pdfStorageKey,
        testMode: provider?.kind === "test",
      };
    },
  );

  app.get(
    "/pay/:token/pdf",
    { config: { public: true, rateLimit: publicLimit }, schema: { tags: ["pay"], summary: "The invoice PDF, for the customer", params: token } },
    async (req, reply) => {
      const inv = await byToken(req.params.token);
      const data = inv.pdfStorageKey ? await store.get(inv.pdfStorageKey) : null;
      if (!data) throw new HttpError(404, "not_ready", "The PDF is still being prepared. Try again in a minute.");
      const s = invoiceSnapshot.parse(inv.snapshot);
      return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${s.number}.pdf"`).send(data);
    },
  );

  app.post(
    "/pay/:token/checkout",
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["pay"],
        summary: "Open a Stripe Checkout page for what is still due",
        description: "An open page for the same amount is reused, so pressing Pay twice does not make two payable pages.",
        params: token,
        body: z.object({}).optional(),
        response: { 200: z.object({ url: z.string() }) },
      },
    },
    async (req) => openCheckout(db, { provider, appUrl, token: req.params.token, inv: await byToken(req.params.token), now: now() }),
  );

  // ---- Stripe webhook ----

  await app.register(async (hook) => {
    // The signature covers the exact bytes Stripe sent, so this route keeps the raw body.
    hook.removeContentTypeParser("application/json");
    hook.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
    hook.post(
      "/webhooks/stripe",
      { config: { public: true }, schema: { hide: true } },
      async (req, reply) => {
        if (!provider) throw new HttpError(404, "not_found", "Online payments are not configured");
        const signature = req.headers["stripe-signature"];
        if (typeof signature !== "string" || !Buffer.isBuffer(req.body)) throw new HttpError(400, "bad_signature", "Missing Stripe signature");
        let event;
        try {
          event = provider.parseWebhook(req.body, signature);
        } catch (err) {
          if (err instanceof WebhookSignatureError) throw new HttpError(400, "bad_signature", "Stripe signature did not verify");
          throw err;
        }
        const outcome = await applyStripeEvent(db, event, now());
        // A cleared payment goes on to QuickBooks.
        const applied = await db.selectFrom("stripeEvents").select("organizationId").where("id", "=", event.id).executeTakeFirst();
        if (applied?.organizationId) {
          await queueQuickBooksSync(db, applied.organizationId, now());
          // A renewal waiting on this payment becomes the next contract.
          await activatePaidRenewals(db, { organizationId: applied.organizationId }, now());
        }
        req.log.info({ stripeEvent: event.id, type: event.type, outcome }, "stripe webhook");
        return reply.send({ received: true, outcome });
      },
    );
  });

  // ---- Test checkout (development and the demo only) ----

  if (provider instanceof TestPaymentProvider && testCheckout) {
    const test = provider;
    app.post(
      "/pay/:token/test-checkout",
      {
        config: { public: true, rateLimit: publicLimit },
        schema: {
          tags: ["pay"],
          summary: "Finish a test checkout (development only)",
          description:
            "Plays the webhooks Stripe would send for the chosen outcome, signed and delivered through the same handler. " +
            "`ach_pending` leaves a bank payment clearing; `ach_clears` and `ach_fails` settle it.",
          params: token,
          body: z.object({ sessionId: z.string().min(1).max(200), outcome: z.enum(["card", "declined", "ach_pending", "ach_clears", "ach_fails"]) }),
          response: { 200: z.object({ ok: z.boolean(), message: z.string() }) },
        },
      },
      async (req) => {
        const inv = await db
          .selectFrom("invoices as i")
          .innerJoin("organizations as o", "o.id", "i.organizationId")
          .select(["i.id", "i.organizationId", "o.stripeAccountId"])
          .where("i.publicToken", "=", req.params.token)
          .executeTakeFirst();
        if (!inv?.stripeAccountId) throw notFoundLink();
        const session = await db
          .selectFrom("checkoutSessions")
          .selectAll()
          .where("invoiceId", "=", inv.id)
          .where("providerSessionId", "=", req.body.sessionId)
          .executeTakeFirst();
        if (!session) throw notFound("Checkout");
        const { outcome } = req.body;
        if (outcome === "declined") return { ok: false, message: "Your card was declined. Try another card." };
        const object = (paid: boolean) => ({
          id: session.providerSessionId,
          object: "checkout.session",
          status: "complete",
          payment_status: paid ? "paid" : "unpaid",
          payment_intent: TestPaymentProvider.paymentIntentFor(session.providerSessionId),
          amount_total: session.amountCents,
          metadata: { organizationId: inv.organizationId, invoiceId: inv.id },
        });
        const events =
          outcome === "card"
            ? [test.signedEvent("checkout.session.completed", object(true), inv.stripeAccountId)]
            : [
                test.signedEvent("checkout.session.completed", object(false), inv.stripeAccountId),
                ...(outcome === "ach_clears" ? [test.signedEvent("checkout.session.async_payment_succeeded", object(true), inv.stripeAccountId)] : []),
                ...(outcome === "ach_fails" ? [test.signedEvent("checkout.session.async_payment_failed", object(false), inv.stripeAccountId)] : []),
              ];
        for (const e of events) {
          const res = await app.inject({ method: "POST", url: "/webhooks/stripe", payload: e.body, headers: { "content-type": "application/json", "stripe-signature": e.signature } });
          if (res.statusCode !== 200) throw new Error(`test webhook failed: ${res.statusCode} ${res.body}`);
        }
        return { ok: true, message: outcome === "card" ? "Payment received." : outcome === "ach_fails" ? "The bank payment failed." : outcome === "ach_clears" ? "The bank payment cleared." : "Bank payment started." };
      },
    );
  }
};
