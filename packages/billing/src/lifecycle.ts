import type { Database, DB } from "@aerowise/db";
import {
  addDays,
  dateInZone,
  daysLeft,
  effectivePrice,
  FREE_STATES,
  PLAN_REMINDER_DAYS,
  SUBSCRIPTION_STATE_LABELS,
  type SubscriptionConfig,
  type SubscriptionState,
} from "@aerowise/domain";
import type { Transaction } from "kysely";
import type { BillingProvider } from "./provider.ts";

type Executor = Database | Transaction<DB>;

/** How plan reminders are emailed: the same shape as the compliance EmailTransport. */
export interface PlanMail {
  send(message: {
    organizationId: string | null;
    idempotencyKey: string;
    from: string;
    to: string;
    subject: string;
    text: string;
    attachments: { filename: string; contentType: string; content: Buffer }[];
  }): Promise<unknown>;
}

export interface PlanLifecycleContext {
  db: Database;
  provider: BillingProvider | null;
  config: SubscriptionConfig;
  now: Date;
  /** Without it, no reminders are sent (and none are recorded as sent). */
  mail?: { transport: PlanMail; from: string; appUrl: string } | null;
  /**
   * Ask Stripe to charge failed invoices again now. Only when the owner has just changed
   * the payment method; otherwise Stripe's own retry schedule is left to do its work.
   */
  retryFailed?: boolean;
}

export interface PlanLifecycleResult {
  state: SubscriptionState;
  /** The state before, when this run changed it. */
  changedFrom: SubscriptionState | null;
  /** Reminder thresholds (days before the end) recorded by this run. */
  reminded: number[];
}

const PLAN_COLUMNS = [
  "id",
  "name",
  "timezone",
  "subscriptionState",
  "subscriptionStartsOn",
  "subscriptionEndsOn",
  "pricePerContractCentsOverride",
  "monthlyMinimumCentsOverride",
  "billingCustomerId",
] as const;

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Moves an organization's plan along on its own, safe to run as often as you like:
 *
 * - a trial or design-partner period sends the owners a reminder 14, 7 and 1 days before
 *   it ends (once each; a period created late gets one reminder, not three), and when it
 *   has ended goes active if a payment method is saved, read-only if not;
 * - past due goes read-only once its grace period has passed;
 * - read-only or past due goes back to active once nothing is left unpaid and a payment
 *   method is saved.
 *
 * Without a billing provider nothing can be collected, so free periods are left for the
 * Aerowise admin to settle by hand. Every change is recorded in the platform audit log.
 */
export async function runPlanLifecycle(ctx: PlanLifecycleContext, organizationId: string): Promise<PlanLifecycleResult> {
  const { db, provider } = ctx;
  const org = await db.selectFrom("organizations").select(PLAN_COLUMNS).where("id", "=", organizationId).executeTakeFirstOrThrow();
  const today = dateInZone(ctx.now, org.timezone);
  const result: PlanLifecycleResult = { state: org.subscriptionState, changedFrom: null, reminded: [] };
  const hasPaymentMethod = async () => !!(provider && org.billingCustomerId && (await provider.paymentMethod(org.billingCustomerId, organizationId)));

  if (FREE_STATES.includes(org.subscriptionState) && org.subscriptionEndsOn) {
    const left = daysLeft({ endsOn: org.subscriptionEndsOn }, today)!;
    if (left >= 0) {
      if (ctx.mail) result.reminded = await sendPlanReminders(ctx, ctx.mail, org, left, await hasPaymentMethod());
      return result;
    }
    if (!provider) return result;
    const next: SubscriptionState = (await hasPaymentMethod()) ? "active" : "read_only";
    await changePlan(db, org.id, org.subscriptionState, { state: next, startsOn: today, endsOn: null }, `${SUBSCRIPTION_STATE_LABELS[org.subscriptionState].toLowerCase()} ended`);
    return { ...result, state: next, changedFrom: org.subscriptionState };
  }

  if (org.subscriptionState === "past_due" && org.subscriptionEndsOn && org.subscriptionEndsOn < today) {
    await changePlan(db, org.id, "past_due", { state: "read_only", startsOn: today, endsOn: null }, "payment still failing after the grace period");
    org.subscriptionState = "read_only";
    result.state = "read_only";
    result.changedFrom = "past_due";
  }

  if ((org.subscriptionState === "read_only" || org.subscriptionState === "past_due") && provider && (await hasPaymentMethod())) {
    if (ctx.retryFailed) await retryFailedInvoices(db, provider, org.id, ctx.now);
    const unpaid = await unpaidPeriods(db, org.id);
    if (unpaid === 0) {
      await changePlan(db, org.id, org.subscriptionState, { state: "active", startsOn: today, endsOn: null }, "payment method saved and nothing left unpaid");
      return { ...result, state: "active", changedFrom: result.changedFrom ?? org.subscriptionState };
    }
  }
  return result;
}

