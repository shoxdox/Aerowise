import { z } from "zod";
import { addDays, addMonths, daysBetween } from "./schedule.ts";

// What a maintenance company pays Aerowise (the brief's "Aerowise billing"). This is
// separate from `plans`, which are the service plans a company sells to homeowners, and
// from Stripe Connect, which is how homeowners pay the company.

export const SUBSCRIPTION_STATES = ["design_partner", "trial", "active", "past_due", "read_only"] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

export const SUBSCRIPTION_STATE_LABELS: Record<SubscriptionState, string> = {
  design_partner: "Design partner",
  trial: "Trial",
  active: "Active",
  past_due: "Past due",
  read_only: "Read-only",
};

/** Free periods have an end date; paid and lapsed states do not need one. */
export const FREE_STATES: readonly SubscriptionState[] = ["design_partner", "trial"];

/**
 * Where each state may go next. Staying in the same state (to change dates or the price)
 * is always allowed. A lapsed account comes back by paying (active) or by being given a
 * new free period; a paying account never goes back to a free period.
 */
export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionState, readonly SubscriptionState[]> = {
  design_partner: ["trial", "active", "read_only"],
  trial: ["design_partner", "active", "read_only"],
  active: ["past_due", "read_only"],
  past_due: ["active", "read_only"],
  read_only: ["design_partner", "trial", "active"],
};

export function canChangePlan(from: SubscriptionState, to: SubscriptionState): boolean {
  return from === to || SUBSCRIPTION_TRANSITIONS[from].includes(to);
}

/** A read-only organization can read and export everything but change nothing. */
export const isReadOnly = (state: SubscriptionState) => state === "read_only";

/**
 * Prices, minimums and free-period lengths. These are starting assumptions from the
 * brief, set per deployment through the environment, never hard-coded in billing logic.
 */
export interface SubscriptionConfig {
  trialDays: number;
  designPartnerDays: number;
  pricePerContractCents: number;
  monthlyMinimumCents: number;
}

export const DEFAULT_SUBSCRIPTION_CONFIG: SubscriptionConfig = {
  trialDays: 30,
  designPartnerDays: 90,
  pricePerContractCents: 150,
  monthlyMinimumCents: 9900,
};

const CONFIG_ENV: Record<keyof SubscriptionConfig, string> = {
  trialDays: "AEROWISE_TRIAL_DAYS",
  designPartnerDays: "AEROWISE_DESIGN_PARTNER_DAYS",
  pricePerContractCents: "AEROWISE_PRICE_PER_CONTRACT_CENTS",
  monthlyMinimumCents: "AEROWISE_MONTHLY_MINIMUM_CENTS",
};

