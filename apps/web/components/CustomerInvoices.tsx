"use client";

import type { InvoiceListItem } from "@aerowise/domain";
import Link from "next/link";
import { InvoiceTable } from "@/components/InvoiceTable";
import { useLoad } from "@/components/useLoad";
import { money } from "@/lib/format";

export function CustomerInvoices({ customerId, editable }: { customerId: string; editable: boolean }) {
  const { data } = useLoad<{ items: InvoiceListItem[] }>(`/invoices?view=all&customerId=${customerId}&limit=50`);
  const owed = data?.items.reduce((sum, i) => sum + i.amountDueCents, 0) ?? 0;
  return (
    <section className="stack">
      <div className="row">
        <h2>Invoices</h2>
        {owed > 0 && <span className="muted">{money(owed)} owed</span>}
        <span className="spacer" />
        {editable && (
          <Link href={`/invoices/new?customerId=${customerId}`} className="button secondary">
            New invoice
          </Link>
        )}
      </div>
      {data?.items.length === 0 && <p className="muted">No invoices yet.</p>}
      {data && data.items.length > 0 && <InvoiceTable items={data.items} showCustomer={false} />}
    </section>
  );
}