async function sendPlanReminders(
  ctx: PlanLifecycleContext,
  mail: NonNullable<PlanLifecycleContext["mail"]>,
  org: { id: string; name: string; subscriptionState: SubscriptionState; subscriptionEndsOn: string | null; pricePerContractCentsOverride: number | null; monthlyMinimumCentsOverride: number | null },
  left: number,
  paymentMethodSaved: boolean,
): Promise<number[]> {
  const endsOn = org.subscriptionEndsOn!;
  const due = PLAN_REMINDER_DAYS.filter((d) => d >= left);
  if (due.length === 0) return [];
  const recorded = await ctx.db
    .insertInto("planReminders")
    .values(due.map((daysBefore) => ({ organizationId: org.id, endsOn, daysBefore })))
    .onConflict((oc) => oc.columns(["organizationId", "endsOn", "daysBefore"]).doNothing())
    .returning("daysBefore")
    .execute();
  if (recorded.length === 0) return [];
  const smallest = Math.min(...recorded.map((r) => r.daysBefore));

  const owners = await ctx.db
    .selectFrom("memberships as m")
    .innerJoin("users as u", "u.id", "m.userId")
    .select(["u.id", "u.name", "u.email"])
    .where("m.organizationId", "=", org.id)
    .where("m.role", "=", "owner")
    .where("m.active", "=", true)
    .where("u.active", "=", true)
    .execute();
  const label = org.subscriptionState === "trial" ? "trial" : "design partner period";
  const when = left === 0 ? "today" : left === 1 ? "tomorrow" : `in ${left} days`;
  const price = effectivePrice(org, ctx.config);
  const link = `${mail.appUrl.replace(/\/$/, "")}/settings/subscription`;
  const next = paymentMethodSaved
    ? "Your saved payment method will be charged each month from then on. Nothing else to do."
    : "Add a payment method before then to keep working without interruption. Without one, the account becomes read-only: you can still view and export everything, but not change anything.";
  for (const owner of owners) {
    await mail.transport.send({
      organizationId: org.id,
      idempotencyKey: `plan-reminder-${org.id}-${endsOn}-${smallest}-${owner.id}`,
      from: mail.from,
      to: owner.email,
      subject: `Your Aerowise ${label} ends ${when}`,
      text: [
        `Hi ${owner.name},`,
        "",
        `${org.name}'s Aerowise ${label} ends ${when}, on ${endsOn}.`,
        "",
        `After that, Aerowise is ${dollars(price.pricePerContractCents)} per active contract per month, with a ${dollars(price.monthlyMinimumCents)} monthly minimum.`,
        next,
        "",
        `Your subscription: ${link}`,
      ].join("\n"),
      attachments: [],
    });
  }
  return recorded.map((r) => r.daysBefore).sort((a, b) => b - a);
}

/** Months invoiced and not paid (failed). */
async function unpaidPeriods(db: Executor, organizationId: string) {
  const row = await db
    .selectFrom("billingPeriods")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("organizationId", "=", organizationId)
    .where("status", "=", "failed")
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function retryFailedInvoices(db: Database, provider: BillingProvider, organizationId: string, now: Date) {
  const failed = await db
    .selectFrom("billingPeriods")
    .select(["id", "providerInvoiceId"])
    .where("organizationId", "=", organizationId)
    .where("status", "=", "failed")
    .where("providerInvoiceId", "is not", null)
    .execute();
  for (const period of failed) {
    const { status } = await provider.retryInvoice(period.providerInvoiceId!, organizationId);
    if (status === "paid") {
      await db.updateTable("billingPeriods").set({ status: "paid", updatedAt: now }).where("id", "=", period.id).where("status", "=", "failed").execute();
    }
  }
}

/**
 * Changes the plan state when it is still `from` (a webhook and the worker may race), and
 * records it in the platform audit log with no admin: Aerowise did it on its own.
 */
export async function changePlan(
  db: Executor,
  organizationId: string,
  from: SubscriptionState,
  next: { state: SubscriptionState; startsOn: string; endsOn: string | null },
  reason: string,
): Promise<boolean> {
  const changed = await db
    .updateTable("organizations")
    .set({ subscriptionState: next.state, subscriptionStartsOn: next.startsOn, subscriptionEndsOn: next.endsOn })
    .where("id", "=", organizationId)
    .where("subscriptionState", "=", from)
    .returning("id")
    .executeTakeFirst();
  if (!changed) return false;
  await db
    .insertInto("platformAuditEvents")
    .values({
      adminId: null,
      organizationId,
      action: "organization.plan_changed",
      entityType: "organization",
      entityId: organizationId,
      changes: JSON.stringify({ before: { state: from }, after: next, reason }),
      requestId: null,
    })
    .execute();
  return true;
}

/** The end of the grace period for a payment that failed today. */
export const pastDueUntil = (today: string, config: SubscriptionConfig) => addDays(today, config.pastDueGraceDays);
