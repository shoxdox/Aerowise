"use client";

import type { InvoiceListItem } from "@aerowise/domain";
import Link from "next/link";
import { useQueryState } from "@/components/useQueryState";
import { LoadState } from "@/components/LoadState";
import { Pagination } from "@/components/Pagination";
import { InvoiceTable } from "@/components/InvoiceTable";
import { useLoad } from "@/components/useLoad";
import { canEdit, useSession } from "@/lib/session";
import { EmptyState } from "@/components/EmptyState";

const VIEWS = [
  { key: "unpaid", label: "Unpaid" },
  { key: "overdue", label: "Overdue" },
  { key: "draft", label: "Drafts" },
  { key: "paid", label: "Paid" },
  { key: "void", label: "Void" },
  { key: "all", label: "All" },
] as const;

const EMPTY: Record<(typeof VIEWS)[number]["key"], [string, string]> = {
  unpaid: ["Nothing is waiting to be paid", "Issued invoices wait here until they are paid in full, online or recorded by hand."],
  overdue: ["No invoices are overdue", "An unpaid invoice shows here once its due date passes."],
  draft: ["No drafts", "Bill a contract from its site page, or start an invoice here; it stays a draft until you issue it."],
  paid: ["No paid invoices yet", "Invoices paid online or recorded as paid by check or cash show here."],
  void: ["No void invoices", "An issued invoice you cancel is kept here, voided, for the record."],
  all: ["No invoices yet", "Bill a contract from its site page, or start one here. Customers can pay online once Stripe is connected."],
};

export default function InvoicesPage() {
  const editable = canEdit(useSession());
  const [selectedView, setView] = useQueryState("view", "unpaid");
  const view = VIEWS.find((v) => v.key === selectedView)?.key ?? "unpaid";
  const [offsetText, setOffset] = useQueryState("offset", "0");
  const offset = Number.isSafeInteger(Number(offsetText)) && Number(offsetText) >= 0 ? Number(offsetText) : 0;
  const load = useLoad<{ items: InvoiceListItem[]; total: number; owedCents: number }>(`/invoices?view=${view}&limit=50&offset=${offset}`);
  const { data } = load;

  return (
    <div className="stack">
      <div className="row">
        <h1>Invoices</h1>
        <span className="spacer" />
        {VIEWS.map((v) => (
          <button key={v.key} className={view === v.key ? undefined : "secondary"} onClick={() => setView(v.key)}>
            {v.label}
          </button>
        ))}
        {editable && (
          <Link href="/invoices/new" className="button">
            New invoice
          </Link>
        )}
      </div>
      <LoadState load={load} label="invoices" />
      {data && data.items.length > 0 && <InvoiceTable items={data.items} />}
      {data?.items.length === 0 && <EmptyState title={EMPTY[view][0]}>{EMPTY[view][1]}</EmptyState>}
      {data && <Pagination total={data.total} offset={offset} onChange={(n) => setOffset(String(n))} />}
    </div>
  );
}