/** Aerowise's own prices and free-period lengths from the environment; unset values use the defaults. */
export function subscriptionConfigFromEnv(env: Record<string, string | undefined>): SubscriptionConfig {
  const config = { ...DEFAULT_SUBSCRIPTION_CONFIG };
  for (const [field, key] of Object.entries(CONFIG_ENV) as [keyof SubscriptionConfig, string][]) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a whole number, got "${raw}"`);
    config[field] = Number(raw);
  }
  return config;
}

const cents = z.number().int().min(0).max(10_000_000);

export const subscriptionPlan = z.object({
  state: z.enum(SUBSCRIPTION_STATES),
  startsOn: z.iso.date(),
  endsOn: z.iso.date().nullable(),
  /** Founder price per active contract per month; null uses the configured price. */
  pricePerContractCentsOverride: cents.nullable(),
  /** Founder monthly minimum; null uses the configured minimum. */
  monthlyMinimumCentsOverride: cents.nullable(),
});
export type SubscriptionPlan = z.infer<typeof subscriptionPlan>;

/** The full plan as an admin sets it. Dates and the state must agree. */
export const subscriptionPlanInput = subscriptionPlan.superRefine((plan, ctx) => {
  for (const problem of planProblems(plan)) ctx.addIssue({ code: "custom", path: [problem.path], message: problem.message });
});

export function planProblems(plan: Pick<SubscriptionPlan, "state" | "startsOn" | "endsOn">): { path: "endsOn"; message: string }[] {
  if (FREE_STATES.includes(plan.state) && !plan.endsOn) return [{ path: "endsOn", message: "A trial or design-partner period needs an end date" }];
  if (plan.endsOn && plan.endsOn < plan.startsOn) return [{ path: "endsOn", message: "The end date is before the start date" }];
  return [];
}

/** A new organization's plan: a trial or a design-partner period starting today. */
export function initialPlan(kind: "trial" | "design_partner", today: string, config: SubscriptionConfig): SubscriptionPlan {
  const days = kind === "trial" ? config.trialDays : config.designPartnerDays;
  return {
    state: kind,
    startsOn: today,
    endsOn: addDays(today, days),
    pricePerContractCentsOverride: null,
    monthlyMinimumCentsOverride: null,
  };
}

/** The price this organization pays once it is paying: its founder price, else the configured one. */
export function effectivePrice(plan: Pick<SubscriptionPlan, "pricePerContractCentsOverride" | "monthlyMinimumCentsOverride">, config: SubscriptionConfig) {
  return {
    pricePerContractCents: plan.pricePerContractCentsOverride ?? config.pricePerContractCents,
    monthlyMinimumCents: plan.monthlyMinimumCentsOverride ?? config.monthlyMinimumCents,
  };
}

/** States that pay for the month. Free periods pay nothing; a read-only account is not charged. */
export const BILLABLE_STATES: readonly SubscriptionState[] = ["active", "past_due"];

/**
 * One month's charge: every active contract at the organization's price, topped up to the
 * monthly minimum when that comes to less.
 */
export function monthlyCharge(activeContracts: number, price: { pricePerContractCents: number; monthlyMinimumCents: number }) {
  const usageCents = activeContracts * price.pricePerContractCents;
  const totalCents = Math.max(usageCents, price.monthlyMinimumCents);
  return { usageCents, minimumTopUpCents: totalCents - usageCents, totalCents };
}

/** The calendar month a date falls in: Aerowise bills each month on its first day. */
export function billingMonth(date: string): { startsOn: string; endsOn: string } {
  const startsOn = `${date.slice(0, 7)}-01`;
  return { startsOn, endsOn: addDays(addMonths(startsOn, 1), -1) };
}

/** Days until a free period ends (0 on its last day, negative after), or null when it has no end. */
export function daysLeft(plan: Pick<SubscriptionPlan, "endsOn">, today: string): number | null {
  return plan.endsOn ? daysBetween(today, plan.endsOn) : null;
}

/** What the signed-in company sees about its own plan. */
export const organizationSubscription = z.object({
  state: z.enum(SUBSCRIPTION_STATES),
  endsOn: z.iso.date().nullable(),
  readOnly: z.boolean(),
});
export type OrganizationSubscription = z.infer<typeof organizationSubscription>;

export const READ_ONLY_MESSAGE =
  "This account is read-only because its Aerowise plan has lapsed. You can still view and export everything. The owner can reactivate it under Subscription.";

/** The owner's subscription page: what the company pays Aerowise. */
export const subscriptionOverview = z.object({
  plan: z.object({
    state: z.enum(SUBSCRIPTION_STATES),
    startsOn: z.iso.date(),
    endsOn: z.iso.date().nullable(),
    /** Days until a free period ends; null when it has no end. */
    daysLeft: z.number().int().nullable(),
    readOnly: z.boolean(),
  }),
  price: z.object({ pricePerContractCents: z.number().int(), monthlyMinimumCents: z.number().int(), founder: z.boolean() }),
  /** At today's count of active contracts. `charged` is false during a free period or while read-only. */
  estimate: z.object({ countedOn: z.iso.date(), activeContracts: z.number().int(), amountCents: z.number().int(), charged: z.boolean() }),
  /** Where invoices are charged; null when nothing is saved yet. */
  paymentMethod: z.object({ label: z.string(), last4: z.string(), expires: z.string().nullable() }).nullable(),
  /** `none`: this server cannot take payment for Aerowise yet. `test`: the built-in stand-in. */
  provider: z.enum(["stripe", "test", "none"]),
  invoices: z.array(
    z.object({
      id: z.uuid(),
      startsOn: z.iso.date(),
      endsOn: z.iso.date(),
      activeContracts: z.number().int(),
      pricePerContractCents: z.number().int(),
      monthlyMinimumCents: z.number().int(),
      amountCents: z.number().int(),
      status: z.enum(["free", "pending", "open", "paid", "failed", "void"]),
      hostedInvoiceUrl: z.string().nullable(),
    }),
  ),
});
export type SubscriptionOverview = z.infer<typeof subscriptionOverview>;
