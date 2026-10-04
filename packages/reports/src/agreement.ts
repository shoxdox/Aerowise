import type { AgreementContent } from "@aerowise/domain";
import PDFDocument from "pdfkit";

const ACCENT = "#1f6f5c";
const MUTED = "#5d6b66";
const RULE = "#d9dfdc";

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const FREQUENCY: Record<AgreementContent["term"]["billingFrequency"], string> = { annual: "yearly", semiannual: "every six months", quarterly: "quarterly", monthly: "monthly" };

export interface AgreementSignature {
  documentId: string;
  signerName: string;
  kind: "typed" | "drawn";
  /** PNG bytes of a drawn signature. */
  image: Buffer | null;
  consentText: string;
  signedAt: Date;
  timezone: string;
  ipAddress: string | null;
  userAgent: string | null;
  contentSha256: string;
}

/**
 * Draws a signed renewal agreement: the agreement exactly as the customer saw it, their
 * signature, and a certificate of how and when it was signed. The creation date is the
 * signing time, so the same signed document always draws the same PDF.
 */
export function renderAgreement(c: AgreementContent, sig: AgreementSignature): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    margin: 54,
    bufferPages: true,
    info: { Title: c.title, Author: c.provider.name, CreationDate: sig.signedAt },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (b: Buffer) => chunks.push(b));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const left = 54;
  const width = doc.page.width - 108;
  const signedWhen = sig.signedAt.toLocaleString("en-US", { timeZone: sig.timezone, dateStyle: "long", timeStyle: "long" });

  const heading = (text: string) => {
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text(text.toUpperCase(), left, doc.y, { width });
    doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.moveDown(0.5);
  };
  const row = (label: string, value: string) => {
    const y = doc.y;
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(label, left, y, { width: width * 0.3 });
    const labelBottom = doc.y;
    doc.fillColor("#000").text(value, left + width * 0.32, y, { width: width * 0.68 });
    doc.y = Math.max(labelBottom, doc.y) + 3;
  };

  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(18).text(c.provider.name, left, 54, { width });
  doc.fillColor(MUTED).font("Helvetica").fontSize(9).text([c.provider.address, c.provider.phone, c.provider.email].filter(Boolean).join(" · "), { width });
  doc.moveDown(1);
  doc.fillColor("#000").font("Helvetica-Bold").fontSize(16).text(c.title, { width });

  heading("Parties and property");
  row("Customer", [c.customer.name, c.customer.email, c.customer.phone].filter(Boolean).join("\n"));
  row("Service address", c.serviceAddress);

  heading("Service term");
  row("Plan", c.term.planName);
  row("Term", `${day(c.term.startOn)} to ${day(c.term.endOn)} (${c.term.termMonths} months)`);
  row("Visits", `${c.term.visitsPerTerm} maintenance visit${c.term.visitsPerTerm === 1 ? "" : "s"}`);
  row("Price", `${money(c.term.priceCents)} for the term, billed ${FREQUENCY[c.term.billingFrequency]}${c.charges.installments > 1 ? ` in ${c.charges.installments} payments` : ""}`);
  row("Renews", `Follows the term that ended ${day(c.previousTerm.endOn)}${c.term.autoRenew ? ". Renews automatically unless either party gives notice." : "."}`);

  heading(c.charges.payment === "pay_to_activate" ? "Due at signing" : "First invoice");
  for (const l of c.charges.lines) row(l.description, money(l.amountCents));
  if (c.charges.taxCents > 0) row("Sales tax", money(c.charges.taxCents));
  row("Total", money(c.charges.totalCents));

  heading("Terms");
  doc.font("Helvetica").fontSize(9.5).fillColor("#000").text(c.terms, left, doc.y, { width, lineGap: 1.5 });

  heading("Signature");
  if (doc.y > doc.page.height - 200) doc.addPage();
  doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(MUTED).text(sig.consentText, left, doc.y, { width });
  doc.moveDown(0.6);
  const sigTop = doc.y;
  if (sig.kind === "drawn" && sig.image) {
    try {
      doc.image(sig.image, left, sigTop, { fit: [width * 0.5, 70] });
    } catch {
      doc.font("Helvetica").fontSize(9).fillColor(MUTED).text("(drawn signature on file)", left, sigTop);
    }
    doc.y = sigTop + 74;
  } else {
    doc.font("Times-Italic").fontSize(24).fillColor("#000").text(sig.signerName, left, sigTop, { width: width * 0.6 });
    doc.moveDown(0.2);
  }
  doc.moveTo(left, doc.y).lineTo(left + width * 0.5, doc.y).strokeColor("#000").lineWidth(0.5).stroke();
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(9).fillColor("#000").text(`${sig.signerName}, signed electronically ${signedWhen}`, left, doc.y, { width });

  heading("Signing certificate");
  doc.fontSize(8.5);
  row("Document", sig.documentId);
  row("Signed by", `${sig.signerName} (${sig.kind === "drawn" ? "drawn signature" : "typed name"})`);
  row("Signed at", signedWhen);
  row("IP address", sig.ipAddress ?? "not recorded");
  row("Device", sig.userAgent ?? "not recorded");
  row("Offer version", String(c.offerVersion));
  row("Content SHA-256", sig.contentSha256);

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(`${c.title} · ${sig.documentId} · page ${i - range.start + 1} of ${range.count}`, left, doc.page.height - 36, { width, align: "center", lineBreak: false });
  }
  doc.end();
  return finished;
}
