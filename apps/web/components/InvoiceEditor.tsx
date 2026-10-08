"use client";

import { invoiceTotals, milliAmount, SERVICE_ITEM_UNIT_LABELS, type CustomerDetail, type CustomerListItem, type InvoiceDetail, type ServiceItem } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { money } from "@/lib/format";

interface LineDraft {
  id?: string;
  description: string;
  quantity: string;
  price: string;
  taxable: boolean;
  /** Billed from a contract; shown so the office knows not to retype it. */
  installment?: number | null;
  /** The catalog item the line started from. */
  serviceItemId?: string | null;
}

const toCents = (dollars: string) => Math.round(Number(dollars || "0") * 100);
const toDollars = (cents: number) => (cents / 100).toFixed(2);
const blank = (): LineDraft => ({ description: "", quantity: "1", price: "", taxable: false });

/**
 * A line's quantity as saved: whole units, or up to three decimals where service items are on
 * (or the line already had a fraction, which is never cut short by an edit).
 */
function parseLine(l: LineDraft, fractions: boolean) {
  const n = Number(l.quantity) || 1;
  const unitPriceCents = toCents(l.price);
  if (!fractions || Number.isInteger(n)) {
    const quantity = fractions ? n : Math.max(1, Math.trunc(n));
    return { quantity, unitPriceCents, taxable: l.taxable, amountCents: quantity * unitPriceCents };
  }
  const milli = Math.max(1, Math.round(n * 1000));
  return { quantity: milli / 1000, unitPriceCents, taxable: l.taxable, amountCents: milliAmount(milli, unitPriceCents) };
}

/**
 * Creates a draft invoice, or edits one. The totals shown are computed with the same
 * function the API uses, so what the office sees is what gets saved.
 */
