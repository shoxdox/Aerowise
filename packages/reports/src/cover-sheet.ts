import PDFDocument from "pdfkit";

const MUTED = "#5d6b66";
const FAIL = "#b42318";

export interface CoverSheet {
  title: string;
  /** Which official form this reproduces, printed small at the bottom. */
  formReference: string;
  fields: { label: string; value: string | null; required: boolean }[];
  instructions: string | null;
  /** The package it belongs to, so a printed sheet can be traced back. */
  packageReference: string;
  generatedAt: string;
}

/**
 * Draws an authority's cover sheet from its field values: a plain one-page form with each
 * label, its value, and REQUIRED where the authority marks it. It reproduces the fields,
 * not the authority's original layout; the footer says which form it stands for.
 */
export function renderCoverSheet(c: CoverSheet): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: 54, info: { Title: c.title, CreationDate: new Date(c.generatedAt) } });
  const chunks: Buffer[] = [];
  doc.on("data", (b: Buffer) => chunks.push(b));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const left = 54;
  const width = doc.page.width - 108;

  doc.font("Helvetica-Bold").fontSize(15).fillColor("#000").text(c.title, left, 72, { width, align: "center" });
  doc.moveDown(1.5);

  for (const f of c.fields) {
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#000").text(f.label, left, y, { width: 200 });
    if (f.required) doc.font("Helvetica").fontSize(7.5).fillColor(FAIL).text("REQUIRED", left, doc.y, { width: 200 });
    const labelBottom = doc.y;
    doc
      .font(f.value ? "Helvetica" : "Helvetica-Oblique")
      .fontSize(11)
      .fillColor(f.value ? "#000" : MUTED)
      .text(f.value ?? "", left + 210, y, { width: width - 210 });
    const valueBottom = Math.max(doc.y, y + 14);
    doc
      .moveTo(left + 210, valueBottom + 2)
      .lineTo(left + width, valueBottom + 2)
      .strokeColor("#9aa5a1")
      .lineWidth(0.5)
      .stroke();
    doc.y = Math.max(labelBottom, valueBottom) + 12;
  }

  if (c.instructions) {
    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#000").text(c.instructions, left, doc.y, { width, align: "center" });
  }

  const bottom = doc.page.height - 66;
  doc.page.margins.bottom = 0;
  doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(c.formReference, left, bottom, { width, align: "center" });
  doc.text(`Package ${c.packageReference} · prepared ${c.generatedAt.slice(0, 10)}`, left, bottom + 20, { width, align: "center", lineBreak: false });
  doc.end();
  return finished;
}
