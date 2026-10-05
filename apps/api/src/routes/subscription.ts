import { billingPeriodsFor, countActiveContracts, ensureBillingCustomer, type BillingProvider } from "@aerowise/billing";
import type { Database } from "@aerowise/db";
import {
  BILLABLE_STATES,
  dateInZone,
  daysLeft,
  effectivePrice,
  isReadOnly,
  monthlyCharge,
  subscriptionOverview,
  type SubscriptionConfig,
} from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { unprocessable } from "../lib/errors.ts";

/**
 * The owner's view of what the company pays Aerowise (Stripe Billing). Separate from
 * /billing, which is the company's own Stripe Connect account for homeowner payments.
 */
export const subscriptionRoutes: FastifyPluginAsyncZod<{
  db: Database;
  now: () => Date;
  provider: BillingProvider | null;
  config: SubscriptionConfig;
  appUrl: string;
}> = async (app, { db, now, provider, config, appUrl }) => {
  const loadOrg = (organizationId: string) =>
    db
      .selectFrom("organizations")
      .select([
        "id",
        "name",
        "email",
        "timezone",
        "subscriptionState",
        "subscriptionStartsOn",
        "subscriptionEndsOn",
        "pricePerContractCentsOverride",
        "monthlyMinimumCentsOverride",
        "billingCustomerId",
      ])
      .where("id", "=", organizationId)
      .executeTakeFirstOrThrow();

  app.get(
    "/subscription",
    {
      config: { permission: "subscription:manage" },
      schema: {
        tags: ["subscription"],
        summary: "The company's Aerowise plan, this month's estimate, payment method and invoices",
        response: { 200: subscriptionOverview },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const org = await loadOrg(organizationId);
      const today = dateInZone(now(), org.timezone);
      const price = effectivePrice(org, config);
      const activeContracts = await countActiveContracts(db, organizationId, today);
      const periods = await billingPeriodsFor(db, organizationId);
      return {
        plan: {
          state: org.subscriptionState,
          startsOn: org.subscriptionStartsOn,
          endsOn: org.subscriptionEndsOn,
          daysLeft: daysLeft({ endsOn: org.subscriptionEndsOn }, today),
          readOnly: isReadOnly(org.subscriptionState),
        },
        price: { ...price, founder: org.pricePerContractCentsOverride !== null || org.monthlyMinimumCentsOverride !== null },
        estimate: {
          countedOn: today,
          activeContracts,
          amountCents: monthlyCharge(activeContracts, price).totalCents,
          charged: BILLABLE_STATES.includes(org.subscriptionState),
        },
        paymentMethod: provider && org.billingCustomerId ? await provider.paymentMethod(org.billingCustomerId) : null,
        provider: provider ? provider.kind : ("none" as const),
        invoices: periods.map((p) => ({
          id: p.id,
          startsOn: p.startsOn,
          endsOn: p.endsOn,
          activeContracts: p.activeContracts,
          pricePerContractCents: p.pricePerContractCents,
          monthlyMinimumCents: p.monthlyMinimumCents,
          amountCents: p.amountCents,
          status: p.status,
          hostedInvoiceUrl: p.hostedInvoiceUrl,
        })),
      };
    },
  );

  app.post(
    "/subscription/payment-method",
    {
      // Paying is how a lapsed company gets out of read-only, so it must work while read-only.
      config: { permission: "subscription:manage", allowedWhenReadOnly: true },
      schema: {
        tags: ["subscription"],
        summary: "Open Stripe to add or change the card or bank account Aerowise invoices are charged to",
        body: z.object({}).optional(),
        response: { 200: z.object({ url: z.string() }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      if (!provider) throw unprocessable("Paying for Aerowise online is not set up on this server yet (STRIPE_BILLING_SECRET_KEY)");
      const org = await loadOrg(organizationId);
      const customerId = await ensureBillingCustomer(db, provider, org);
      const page = await provider.managePaymentMethod({ customerId, returnUrl: `${appUrl.replace(/\/$/, "")}/settings/subscription` });
      await audit(db, req, { action: "subscription.payment_method_opened", entityType: "organization", entityId: organizationId });
      return page;
    },
  );
};