export function InvoiceEditor({
  invoice,
  customerId: presetCustomer,
  defaults,
  onSaved,
}: {
  invoice?: InvoiceDetail;
  customerId?: string;
  defaults?: { taxRateBps: number; termsDays: number };
  onSaved: (inv: InvoiceDetail) => void;
}) {
  const [search, setSearch] = useState("");
  const [customerId, setCustomerId] = useState(invoice?.customer.id ?? presetCustomer ?? "");
  const customers = useLoad<{ items: CustomerListItem[] }>(invoice || presetCustomer ? null : `/customers?limit=50${search ? `&search=${encodeURIComponent(search)}` : ""}`);
  const customer = useLoad<CustomerDetail>(customerId ? `/customers/${customerId}` : null);
  const [siteId, setSiteId] = useState(invoice?.site?.id ?? "");
  const [lines, setLines] = useState<LineDraft[]>(
    invoice?.lines.map((l) => ({
      id: l.id,
      description: l.description,
      quantity: String(l.quantity),
      price: toDollars(l.unitPriceCents),
      taxable: l.taxable,
      installment: l.installment,
      serviceItemId: l.serviceItemId,
    })) ?? [blank()],
  );
  const catalogOn = useFeature("service_items");
  const catalog = useLoad<{ items: ServiceItem[] }>(catalogOn ? "/service-items" : null);
  // A draft that already has a fraction keeps it, even where service items are off.
  const fractions = catalogOn || !!invoice?.lines.some((l) => l.quantityMilli !== null);
  const [discount, setDiscount] = useState(invoice ? toDollars(invoice.discountCents) : "");
  const [taxRate, setTaxRate] = useState(String(((invoice?.taxRateBps ?? defaults?.taxRateBps ?? 0) / 100).toFixed(2)));
  const [termsDays, setTermsDays] = useState(String(invoice?.termsDays ?? defaults?.termsDays ?? 30));
  const [memo, setMemo] = useState(invoice?.memo ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const taxRateBps = Math.round(Number(taxRate || "0") * 100);
  const parsed = lines.map((l) => parseLine(l, fractions));
  const totals = invoiceTotals(parsed, toCents(discount), taxRateBps);
  const update = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      siteId: siteId || null,
      memo: memo.trim() || null,
      termsDays: Number(termsDays),
      taxRateBps,
      discountCents: toCents(discount),
      lines: lines.map((l, i) => {
        const { quantity, unitPriceCents, taxable } = parsed[i]!;
        return { ...(l.id ? { id: l.id } : {}), description: l.description.trim(), quantity, unitPriceCents, taxable, serviceItemId: l.serviceItemId ?? null };
      }),
    };
    try {
      const saved = invoice
        ? await api<InvoiceDetail>(`/invoices/${invoice.id}`, { method: "PATCH", body })
        : await api<InvoiceDetail>("/invoices", { method: "POST", body: { ...body, customerId } });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={save}>
      {!invoice && !presetCustomer && (
        <div className="grid">
          <label>
            Find customer
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, phone or email" />
          </label>
          <label>
            Customer
            <select value={customerId} onChange={(e) => (setCustomerId(e.target.value), setSiteId(""))} required>
              <option value="">Choose…</option>
              {customers.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {customer.data && (
        <div className="grid">
          <label>
            Service site
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">Not for a particular site</option>
              {customer.data.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.addressLine1}, {s.city}
                </option>
              ))}
            </select>
          </label>
          <label>
            Due in (days)
            <input type="number" min={0} max={120} value={termsDays} onChange={(e) => setTermsDays(e.target.value)} required />
          </label>
        </div>
      )}

      <table className="compact">
        <thead>
          <tr>
            <th>Description</th>
            <th style={{ width: 80 }}>Qty</th>
            <th style={{ width: 120 }}>Price ($)</th>
            <th style={{ width: 70 }}>Taxable</th>
            <th style={{ width: 110 }}>Amount</th>
            <th style={{ width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                {catalog.data && catalog.data.items.length > 0 && (
                  <select
                    aria-label="Service item"
                    value={l.serviceItemId ?? ""}
                    onChange={(e) => {
                      const item = catalog.data!.items.find((x) => x.id === e.target.value);
                      update(i, item ? { serviceItemId: item.id, description: item.description || item.name, price: toDollars(item.unitPriceCents), taxable: item.taxable } : { serviceItemId: null });
                    }}
                    style={{ width: "100%" }}
                  >
                    <option value="">Not from the catalog</option>
                    {catalog.data.items.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name} ({money(x.unitPriceCents)} {SERVICE_ITEM_UNIT_LABELS[x.unit]})
                      </option>
                    ))}
                  </select>
                )}
                <input aria-label="Description" value={l.description} onChange={(e) => update(i, { description: e.target.value })} required style={{ width: "100%" }} />
                {l.installment && <div className="muted small">Contract installment {l.installment}</div>}
              </td>
              <td>
                <input aria-label="Quantity" type="number" min={fractions ? 0.001 : 1} step={fractions ? "any" : 1} value={l.quantity} onChange={(e) => update(i, { quantity: e.target.value })} required style={{ width: "100%" }} />
              </td>
              <td>
                <input aria-label="Price" type="number" min={0} step="0.01" value={l.price} onChange={(e) => update(i, { price: e.target.value })} required style={{ width: "100%" }} />
              </td>
              <td>
                <input aria-label="Taxable" type="checkbox" checked={l.taxable} onChange={(e) => update(i, { taxable: e.target.checked })} />
              </td>
              <td>{money(parsed[i]!.amountCents)}</td>
              <td>
                {lines.length > 1 && (
                  <button type="button" className="link" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button type="button" className="secondary" onClick={() => setLines((ls) => [...ls, blank()])}>
          Add line
        </button>
        <span className="spacer" />
        <label>
          Discount ($)
          <input type="number" min={0} step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0.00" style={{ width: 110 }} />
        </label>
        <label>
          Sales tax (%)
          <input type="number" min={0} max={20} step="0.01" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} style={{ width: 90 }} />
        </label>
      </div>
      <dl className="details totals">
        <dt>Subtotal</dt>
        <dd>{money(totals.subtotalCents)}</dd>
        {totals.discountCents > 0 && (
          <>
            <dt>Discount</dt>
            <dd>−{money(totals.discountCents)}</dd>
          </>
        )}
        {taxRateBps > 0 && (
          <>
            <dt>Tax on {money(totals.taxableCents)}</dt>
            <dd>{money(totals.taxCents)}</dd>
          </>
        )}
        <dt>
          <strong>Total</strong>
        </dt>
        <dd>
          <strong>{money(totals.totalCents)}</strong>
        </dd>
      </dl>
      <label>
        Note to the customer
        <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} placeholder="Optional; printed on the invoice" />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="submit" disabled={busy || !customerId}>
          {invoice ? "Save draft" : "Create draft"}
        </button>
      </div>
    </form>
  );
}
