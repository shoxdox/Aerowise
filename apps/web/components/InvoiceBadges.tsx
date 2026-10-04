import { PAYMENT_STATUS_LABELS, type InvoiceListItem } from "@aerowise/domain";

/** One badge for where an invoice stands: draft, void, or how far it is paid. */
export function InvoiceStatusBadge({ invoice }: { invoice: Pick<InvoiceListItem, "status" | "paymentStatus" | "overdue"> }) {
  if (invoice.status === "draft") return <span className="badge">Draft</span>;
  if (invoice.status === "void") return <span className="badge cancelled">Void</span>;
  if (invoice.overdue) return <span className="badge danger">Overdue</span>;
  const cls = { paid: "ok", overpaid: "warn", partial: "warn", processing: "upcoming", refunded: "inactive", unpaid: "" }[invoice.paymentStatus];
  return <span className={`badge ${cls}`}>{PAYMENT_STATUS_LABELS[invoice.paymentStatus]}</span>;
}
