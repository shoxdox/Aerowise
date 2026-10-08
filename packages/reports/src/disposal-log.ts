import PDFDocument from "pdfkit";
import { FONTS, pdfkitFont, registerFonts } from "./fonts.ts";

const ACCENT = "#1f6f5c";
const MUTED = "#5d6b66";
const WARN = "#8a5a00";
const RULE = "#cbd8d0";

/** One delivery of a truck load, with the pump-outs it carried (SW-6). */
export interface DisposalLogLoad {
  deliveredOn: string;
  facilityName: string;
  vehicleName: string | null;
  manifestReference: string | null;
  /** As entered, e.g. "1,000.0 gallons". */
  total: string;
  /** Sum of the current pump-out volumes, e.g. "980.0 gal". */
  itemsTotal: string;
  volumesDiffer: boolean;
  photos: number;
  revision: number;
  items: { serviceDate: string; workOrderLabel: string; customerName: string; siteAddress: string; wasteType: string; volume: string }[];
}

/**
 * The provider's own disposal log for a date range: each load and the pump-outs in it. It is a
 * record the company keeps, not a regulatory form: it does not say that any load is compliant,
 * that a manifest satisfies a regulator, or that a facility accepted the load.
 */
export interface DisposalLog {
  companyName: string;
  from: string;
  to: string;
  generatedOn: string;
  generatedAt: string;
  loads: DisposalLogLoad[];
}

export function renderDisposalLog(log: DisposalLog): Promise<Buffer> {
  const doc = new PDFDocument({
    ...pdfkitFont(),
    size: "LETTER",
    margins: { top: 50, bottom: 60, left: 54, right: 54 },
    bufferPages: true,
    info: { Title: `Disposal log ${log.from} to ${log.to}`, Author: "Aerowise", Subject: `${log.companyName}: disposal records`, CreationDate: new Date(log.generatedAt) },
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

  doc.font(FONTS.bold).fontSize(18).fillColor(ACCENT).text("Disposal log", left, 50, { width });
  doc.moveDown(0.2);
  doc.font(FONTS.regular).fontSize(9.5).fillColor(MUTED).text(`${log.companyName} · ${log.from} to ${log.to} · ${log.loads.length} disposal record${log.loads.length === 1 ? "" : "s"}`, left, doc.y, { width });
  doc
    .font(FONTS.regular)
    .fontSize(8.5)
    .fillColor(MUTED)
    .text("The company's own records of where its loads were delivered. This log does not state that any load meets a regulation or that a facility accepted it.", left, doc.y + 2, { width, lineGap: 1 });
  doc.moveDown(0.6);

  if (log.loads.length === 0) doc.font(FONTS.italic).fontSize(10).fillColor(MUTED).text("No disposal records in this range.", left, doc.y, { width });

  for (const l of log.loads) {
    room(70 + 14 * Math.min(l.items.length, 4));
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(0.3);
    doc.font(FONTS.bold).fontSize(10.5).fillColor("#000").text(`${l.deliveredOn} · ${l.facilityName}`, left, doc.y, { width });
    const facts = [
      `Total ${l.total}`,
      l.vehicleName ? `truck ${l.vehicleName}` : "no truck named",
      l.manifestReference ? `manifest/reference ${l.manifestReference}` : "no manifest/reference number",
      `${l.photos} photo${l.photos === 1 ? "" : "s"}`,
      l.revision > 1 ? `corrected (revision ${l.revision})` : null,
    ].filter(Boolean);
    doc.font(FONTS.regular).fontSize(9).fillColor(MUTED).text(facts.join(" · "), left, doc.y, { width });
    if (l.volumesDiffer) doc.font(FONTS.regular).fontSize(9).fillColor(WARN).text(`The pump-outs in it add up to ${l.itemsTotal}, which differs from the load total.`, left, doc.y, { width });
    doc.moveDown(0.2);
    for (const p of l.items) {
      room(16);
      doc
        .font(FONTS.regular)
        .fontSize(9)
        .fillColor("#000")
        .text(`${p.serviceDate}  ${p.workOrderLabel}  ${p.customerName}, ${p.siteAddress}  ·  ${p.wasteType}  ·  ${p.volume}`, left + 12, doc.y, { width: width - 12, lineGap: 1 });
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
      .text(`Aerowise disposal log · ${log.companyName} · ${log.from} to ${log.to} · made ${log.generatedOn} · page ${i - range.start + 1} of ${range.count}`, left, y, { width, lineBreak: false, height: 10 });
  }
  doc.end();
  return finished;
}
