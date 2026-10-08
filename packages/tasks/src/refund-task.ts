import type { Database } from "@aerowise/db";
import { pushReservedRefund, unsentRefunds, type PaymentProvider } from "@aerowise/payments";
import { enqueue } from "./queue.ts";

/**
 * Refunds Aerowise reserved but whose provider call never happened or whose answer was lost
 * (service workflows plan §3.6, "Lost response"): asked for again with the same key, so the
 * provider returns the refund it already made instead of a second one.
 */
export const RECONCILE_REFUNDS = "payments.reconcile_refunds";

/** How long a reservation waits for its own request to finish before this takes over. */
export const RECONCILE_AFTER_MS = 5 * 60_000;

export async function scheduleRefundReconcile(db: Database, now: Date, intervalMs: number) {
  await enqueue(db, { kind: RECONCILE_REFUNDS, organizationId: null, payload: {}, dedupeKey: `${RECONCILE_REFUNDS}:${Math.floor(now.getTime() / intervalMs)}`, runAt: now, maxAttempts: 1 });
}

export async function reconcileRefunds(db: Database, provider: PaymentProvider | null, now: () => Date) {
  if (!provider) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  let last: unknown = null;
  for (const r of await unsentRefunds(db, new Date(now().getTime() - RECONCILE_AFTER_MS))) {
    try {
      if ((await pushReservedRefund(db, provider, r.organizationId, r.id, now)) === "sent") sent++;
    } catch (err) {
      // One refund the provider refuses does not hold up the rest; the next run tries it again.
      failed++;
      last = err;
    }
  }
  if (last) throw last;
  return { sent, failed };
}
