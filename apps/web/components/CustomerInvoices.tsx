"use client";

import type { InvoiceListItem } from "@aerowise/domain";
import Link from "next/link";
import { InvoiceTable } from "@/components/InvoiceTable";
import { useState } from "react";
import { LoadState } from "@/components/LoadState";
import { Pagination } from "@/components/Pagination";
import { useLoad } from "@/components/useLoad";
import { money } from "@/lib/format";

export function CustomerInvoices({ customerId, editable }: { customerId: string; editable: boolean }) {
  const [offset, setOffset] = useState(0);
  const load = useLoad<{ items: InvoiceListItem[]; total: number; owedCents: number }>(`/invoices?view=all&customerId=${customerId}&limit=50&offset=${offset}`);
  const { data } = load;
  const owed = data?.owedCents;
  return (
    <section className="stack">
      <div className="row">
        <h2>Invoices</h2>
        {owed !== undefined && owed > 0 && <span className="muted">{money(owed)} owed</span>}
        <span className="spacer" />
        {editable && (
          <Link href={`/invoices/new?customerId=${customerId}`} className="button secondary">
            New invoice
          </Link>
        )}
      </div>
      <LoadState load={load} label="customer invoices" />
      {data?.items.length === 0 && <p className="muted">No invoices yet.</p>}
      {data && data.items.length > 0 && <InvoiceTable items={data.items} showCustomer={false} />}
      {data && <Pagination total={data.total} offset={offset} onChange={setOffset} />}
    </section>
  );
}
