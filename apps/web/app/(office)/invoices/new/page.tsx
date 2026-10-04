"use client";

import type { BillingSettings } from "@aerowise/domain";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { InvoiceEditor } from "@/components/InvoiceEditor";
import { useLoad } from "@/components/useLoad";

function NewInvoice() {
  const router = useRouter();
  const customerId = useSearchParams().get("customerId") ?? undefined;
  const { data: settings } = useLoad<BillingSettings>("/billing/settings");
  if (!settings) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <p>
        <Link href="/invoices">← Invoices</Link>
      </p>
      <h1>New invoice</h1>
      <p className="muted">Start a draft. Nothing is sent until you issue it, and you can change anything until then.</p>
      <InvoiceEditor
        customerId={customerId}
        defaults={{ taxRateBps: settings.defaultTaxRateBps, termsDays: settings.invoiceTermsDays }}
        onSaved={(inv) => router.push(`/invoices/${inv.id}`)}
      />
    </div>
  );
}

export default function NewInvoicePage() {
  return (
    <Suspense>
      <NewInvoice />
    </Suspense>
  );
}
