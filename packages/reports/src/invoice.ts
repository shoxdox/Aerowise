import type { InvoiceSnapshot } from "@aerowise/domain";
import PDFDocument from "pdfkit";
import { FONTS, pdfkitFont, registerFonts } from "./fonts.ts";

const ACCENT = "#1f6f5c";
const MUTED = "#5d6b66";
const RULE = "#d9dfdc";

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};

/** Where an invoice stands once money has come in, for a copy drawn after issue. */
export interface InvoiceAccount {
  /** Received, net of refunds. */
  paidCents: number;
  /** Bank payments still clearing. */
  pendingCents: number;
  /** Refunded as a credit: no longer owed. */
  creditedCents: number;
  amountDueCents: number;
  /** The day it was paid in full, in the company's time zone. */
  paidOn: string | null;
}

/**
 * Draws an invoice PDF from its snapshot. The creation date is the issue date, so the
 * same snapshot always draws the same document. `payUrl` is given only when the customer can
 * pay online. With `account`, the copy shows what has been paid and what is still due (a
 * paid invoice reads as paid, with its date), instead of the amount due when it was issued.
 */
export function renderInvoice(s: InvoiceSnapshot, opts: { payUrl?: string | null; account?: InvoiceAccount } = {}): Promise<Buffer> {
  const doc = new PDFDocument({
    ...pdfkitFont(),
    size: "LETTER",
    margin: 54,
    bufferPages: true,
    info: { Title: `Invoice ${s.number}`, Author: s.provider.name, CreationDate: new Date(`${s.issuedOn}T12:00:00Z`) },
  });
  registerFonts(doc);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = 54;
  const width = doc.page.width - 108;
  const right = left + width;

  doc.fillColor(ACCENT).font(FONTS.bold).fontSize(18).text(s.provider.name, left, 54, { width: width * 0.6 });
  doc.fillColor(MUTED).font(FONTS.regular).fontSize(9).text([s.provider.address, s.provider.phone, s.provider.email].filter(Boolean).join("\n"), { width: width * 0.6 });
  const a = opts.account;
  const paidInFull = !!a && a.amountDueCents === 0 && a.pendingCents === 0 && a.paidCents > 0 && a.paidCents + a.creditedCents >= s.totalCents;
  doc.fillColor("#000").font(FONTS.bold).fontSize(20).text("Invoice", left, 54, { width, align: "right" });
  doc.font(FONTS.regular).fontSize(10).fillColor(MUTED).text(s.number, { width, align: "right" });
  if (paidInFull) doc.font(FONTS.bold).fontSize(12).fillColor(ACCENT).text("PAID", { width, align: "right" });
  doc.moveDown(2.2);

  const top = Math.max(doc.y, 150);
  doc.font(FONTS.bold).fontSize(9).fillColor(MUTED).text("BILL TO", left, top);
  doc.font(FONTS.regular).fontSize(10).fillColor("#000").text([s.billTo.name, s.billTo.address].filter(Boolean).join("\n"), left, doc.y, { width: width * 0.45 });
  let leftBottom = doc.y;
  if (s.serviceAddress) {
    doc.moveDown(0.6);
    doc.font(FONTS.bold).fontSize(9).fillColor(MUTED).text("SERVICE ADDRESS", left);
    doc.font(FONTS.regular).fontSize(10).fillColor("#000").text(s.serviceAddress, { width: width * 0.45 });
    leftBottom = doc.y;
  }
  const meta: [string, string][] = a
    ? [
        ["Invoice date", day(s.issuedOn)],
        paidInFull && a.paidOn ? ["Paid on", day(a.paidOn)] : ["Due date", day(s.dueOn)],
        ...(a.paidCents > 0 ? [["Paid", money(a.paidCents)] as [string, string]] : []),
        ...(a.pendingCents > 0 ? [["Processing", money(a.pendingCents)] as [string, string]] : []),
        ...(a.creditedCents > 0 ? [["Credited", money(a.creditedCents)] as [string, string]] : []),
        ["Amount due", money(a.amountDueCents)],
      ]
    : [
        ["Invoice date", day(s.issuedOn)],
        ["Due date", day(s.dueOn)],
        ["Amount due", money(s.totalCents)],
      ];
  let y = top;
  for (const [label, value] of meta) {
    doc.font(FONTS.regular).fontSize(9).fillColor(MUTED).text(label, left + width * 0.55, y, { width: width * 0.2 });
    doc.font(FONTS.bold).fontSize(10).fillColor("#000").text(value, left + width * 0.75, y, { width: width * 0.25, align: "right" });
    y += 16;
  }
  doc.y = Math.max(leftBottom, y) + 20;

  // Lines
  const cols = { desc: left, qty: left + width * 0.6, unit: left + width * 0.7, amount: left + width * 0.85 };
  const header = () => {
    const hy = doc.y;
    doc.font(FONTS.bold).fontSize(9).fillColor(MUTED);
    doc.text("Description", cols.desc, hy, { width: width * 0.58 });
    doc.text("Qty", cols.qty, hy, { width: width * 0.08, align: "right" });
    doc.text("Price", cols.unit, hy, { width: width * 0.13, align: "right" });
    doc.text("Amount", cols.amount, hy, { width: width * 0.15, align: "right" });
    doc.moveTo(left, doc.y + 3).lineTo(right, doc.y + 3).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.y += 8;
  };
  header();
  for (const line of s.lines) {
    if (doc.y > doc.page.height - 120) {
      doc.addPage();
      header();
    }
    const ly = doc.y;
    doc.font(FONTS.regular).fontSize(10).fillColor("#000").text(line.description + (line.taxable && s.taxRateBps > 0 ? " *" : ""), cols.desc, ly, { width: width * 0.58 });
    const bottom = doc.y;
    doc.text(String(line.quantity), cols.qty, ly, { width: width * 0.08, align: "right" });
    doc.text(money(line.unitPriceCents), cols.unit, ly, { width: width * 0.13, align: "right" });
    doc.text(money(line.amountCents), cols.amount, ly, { width: width * 0.15, align: "right" });
    doc.y = Math.max(bottom, doc.y) + 6;
  }
  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
  doc.y += 8;

  const totals: [string, string, boolean][] = [["Subtotal", money(s.subtotalCents), false]];
  if (s.discountCents > 0) totals.push(["Discount", `−${money(s.discountCents)}`, false]);
  if (s.taxRateBps > 0) totals.push([`Sales tax (${(s.taxRateBps / 100).toFixed(2)}%)`, money(s.taxCents), false]);
  if (s.depositAppliedCents) totals.push(["Deposit applied", `−${money(s.depositAppliedCents)}`, false]);
  totals.push(["Total", money(s.totalCents), true]);
  for (const [label, value, bold] of totals) {
    const ty = doc.y;
    doc.font(bold ? FONTS.bold : FONTS.regular).fontSize(bold ? 12 : 10).fillColor("#000");
    doc.text(label, left + width * 0.5, ty, { width: width * 0.3, align: "right" });
    doc.text(value, cols.amount, ty, { width: width * 0.15, align: "right" });
    doc.y = ty + (bold ? 18 : 15);
  }
  if (s.taxRateBps > 0 && s.lines.some((l) => l.taxable)) {
    doc.font(FONTS.regular).fontSize(8).fillColor(MUTED).text("* Taxable", left, doc.y + 4);
  }

  if (s.memo) {
    doc.moveDown(1.2);
    doc.font(FONTS.bold).fontSize(9).fillColor(MUTED).text("NOTES", left, doc.y);
    doc.font(FONTS.regular).fontSize(10).fillColor("#000").text(s.memo, { width });
  }

  doc.moveDown(1.5);
  if (a && a.amountDueCents === 0) {
    doc.font(FONTS.bold).fontSize(10).fillColor(ACCENT).text("Payment", left, doc.y);
    doc
      .font(FONTS.regular)
      .fontSize(10)
      .fillColor("#000")
      .text(
        paidInFull
          ? `Paid in full${a.paidOn ? ` on ${day(a.paidOn)}` : ""}. Thank you.`
          : a.pendingCents > 0
            ? `Your payment of ${money(a.pendingCents)} is clearing. Nothing more is due.`
            : "Nothing is due on this invoice.",
        { width },
      );
  } else {
    // The pay link only when the provider can take payment online; otherwise a check.
    doc.font(FONTS.bold).fontSize(10).fillColor(ACCENT).text("How to pay", left, doc.y);
    doc
      .font(FONTS.regular)
      .fontSize(10)
      .fillColor("#000")
      .text(
        opts.payUrl
          ? `Pay online by card or bank transfer at ${opts.payUrl}. You can also pay by check made out to ${s.provider.name}; please write ${s.number} on it.`
          : `Please pay by check made out to ${s.provider.name} and write ${s.number} on it.${s.provider.phone ? ` Questions? Call ${s.provider.phone}.` : ""}`,
        { width },
      );
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc
      .font(FONTS.regular)
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(`${s.provider.name} · ${s.number} · page ${i - range.start + 1} of ${range.count}`, left, doc.page.height - 36, { width, align: "center", lineBreak: false });
  }
  doc.end();
  return finished;
}
