"use client";

import { estimateLineAmount, type EstimateLine, type EstimateLineInput, type EstimateStatus } from "@aerowise/domain";
import { money } from "@/lib/format";

/** A line as typed in the editor: quantity and price stay text until saved. */
export interface DraftLine {
  key: number;
  description: string;
  quantity: string;
  price: string;
  taxable: boolean;
  optional: boolean;
  selectedByDefault: boolean;
}

let nextKey = 1;
export const blankLine = (): DraftLine => ({ key: nextKey++, description: "", quantity: "1", price: "", taxable: false, optional: false, selectedByDefault: true });

export const fromSaved = (l: EstimateLine): DraftLine => ({
  key: nextKey++,
  description: l.description,
  quantity: String(l.quantityMilli / 1000),
  price: (l.unitPriceCents / 100).toFixed(2),
  taxable: l.taxable,
  optional: l.optional,
  selectedByDefault: l.selectedByDefault,
});

const cents = (price: string) => Math.round(Number(price || "0") * 100);
const milli = (quantity: string) => Math.round(Number(quantity || "0") * 1000);

/** The lines to send, or an error to show. */
export function toInput(lines: DraftLine[]): { lines: EstimateLineInput[] } | { error: string } {
  const filled = lines.filter((l) => l.description.trim() || l.price);
  if (filled.length === 0) return { error: "Add at least one line." };
  for (const l of filled) {
    if (!l.description.trim()) return { error: "Every line needs a description." };
    if (!(Number(l.quantity) > 0)) return { error: `Give "${l.description}" a quantity above zero.` };
    if (!(Number(l.price) >= 0) || l.price === "") return { error: `Give "${l.description}" a price.` };
  }
  return {
    lines: filled.map((l) => ({
      description: l.description.trim(),
      quantity: milli(l.quantity) / 1000,
      unitPriceCents: cents(l.price),
      taxable: l.taxable,
      optional: l.optional,
      selectedByDefault: l.optional ? l.selectedByDefault : true,
    })),
  };
}

/** Lines of an estimate draft. Optional lines are the homeowner's choice to add or leave out. */
export function EstimateLineEditor({ lines, onChange }: { lines: DraftLine[]; onChange: (lines: DraftLine[]) => void }) {
  const set = (key: number, patch: Partial<DraftLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  return (
    <div className="stack">
      <div className="table-scroll">
        <table className="compact" style={{ minWidth: "max-content" }}>
          <thead>
            <tr>
              <th>Description</th>
              <th>Qty</th>
              <th>Unit price ($)</th>
              <th>Taxable</th>
              <th>Optional</th>
              <th>Starts chosen</th>
              <th className="num">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key}>
                <td>
                  <input value={l.description} onChange={(e) => set(l.key, { description: e.target.value })} aria-label={`Line ${i + 1} description`} maxLength={500} style={{ width: "18em" }} />
                </td>
                <td>
                  <input type="number" min="0.001" step="0.001" value={l.quantity} onChange={(e) => set(l.key, { quantity: e.target.value })} aria-label={`Line ${i + 1} quantity`} style={{ width: "6em" }} />
                </td>
                <td>
                  <input type="number" min="0" step="0.01" value={l.price} onChange={(e) => set(l.key, { price: e.target.value })} aria-label={`Line ${i + 1} unit price`} style={{ width: "8em" }} />
                </td>
                <td>
                  <input type="checkbox" checked={l.taxable} onChange={(e) => set(l.key, { taxable: e.target.checked })} aria-label={`Line ${i + 1} taxable`} />
                </td>
                <td>
                  <input type="checkbox" checked={l.optional} onChange={(e) => set(l.key, { optional: e.target.checked })} aria-label={`Line ${i + 1} optional`} />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={l.optional ? l.selectedByDefault : true}
                    disabled={!l.optional}
                    onChange={(e) => set(l.key, { selectedByDefault: e.target.checked })}
                    aria-label={`Line ${i + 1} starts chosen`}
                  />
                </td>
                <td className="num">{money(estimateLineAmount({ quantityMilli: milli(l.quantity), unitPriceCents: cents(l.price) }))}</td>
                <td>
                  {lines.length > 1 && (
                    <button type="button" className="link" onClick={() => onChange(lines.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <button type="button" className="secondary" onClick={() => onChange([...lines, blankLine()])}>
          Add line
        </button>
      </div>
      <p className="muted small">Optional lines are the customer&apos;s choice: they tick the ones they want before accepting. Required lines are always included.</p>
    </div>
  );
}

/** The badge style for an estimate's status. */
export const estimateBadge = (s: EstimateStatus) =>
  s === "accepted" ? "completed" : s === "declined" || s === "expired" ? "danger" : s === "void" || s === "cancelled" ? "cancelled" : s === "draft" ? "inactive" : "upcoming";
