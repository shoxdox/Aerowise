"use client";

import type { InvoiceListItem } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { InvoiceTable } from "@/components/InvoiceTable";
import { useLoad } from "@/components/useLoad";
import { canEdit, useSession } from "@/lib/session";

const VIEWS = [
  { key: "unpaid", label: "Unpaid" },
  { key: "overdue", label: "Overdue" },
  { key: "draft", label: "Drafts" },
  { key: "paid", label: "Paid" },
  { key: "void", label: "Void" },
  { key: "all", label: "All" },
] as const;

const EMPTY: Record<(typeof VIEWS)[number]["key"], string> = {
  unpaid: "Nothing is waiting to be paid.",
  overdue: "No invoices are overdue.",
  draft: "No drafts.",
  paid: "No paid invoices yet.",
  void: "No void invoices.",
  all: "No invoices yet. Bill a contract from its site page, or start one here.",
};

export default function InvoicesPage() {
  const editable = canEdit(useSession());
  const [view, setView] = useState<(typeof VIEWS)[number]["key"]>("unpaid");
  const { data, error } = useLoad<{ items: InvoiceListItem[] }>(`/invoices?view=${view}`);

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
      {error && <p className="error">{error}</p>}
      {data && data.items.length > 0 && <InvoiceTable items={data.items} />}
      {data?.items.length === 0 && <p className="muted">{EMPTY[view]}</p>}
    </div>
  );
}
