import type { InvoiceListItem } from "@aerowise/domain";
import { Badge, StatusBadge } from "@/components/StatusBadge";

/** One badge for where an invoice stands: draft, void, or how far it is paid. */
export function InvoiceStatusBadge({ invoice }: { invoice: Pick<InvoiceListItem, "status" | "paymentStatus" | "overdue"> }) {
  if (invoice.status === "draft") return <Badge>Draft</Badge>;
  if (invoice.status === "void") return <Badge tone="struck">Void</Badge>;
  if (invoice.overdue) return <Badge tone="danger">Overdue</Badge>;
  return <StatusBadge of="payment" value={invoice.paymentStatus} />;
}
