import { z } from "zod";
import { id } from "./crm.ts";
import { MAX_CENTS } from "./invoices.ts";

// Estimate deposits (SW-5 part 2; service workflows plan §3.6). An accepted estimate that
// asks for a deposit gets one deposit invoice. Its money sits on an append-only ledger and is
// applied to the final invoice, kept under the estimate's terms or refunded. Refunds Aerowise
// starts are reserved first and booked only when the provider says the money moved.

const amount = z.number().int().min(1).max(MAX_CENTS);
const reason = z.string().trim().min(1).max(2000);
const datetime = z.iso.datetime({ offset: true });

export const DEPOSIT_LEDGER_KINDS = [
  "received",
  "refunded",
  "refunded_external",
  "applied",
  "unapplied",
  "retained",
  "retain_reversed",
  "shortfall",
  "shortfall_released",
  "deposit_reversal",
] as const;
export type DepositLedgerKindName = (typeof DEPOSIT_LEDGER_KINDS)[number];
export const DEPOSIT_LEDGER_LABELS: Record<DepositLedgerKindName, string> = {
  received: "Payment received",
  refunded: "Refunded",
  refunded_external: "Refunded outside Aerowise",
  applied: "Applied to the final invoice",
  unapplied: "Taken back when the final invoice was voided",
  retained: "Kept under the estimate's terms",
  retain_reversed: "Keeping reversed",
  shortfall: "Shortfall",
  shortfall_released: "Shortfall released",
  deposit_reversal: "Returned with the job refund",
};

/** Refund free deposit money to the customer. */
export const depositRefundInput = z.object({ amountCents: amount, reason });
/** Keep free deposit money under the estimate's terms, or put kept money back. */
export const depositRetainInput = z.object({ amountCents: amount, reason });
/** Record how a shortfall was dealt with. */
export const depositShortfallInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("supplemental_invoice"), amountCents: amount, invoiceId: id, reason }),
  z.object({ kind: z.literal("write_off"), amountCents: amount, reason }),
]);
/** "Refund the job": the final invoice's own payments first, then the deposit money applied to it. */
export const refundJobInput = z.object({ amountCents: amount, reason });

export const depositBalancesView = z.object({
  received: z.number().int(),
  returned: z.number().int(),
  applied: z.number().int(),
  retained: z.number().int(),
  reserved: z.number().int(),
  shortfall: z.number().int(),
  free: z.number().int(),
  /** max(0, shortfall − what has been resolved). */
  shortfallOutstanding: z.number().int(),
  /** Resolutions recorded beyond the current shortfall: the office may owe the customer a credit. */
  overResolved: z.number().int(),
});

export const depositView = z.object({
  requestedCents: z.number().int(),
  invoice: z.object({ id, number: z.string().nullable(), status: z.string(), paymentStatus: z.string(), totalCents: z.number().int(), voided: z.boolean() }),
  balances: depositBalancesView,
  finals: z.array(z.object({ id, number: z.string().nullable(), status: z.string(), appliedCents: z.number().int(), reversedCents: z.number().int(), active: z.boolean() })),
  ledger: z.array(z.object({ id, kind: z.enum(DEPOSIT_LEDGER_KINDS), amountCents: z.number().int(), reason: z.string().nullable(), actorName: z.string().nullable(), createdAt: datetime })),
  refunds: z.array(
    z.object({ id, amountCents: z.number().int(), status: z.enum(["pending", "succeeded", "failed"]), reservation: z.string().nullable(), failureReason: z.string().nullable(), reason: z.string().nullable(), createdAt: datetime }),
  ),
  /** Cleared payments on the deposit that can still be refunded, for "Refund the deposit". */
  refundableCents: z.number().int(),
});
export type DepositView = z.infer<typeof depositView>;
