import type { Database } from "@aerowise/db";
import { invoiceNumberLabel, QUICKBOOKS_CONFLICT_GUIDE, type QuickBooksEntityType, type QuickBooksRecord, type QuickBooksSyncStatus } from "@aerowise/domain";
import { dollars } from "@aerowise/payments";
import { actionsFor, type QuickBooksProvider, type StoredCandidate, type TokenCipher } from "@aerowise/quickbooks";
import { sql } from "kysely";

export interface QuickBooksConfig {
  provider: QuickBooksProvider;
  cipher: TokenCipher;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Sync records with what people call them: the customer's name, the invoice number, the
 * payment amount. `attention` limits to what the conflict center shows.
 */
export async function listQuickBooksRecords(
  db: Database,
  organizationId: string,
  filter: { attention?: boolean; status?: QuickBooksSyncStatus; entityType?: QuickBooksEntityType; entityId?: string; limit?: number },
): Promise<QuickBooksRecord[]> {
  let q = db
    .selectFrom("quickbooksLinks as l")
    .leftJoin("customers as cu", (j) => j.onRef("cu.id", "=", "l.entityId").onRef("cu.organizationId", "=", "l.organizationId").on("l.entityType", "=", "customer"))
    .leftJoin("invoices as iv", (j) => j.onRef("iv.id", "=", "l.entityId").onRef("iv.organizationId", "=", "l.organizationId").on("l.entityType", "=", "invoice"))
    .leftJoin("payments as pm", (j) => j.onRef("pm.id", "=", "l.entityId").onRef("pm.organizationId", "=", "l.organizationId").on("l.entityType", "=", "payment"))
    .leftJoin("invoices as piv", (j) => j.onRef("piv.id", "=", "pm.invoiceId").onRef("piv.organizationId", "=", "pm.organizationId"))
    .leftJoin("refunds as rf", (j) => j.onRef("rf.id", "=", "l.entityId").onRef("rf.organizationId", "=", "l.organizationId").on("l.entityType", "=", "refund"))
    .leftJoin("payments as rp", (j) => j.onRef("rp.id", "=", "rf.paymentId").onRef("rp.organizationId", "=", "rf.organizationId"))
    .leftJoin("invoices as riv", (j) => j.onRef("riv.id", "=", "rp.invoiceId").onRef("riv.organizationId", "=", "rp.organizationId"))
    .leftJoin("plans as pl", (j) => j.onRef("pl.id", "=", "l.entityId").onRef("pl.organizationId", "=", "l.organizationId").on("l.entityType", "=", "plan"))
    .leftJoin("serviceItems as si", (j) => j.onRef("si.id", "=", "l.entityId").onRef("si.organizationId", "=", "l.organizationId").on("l.entityType", "=", "service_item"))
    .leftJoin("customers as c", (j) => j.on(sql<boolean>`c.id = coalesce(cu.id, iv.customer_id, piv.customer_id, riv.customer_id)`).onRef("c.organizationId", "=", "l.organizationId"))
    .selectAll("l")
    .select(["c.id as customerId", "c.displayName as customerName", "iv.number as invoiceNumber", "piv.number as paymentInvoiceNumber", "pm.amountCents as paymentCents", "rf.amountCents as refundCents", "riv.number as refundInvoiceNumber", "pl.name as planName", "si.name as serviceItemName"])
    .where("l.organizationId", "=", organizationId)
    .where("l.status", "<>", "new");
  if (filter.attention) q = q.where((eb) => eb.or([eb("l.status", "=", "conflict"), eb("l.status", "=", "quarantined"), eb.and([eb("l.status", "=", "failed"), eb("l.nextAttemptAt", "is", null)])]));
  if (filter.status) q = q.where("l.status", "=", filter.status);
  if (filter.entityType) q = q.where("l.entityType", "=", filter.entityType);
  if (filter.entityId) q = q.where("l.entityId", "=", filter.entityId);
  const rows = await q.orderBy("l.updatedAt", "desc").limit(filter.limit ?? 200).execute();
  return rows.map((r) => {
    const label =
      r.entityType === "customer"
        ? (r.customerName ?? "Customer")
        : r.entityType === "invoice"
          ? invoiceNumberLabel(r.invoiceNumber)
          : r.entityType === "payment"
            ? `${dollars(r.paymentCents ?? 0)} on ${invoiceNumberLabel(r.paymentInvoiceNumber)}`
            : r.entityType === "refund"
              ? `Refund of ${dollars(r.refundCents ?? 0)} on ${invoiceNumberLabel(r.refundInvoiceNumber)}`
              : r.entityType === "service_item"
                ? (r.serviceItemName ?? "Service item")
                : (r.planName ?? "Plan");
    const guide = (r.status === "conflict" || r.status === "quarantined") && r.conflictKind ? QUICKBOOKS_CONFLICT_GUIDE[r.conflictKind] : r.status === "failed" ? QUICKBOOKS_CONFLICT_GUIDE.failed : null;
    const details = (r.conflict ?? null) as Record<string, unknown> | null;
    const candidates = ((details?.candidates ?? []) as StoredCandidate[]).map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, address: c.address, score: c.score, reasons: c.reasons as never }));
    const shown = details ? Object.fromEntries(Object.entries(details).filter(([k]) => !["candidates", "remoteSyncToken", "remoteUpdatedAt"].includes(k))) : null;
    if (shown && "existing" in shown) shown.existing = { ...(shown.existing as object), syncToken: undefined };
    return {
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      label,
      customer: r.customerId && r.customerName ? { id: r.customerId, displayName: r.customerName } : null,
      status: r.status,
      conflictKind: r.conflictKind,
      title: guide?.title ?? null,
      explanation: guide?.explanation ?? null,
      actions: actionsFor(r),
      details: shown,
      candidates,
      externalId: r.externalId,
      syncError: r.syncError,
      retryCount: r.retryCount,
      nextAttemptAt: iso(r.nextAttemptAt),
      lastSyncedAt: iso(r.lastSyncedAt),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}
