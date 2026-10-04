"use client";

import { invoiceNumberLabel, type InvoiceListItem } from "@aerowise/domain";
import Link from "next/link";
import { InvoiceStatusBadge } from "@/components/InvoiceBadges";
import { day, money } from "@/lib/format";

export function InvoiceTable({ items, showCustomer = true }: { items: InvoiceListItem[]; showCustomer?: boolean }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Invoice</th>
          {showCustomer && <th>Customer</th>}
          <th>Due</th>
          <th>Total</th>
          <th>Still due</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id} className={i.overdue ? "overdue" : undefined}>
            <td>
              <Link href={`/invoices/${i.id}`}>{invoiceNumberLabel(i.number)}</Link>
              {i.issuedOn && <div className="muted small">Issued {day(i.issuedOn)}</div>}
            </td>
            {showCustomer && (
              <td>
                <Link href={`/customers/${i.customer.id}`}>{i.customer.displayName}</Link>
                {i.site && (
                  <div className="muted small">
                    {i.site.addressLine1}, {i.site.city}
                  </div>
                )}
              </td>
            )}
            <td>{i.dueOn ? day(i.dueOn) : "—"}</td>
            <td>{money(i.totalCents)}</td>
            <td>{i.status === "open" ? money(i.amountDueCents) : "—"}</td>
            <td>
              <InvoiceStatusBadge invoice={i} />
              {i.status === "open" && !i.sentAt && <div className="muted small">Not emailed</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
