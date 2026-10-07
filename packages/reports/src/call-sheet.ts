import PDFDocument from "pdfkit";
import { FONTS, pdfkitFont, registerFonts } from "./fonts.ts";

const ACCENT = "#1f6f5c";
const MUTED = "#5d6b66";
const FAIL = "#b42318";
const RULE = "#cbd8d0";

/** One question to ask, with how far it is answered and what is on record against it. */
export interface CallSheetQuestion {
  text: string;
  /** How far it is answered, e.g. "Open" or "Published rule only". */
  state: string;
  /** Each recorded answer, already dated and attributed: "2026-10-01, Published rule (…): …". */
  evidence: string[];
}

/**
 * A printable worksheet for asking one authority its open questions (STG-06). Drawn only
 * from the ruleset and the evidence on record: it names no contact, claims no acceptance,
 * and says plainly when the authority is unverified.
 */
export interface CallSheet {
  authorityName: string;
  key: string;
  /** "Draft", "Verified" or "Example rules". */
  statusLabel: string;
  verified: boolean;
  /** The newest version, the one a new version would follow, and the one in force today. */
  version: number;
  versionInForce: number | null;
  sourcesCheckedOn: string | null;
  requirementEffective: { date: string | null; basis: string } | null;
  sources: { title: string; url: string; retrievedOn: string; note?: string }[];
  /** The ruleset's own open questions. */
  open: CallSheetQuestion[];
  /** What only the authority can confirm about accepting a report. */
  acceptance: CallSheetQuestion[];
  /** The question asked of every authority once a sample has been reviewed. */
  sharedQuestion: string;
  /** Date (YYYY-MM-DD) and time the sheet was made, and by whom. */
  generatedOn: string;
  generatedAt: string;
  preparedBy: string;
}

export const CALL_SHEET_SHARED_QUESTION =
  "For these permit types, may our licensed provider submit the attached sample instead of your form? Are the signature method and fields acceptable? Where do inspection reports and renewal/provider-change contracts each go? What naming/attachments are required, and what receipt or acknowledgment should we retain?";

