import PDFDocument from "pdfkit";
import { FONTS, pdfkitFont, registerFonts } from "./fonts.ts";

const ACCENT = "#1f6f5c";
const MUTED = "#5d6b66";
const RULE = "#cbd8d0";

/** One finished visit on the work order, from its field record. */
export interface CompletionVisit {
  visitNumber: number;
  /** The visit's date in the company's time zone. */
  date: string;
  technician: string;
  answers: { section: string; label: string; answer: string }[];
  photos: { label: string; count: number }[];
  signatures: { label: string; signerName: string; signedOn: string; image: Buffer | null }[];
  anotherVisitNeeded: boolean;
}

/**
 * SW-7: the "Work completion summary" a customer gets for finished work. It says what was done,
 * visit by visit, and who signed it off. It is not an inspection report, is never filed with an
 * authority, and does not say that the work meets any regulation.
 */
export interface CompletionSummary {
  companyName: string;
  companyContact: string | null;
  workOrder: string;
  workType: string;
  customerName: string;
  address: string;
  completedOn: string;
  generatedOn: string;
  generatedAt: string;
  visits: CompletionVisit[];
}

export function renderCompletionSummary(s: CompletionSummary): Promise<Buffer> {
  const doc = new PDFDocument({
    ...pdfkitFont(),
    size: "LETTER",
    margins: { top: 50, bottom: 60, left: 54, right: 54 },
    bufferPages: true,
    info: { Title: `Work completion summary: ${s.workOrder}`, Author: "Aerowise", Subject: `${s.companyName}: ${s.workOrder}`, CreationDate: new Date(s.generatedAt) },
  });
  registerFonts(doc);
  const chunks: Buffer[] = [];
  doc.on("data", (b: Buffer) => chunks.push(b));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const left = 54;
  const width = doc.page.width - 108;
  const room = (h: number) => {
    if (doc.y + h > doc.page.height - 60) doc.addPage();
  };

  doc.font(FONTS.bold).fontSize(18).fillColor(ACCENT).text("Work completion summary", left, 50, { width });
  doc.moveDown(0.2);
  doc.font(FONTS.regular).fontSize(10).fillColor("#000").text(s.companyName, left, doc.y, { width });
  if (s.companyContact) doc.font(FONTS.regular).fontSize(9).fillColor(MUTED).text(s.companyContact, left, doc.y, { width });
  doc.moveDown(0.5);
  const facts: [string, string][] = [
    ["Work", s.workOrder],
    ["Kind of work", s.workType],
    ["Customer", s.customerName],
    ["Property", s.address],
    ["Completed", s.completedOn],
  ];
  for (const [k, v] of facts) {
    const y = doc.y;
    doc.font(FONTS.bold).fontSize(9.5).fillColor(MUTED).text(k, left, y, { width: 100 });
    doc.font(FONTS.regular).fontSize(9.5).fillColor("#000").text(v, left + 105, y, { width: width - 105 });
  }
  doc.moveDown(0.4);
  doc
    .font(FONTS.regular)
    .fontSize(8.5)
    .fillColor(MUTED)
    .text("A summary of the work done, for the customer's records. It is not an inspection report, it is not filed with any authority, and it does not state that the work meets a regulation.", left, doc.y, { width, lineGap: 1 });
  doc.moveDown(0.6);

  for (const v of s.visits) {
    room(80);
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(0.3);
    doc.font(FONTS.bold).fontSize(11).fillColor("#000").text(`Visit ${v.visitNumber} · ${v.date}`, left, doc.y, { width });
    doc.font(FONTS.regular).fontSize(9).fillColor(MUTED).text(`Technician ${v.technician}${v.anotherVisitNeeded ? " · another visit was needed" : ""}`, left, doc.y, { width });
    doc.moveDown(0.3);
    let section: string | null = null;
    for (const a of v.answers) {
      if (a.section !== section) {
        section = a.section;
        room(30);
        doc.font(FONTS.bold).fontSize(9.5).fillColor(ACCENT).text(section, left, doc.y + 2, { width });
      }
      room(16);
      const y = doc.y;
      doc.font(FONTS.regular).fontSize(9).fillColor(MUTED).text(a.label, left + 8, y, { width: 170 });
      const below = doc.y;
      doc.font(FONTS.regular).fontSize(9).fillColor("#000").text(a.answer, left + 185, y, { width: width - 185, lineGap: 1 });
      doc.y = Math.max(below, doc.y);
    }
    if (v.photos.some((p) => p.count > 0)) {
      room(16);
      doc
        .font(FONTS.regular)
        .fontSize(9)
        .fillColor(MUTED)
        .text(`Photos taken: ${v.photos.filter((p) => p.count > 0).map((p) => `${p.label} (${p.count})`).join(", ")}`, left + 8, doc.y + 3, { width: width - 8 });
    }
    for (const sig of v.signatures) {
      room(sig.image ? 90 : 30);
      doc.moveDown(0.3);
      doc.font(FONTS.bold).fontSize(9.5).fillColor("#000").text(`${sig.label}: signed by ${sig.signerName} on ${sig.signedOn}`, left + 8, doc.y, { width: width - 8 });
      if (sig.image) {
        try {
          doc.image(sig.image, left + 8, doc.y + 2, { fit: [220, 60] });
          doc.y += 66;
        } catch {
          // An unreadable drawing leaves the line above, which already says who signed.
        }
      }
    }
    doc.moveDown(0.6);
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 42;
    doc
      .font(FONTS.regular)
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(`Work completion summary · ${s.companyName} · ${s.workOrder} · made ${s.generatedOn} · page ${i - range.start + 1} of ${range.count}`, left, y, { width, lineBreak: false, height: 10 });
  }
  doc.end();
  return finished;
}
