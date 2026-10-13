import type { Database } from "@aerowise/db";

/** A failure belongs to its attempt. An open retry may be waiting for a new webhook. */
export async function latestPaymentFailed(db: Database, organizationId: string, invoiceId: string, pendingCents: number, now: Date) {
  if (pendingCents > 0) return false;
  const latest = await db.selectFrom("payments").select(["status", "providerSessionId"])
    .where("organizationId", "=", organizationId).where("invoiceId", "=", invoiceId)
    .orderBy("createdAt", "desc").orderBy("id", "desc").executeTakeFirst();
  if (latest?.status !== "failed") return false;
  // Do not infer a new Checkout outcome from the previous attempt's failure. In particular,
  // Checkout creation precedes the new payment row, and frozen clocks can give attempts
  // identical timestamps. Provider session identity and open state are the durable evidence.
  let outstanding = db.selectFrom("checkoutSessions").select("id")
    .where("organizationId", "=", organizationId).where("invoiceId", "=", invoiceId).where("status", "=", "open")
    // An expiry webhook can be missing. Expired sessions cannot represent an active retry.
    .where("expiresAt", ">", now);
  if (latest.providerSessionId) outstanding = outstanding.where("providerSessionId", "!=", latest.providerSessionId);
  return !(await outstanding.executeTakeFirst());
}
