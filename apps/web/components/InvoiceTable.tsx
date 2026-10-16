"use client";

import type { InvoiceListItem } from "@aerowise/domain";
import Link from "next/link";
import { InvoiceStatusBadge } from "@/components/InvoiceBadges";
import { day, invoiceLabel, money } from "@/lib/format";

export function InvoiceTable({ items, showCustomer = true }: { items: InvoiceListItem[]; showCustomer?: boolean }) {
  return (
    <table className="stack">
      <thead>
        <tr>
          <th>Invoice</th>
          {showCustomer && <th>Customer</th>}
          <th>Due</th>
          <th className="num">Total</th>
          <th className="num">Still due</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id} className={i.overdue ? "overdue" : undefined}>
            <td data-label="Invoice">
              <Link href={`/invoices/${i.id}`}>{invoiceLabel(i.number)}</Link>
              {i.issuedOn && <div className="muted small">Issued {day(i.issuedOn)}</div>}
            </td>
            {showCustomer && (
              <td data-label="Customer">
                <Link href={`/customers/${i.customer.id}`}>{i.customer.displayName}</Link>
                {i.site && (
                  <div className="muted small">
                    {i.site.addressLine1}, {i.site.city}
                  </div>
                )}
              </td>
            )}
            <td data-label="Due">{i.dueOn ? day(i.dueOn) : "—"}</td>
            <td data-label="Total" className="num">
              {money(i.totalCents)}
            </td>
            <td data-label="Still due" className="num">
              {i.status === "open" ? money(i.amountDueCents) : "—"}
            </td>
            <td data-label="Status">
              <InvoiceStatusBadge invoice={i} />
              {i.status === "open" && !i.sentAt && <div className="muted small">Not emailed</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