export function renderCallSheet(c: CallSheet): Promise<Buffer> {
  const doc = new PDFDocument({
    ...pdfkitFont(),
    size: "LETTER",
    margins: { top: 50, bottom: 60, left: 54, right: 54 },
    bufferPages: true,
    info: { Title: `Call sheet — ${c.authorityName}`, Author: "Aerowise", Subject: "Prepared worksheet; no contact made", CreationDate: new Date(c.generatedAt) },
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
  const bottom = () => doc.page.height - 60;
  const room = (h: number) => {
    if (doc.y + h > bottom()) doc.addPage();
  };
  const heading = (title: string) => {
    room(60);
    doc.moveDown(0.7);
    doc.font(FONTS.bold).fontSize(11.5).fillColor(ACCENT).text(title, left, doc.y, { width });
    doc
      .moveTo(left, doc.y + 2)
      .lineTo(left + width, doc.y + 2)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(0.5);
  };
  const para = (text: string, opts: { size?: number; color?: string; font?: string } = {}) => {
    doc
      .font(opts.font ?? FONTS.regular)
      .fontSize(opts.size ?? 9.5)
      .fillColor(opts.color ?? "#000")
      .text(text, left, doc.y, { width, lineGap: 1.5 });
  };
  const bullet = (text: string) => {
    room(24);
    doc.font(FONTS.regular).fontSize(9).fillColor("#000").text(`•  ${text}`, left + 6, doc.y, { width: width - 6, lineGap: 1.2 });
    doc.moveDown(0.15);
  };
  /** A label with a ruled line to write on. */
  const blank = (label: string, x: number, w: number, y: number) => {
    doc.font(FONTS.regular).fontSize(8.5).fillColor(MUTED).text(label, x, y, { width: w, lineBreak: false });
    doc
      .moveTo(x, y + 26)
      .lineTo(x + w - 12, y + 26)
      .strokeColor("#9aa8a2")
      .lineWidth(0.6)
      .stroke();
  };
  const lines = (n: number) => {
    for (let i = 0; i < n; i++) {
      room(20);
      const y = doc.y + 16;
      doc
        .moveTo(left, y)
        .lineTo(left + width, y)
        .strokeColor("#c4cfca")
        .lineWidth(0.5)
        .stroke();
      doc.y = y;
    }
    doc.moveDown(0.6);
  };

  // Title and status.
  doc.font(FONTS.bold).fontSize(8.5).fillColor(FAIL).text(c.verified ? "PREPARED WORKSHEET · NOT A RECORD OF CONTACT" : "PREPARED WORKSHEET · DRAFT / UNVERIFIED · NOT A RECORD OF CONTACT", left, 50, { width });
  doc.moveDown(0.3);
  doc.font(FONTS.bold).fontSize(18).fillColor(ACCENT).text(`Call sheet: ${c.authorityName}`, left, doc.y, { width });
  doc.moveDown(0.2);
  para(
    [
      `Ruleset ${c.key}, status ${c.statusLabel}`,
      `newest version v${c.version}`,
      c.versionInForce ? `v${c.versionInForce} in force on ${c.generatedOn}` : `no version in force on ${c.generatedOn}`,
      c.sourcesCheckedOn ? `sources last read ${c.sourcesCheckedOn}` : "no dated source review",
    ].join(" · "),
    { size: 9, color: MUTED },
  );
  para(`Prepared ${c.generatedOn} by ${c.preparedBy} from the ruleset and the evidence recorded in Aerowise.`, { size: 9, color: MUTED });

  heading("Before using this sheet");
  bullet("Use it only when this authority governs the permits of a selected pilot provider. Confirm the actual permit authority from the permits first; do not contact authorities outside the pilot's scope.");
  bullet("This sheet gives no phone number, email or address. Take the current contact from the dated sources below and check it before use.");
  bullet("Keep separate: report destination, contract destination, report format, signature method, and receipt or acknowledgment. A published destination is evidence for that destination only; it does not confirm that an Aerowise report is accepted.");
  bullet("Record each answer with its scope and exact words. A verbal answer is evidence of what was said; ask for written confirmation where a conflict matters.");
  bullet(`Enter answers as evidence in /admin/rulesets/${c.key}. Saving evidence changes no rules and verifies nothing; a new version needs a reviewed pull request.`);
  if (!c.verified) bullet(`${c.authorityName} is ${c.statusLabel.toLowerCase()}: nothing here is confirmed by the authority unless the evidence says so.`);

  heading("Who, when, how");
  const col = width / 2;
  const rows = [
    ["Contacted by (Aerowise / provider)", "Date and time"],
    ["Contact name", "Role / office"],
    ["Organization", "Channel (call, email, letter, meeting)"],
    ["Number, address or inbox used, and its source", "Pilot provider and permit numbers in scope"],
  ];
  for (const [a, b] of rows as [string, string][]) {
    room(40);
    const y = doc.y;
    blank(a, left, col, y);
    blank(b, left + col, col, y);
    doc.y = y + 36;
  }

  const question = (q: CallSheetQuestion, n: number) => {
    room(110);
    const y = doc.y;
    doc.font(FONTS.bold).fontSize(9.5).fillColor("#000").text(`${n}.`, left, y, { width: 18 });
    doc.font(FONTS.bold).fontSize(9.5).fillColor("#000").text(q.text, left + 18, y, { width: width - 18, lineGap: 1.2 });
    doc
      .font(FONTS.regular)
      .fontSize(8.5)
      .fillColor(q.state === "Open" ? FAIL : MUTED)
      .text(`Now: ${q.state}`, left + 18, doc.y + 1, { width: width - 18 });
    if (q.evidence.length === 0) {
      doc.font(FONTS.italic).fontSize(8.5).fillColor(MUTED).text("No evidence recorded yet.", left + 18, doc.y, { width: width - 18 });
    } else {
      for (const e of q.evidence) doc.font(FONTS.regular).fontSize(8.5).fillColor(MUTED).text(`On record: ${e}`, left + 18, doc.y, { width: width - 18, lineGap: 1 });
    }
    doc.font(FONTS.regular).fontSize(8.5).fillColor(MUTED).text("Answer, scope and exact words:", left + 18, doc.y + 3, { width: width - 18 });
    lines(3);
  };

  heading("This authority's open questions");
  if (c.open.length === 0) para("The ruleset lists no open questions.", { color: MUTED });
  c.open.forEach((q, i) => question(q, i + 1));

  heading("What only the authority can confirm");
  para("A published rule or a provider's past filing can support these, but only the authority's own answer confirms how it accepts filings.", { size: 9, color: MUTED });
  doc.moveDown(0.3);
  c.acceptance.forEach((q, i) => question(q, c.open.length + i + 1));

  heading("Shared acceptance question (after the sample has been reviewed)");
  para(`"${c.sharedQuestion}"`, { font: FONTS.italic });
  doc.moveDown(0.3);
  lines(3);

  heading("Dated sources");
  if (c.requirementEffective) para(`Requirement effective: ${c.requirementEffective.date ?? "not published"}. ${c.requirementEffective.basis}`, { size: 9 });
  if (c.sources.length === 0) para("No sources recorded in the ruleset.", { color: MUTED });
  for (const s of c.sources) bullet(`${s.title} (read ${s.retrievedOn}) ${s.url}${s.note ? `. ${s.note}` : ""}`);

  heading("Notes");
  lines(6);

  // Footer on every page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing inside the bottom margin would otherwise start a new page.
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 42;
    doc
      .moveTo(left, y - 6)
      .lineTo(left + width, y - 6)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
    doc
      .font(FONTS.regular)
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(`Aerowise call sheet · ${c.key} v${c.version} · ${c.statusLabel} · prepared ${c.generatedOn}, no contact made · page ${i - range.start + 1} of ${range.count}`, left, y, { width, lineBreak: false, height: 10 });
  }
  doc.end();
  return finished;
}
