import type { BillingPeriodStatus, Database, DB } from "@aerowise/db";
import { BILLABLE_STATES, billingMonth, dateInZone, effectivePrice, monthlyCharge, type SubscriptionConfig } from "@aerowise/domain";
import type { Transaction } from "kysely";
import type { BillingEvent, BillingLine, BillingProvider } from "./provider.ts";

type Executor = Database | Transaction<DB>;

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Contracts in force on a day: active (a contract with a recorded last day still in the
 * future is active, shown as "Ending") and covering that day. Cancelled contracts and
 * contracts that ended or have not started yet do not count.
 */
export async function countActiveContracts(db: Executor, organizationId: string, on: string): Promise<number> {
  const row = await db
    .selectFrom("contracts")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("organizationId", "=", organizationId)
    .where("status", "=", "active")
    .where("startOn", "<=", on)
    .where("endOn", ">=", on)
    // An ending contract counts until its last day of service, even before the daily sweep ends it.
    .where((eb) => eb.or([eb("serviceEndsOn", "is", null), eb("serviceEndsOn", ">=", on)]))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export interface BillingRunResult {
  periodId: string;
  status: BillingPeriodStatus;
  /** True when this run wrote the month's row (false: it already existed). */
  counted: boolean;
  /** True when this run issued the invoice. */
  invoiced: boolean;
}

/**
 * The monthly run for one organization, safe to call as often as you like. The first call
 * in a month (in the organization's time zone) counts its active contracts on the month's
 * first day and stores the count, price and amount. Any call then invoices a month that
 * still owes an invoice, if a billing provider is configured. A failed invoice attempt
 * leaves the month pending and the next run tries again with the same idempotency key.
 */
export async function runMonthlyBilling(
  db: Database,
  opts: { provider: BillingProvider | null; config: SubscriptionConfig; now: Date },
  organizationId: string,
): Promise<BillingRunResult> {
  const org = await db
    .selectFrom("organizations")
    .select([
      "id",
      "name",
      "email",
      "timezone",
      "subscriptionState",
      "pricePerContractCentsOverride",
      "monthlyMinimumCentsOverride",
      "billingCustomerId",
    ])
    .where("id", "=", organizationId)
    .executeTakeFirstOrThrow();
  const month = billingMonth(dateInZone(opts.now, org.timezone));

  let counted = false;
  let period = await findPeriod(db, organizationId, month.startsOn);
  if (!period) {
    const activeContracts = await countActiveContracts(db, organizationId, month.startsOn);
    const price = effectivePrice(org, opts.config);
    const billable = BILLABLE_STATES.includes(org.subscriptionState);
    const amountCents = billable ? monthlyCharge(activeContracts, price).totalCents : 0;
    const inserted = await db
      .insertInto("billingPeriods")
      .values({
        organizationId,
        startsOn: month.startsOn,
        endsOn: month.endsOn,
        countedOn: month.startsOn,
        activeContracts,
        subscriptionState: org.subscriptionState,
        pricePerContractCents: price.pricePerContractCents,
        monthlyMinimumCents: price.monthlyMinimumCents,
        amountCents,
        status: amountCents > 0 ? "pending" : "free",
      })
      // Two runs at once: the first one's count stands.
      .onConflict((oc) => oc.columns(["organizationId", "startsOn"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    counted = !!inserted;
    period = (await findPeriod(db, organizationId, month.startsOn))!;
  }

  if (period.status !== "pending" || !opts.provider) return { periodId: period.id, status: period.status, counted, invoiced: false };

  const provider = opts.provider;
  const customerId = await ensureBillingCustomer(db, provider, org);
  const invoice = await provider.createInvoice({
    customerId,
    idempotencyKey: `aerowise-billing-${period.id}`,
    description: `Aerowise, ${monthName(period.startsOn)}`,
    lines: invoiceLines(period),
    metadata: { organizationId, billingPeriodId: period.id },
  });
  const updated = await db
    .updateTable("billingPeriods")
    .set({ status: invoice.status, provider: provider.kind, providerInvoiceId: invoice.invoiceId, hostedInvoiceUrl: invoice.hostedUrl, updatedAt: opts.now })
    .where("id", "=", period.id)
    .where("status", "=", "pending")
    .returning("status")
    .executeTakeFirst();
  return { periodId: period.id, status: updated?.status ?? invoice.status, counted, invoiced: true };
}

/** The organization's Stripe Billing customer, made the first time it is needed. */
export async function ensureBillingCustomer(
  db: Database,
  provider: BillingProvider,
  org: { id: string; name: string; email: string | null; billingCustomerId: string | null },
): Promise<string> {
  if (org.billingCustomerId) return org.billingCustomerId;
  const { customerId } = await provider.createCustomer({ organizationId: org.id, name: org.name, email: org.email });
  await db.updateTable("organizations").set({ billingCustomerId: customerId }).where("id", "=", org.id).where("billingCustomerId", "is", null).execute();
  const stored = await db.selectFrom("organizations").select("billingCustomerId").where("id", "=", org.id).executeTakeFirstOrThrow();
  return stored.billingCustomerId!;
}

async function findPeriod(db: Executor, organizationId: string, startsOn: string) {
  return db
    .selectFrom("billingPeriods")
    .select(["id", "status", "startsOn", "activeContracts", "pricePerContractCents", "monthlyMinimumCents", "amountCents"])
    .where("organizationId", "=", organizationId)
    .where("startsOn", "=", startsOn)
    .executeTakeFirst();
}

/** The invoice lines for a month: the contracts, then any top-up to the minimum. */
export function invoiceLines(period: { activeContracts: number; pricePerContractCents: number; monthlyMinimumCents: number; amountCents: number }): BillingLine[] {
  const charge = monthlyCharge(period.activeContracts, period);
  if (charge.totalCents !== period.amountCents) throw new Error("billing period amount does not match its count and price");
  const lines: BillingLine[] = [];
  if (period.activeContracts > 0 && period.pricePerContractCents > 0) {
    lines.push({ description: `Active maintenance contracts at ${dollars(period.pricePerContractCents)} each`, quantity: period.activeContracts, unitAmountCents: period.pricePerContractCents });
  }
  if (charge.minimumTopUpCents > 0) {
    lines.push({ description: `Monthly minimum of ${dollars(period.monthlyMinimumCents)}`, quantity: 1, unitAmountCents: charge.minimumTopUpCents });
  }
  return lines;
}

function monthName(startsOn: string) {
  const [y, m] = startsOn.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

const STATUS_FOR_EVENT: Record<string, BillingPeriodStatus> = {
  "invoice.finalized": "open",
  "invoice.paid": "paid",
  "invoice.payment_failed": "failed",
  "invoice.voided": "void",
  "invoice.marked_uncollectible": "failed",
};

/**
 * Applies a Stripe Billing webhook to the month it invoices. Each event is applied once.
 * A paid invoice stays paid whatever arrives after it. Plan state changes on payment and
 * failure come with the full lifecycle (W4.4).
 */
export async function applyBillingEvent(db: Database, event: BillingEvent, now: Date): Promise<"applied" | "duplicate" | "ignored"> {
  return db.transaction().execute(async (trx) => {
    const fresh = await trx.insertInto("billingEvents").values({ id: event.id, type: event.type, organizationId: null }).onConflict((oc) => oc.column("id").doNothing()).returning("id").executeTakeFirst();
    if (!fresh) return "duplicate";
    const status = STATUS_FOR_EVENT[event.type];
    const invoiceId = typeof event.data.object.id === "string" ? event.data.object.id : null;
    if (!status || !invoiceId) return "ignored";
    const period = await trx.selectFrom("billingPeriods").select(["id", "organizationId", "status"]).where("providerInvoiceId", "=", invoiceId).forUpdate().executeTakeFirst();
    if (!period) return "ignored";
    await trx.updateTable("billingEvents").set({ organizationId: period.organizationId }).where("id", "=", event.id).execute();
    if (period.status === "paid" || period.status === status) return "applied";
    // A failed payment that Stripe retries reopens the invoice; "finalized" never undoes a failure.
    if (status === "open" && period.status === "failed") return "applied";
    await trx.updateTable("billingPeriods").set({ status, updatedAt: now }).where("id", "=", period.id).execute();
    return "applied";
  });
}

/** Months already counted for an organization, newest first. */
export async function billingPeriodsFor(db: Executor, organizationId: string) {
  return db
    .selectFrom("billingPeriods")
    .selectAll()
    .where("organizationId", "=", organizationId)
    .orderBy("startsOn", "desc")
    .execute();
}
